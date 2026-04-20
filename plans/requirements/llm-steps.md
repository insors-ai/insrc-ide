# LLM steps (stage 5)

Wire actual LLM generation + cloud review for each of the 9 agent
steps. Every step that calls the LLM uses
`buildProvider({ provider, model }, cfg)` from `providers/factory.ts`,
never a direct provider constructor.

## Files

| File | Purpose |
|---|---|
| `src/insrc/agent/tasks/requirements/steps.ts` | Replace stubs with real implementations |
| `src/insrc/agent/tasks/requirements/prompts.ts` | System + user prompts per step |
| `src/insrc/agent/tasks/requirements/scope-graph.ts` | Knowledge-graph query helper for `scope-analyze` |
| `src/insrc/agent/tasks/requirements/nfr-consolidate.ts` | Dedup + merge logic for module NFRs |

## Step binding configuration

Per `AgentConfig.models.agents.requirements`:

```jsonc
{
  "scope-analyze":      { "provider": "anthropic", "model": "claude-sonnet-4-6" },
  "breakdown-draft":    { "provider": "local",     "model": "qwen3-coder:latest" },
  "breakdown-review":   { "provider": "anthropic", "model": "claude-sonnet-4-6" },
  "main-doc-draft":     { "provider": "local",     "model": "qwen3-coder:latest" },
  "main-doc-review":    { "provider": "anthropic", "model": "claude-sonnet-4-6" },
  "story-list-draft":   { "provider": "local",     "model": "qwen3-coder:latest" },
  "story-list-review":  { "provider": "anthropic", "model": "claude-sonnet-4-6" },
  "story-draft":        { "provider": "local",     "model": "qwen3-coder:latest" },
  "story-review":       { "provider": "anthropic", "model": "claude-sonnet-4-6" },
  "nfr-consolidate":    { "provider": "anthropic", "model": "claude-sonnet-4-6" }
}
```

These are defaults; users override via the Model Providers pane's
step-provider editor. Step binding resolved via
`ctx.providers.resolve('requirements', stepName)`.

## Step-by-step

### 5.1 `scope-analyze`

**Purpose**: classify scope; surface relevant existing-code context.

**Implementation**:

```typescript
async scopeAnalyze(ctx: StepContext, state: RequirementsState) {
  const provider = ctx.providers.resolve('requirements', 'scope-analyze');

  // 1. If brainstormSpec is present, seed classification from it
  //    rather than asking from cold.
  const seed = state.input.brainstormSpec
    ?? state.input.continuation
    ?? state.input.message;

  // 2. Knowledge-graph semantic query
  const queryEmbedding = await ctx.embedQuery(state.input.message);
  const relatedEntities = await searchEntities(queryEmbedding, {
    topK: 20,
    repos: state.input.repoPath ? [state.input.repoPath] : undefined,
  });

  // 3. LLM classification prompt (see prompts.ts)
  const resp = await provider.complete([
    { role: 'system', content: SCOPE_ANALYZE_SYSTEM },
    { role: 'user', content: buildScopeAnalyzeUser(seed, relatedEntities) },
  ], { maxTokens: 600, temperature: 0 });

  const parsed = parseScopeClassification(resp.text);

  return {
    state: {
      ...state,
      scope: {
        classification: parsed.classification,
        summary: parsed.summary,
        existingEntities: relatedEntities,
      },
    },
    next: parsed.classification === 'standalone-feature' ? 'main-doc-author' : 'breakdown-draft',
  };
}
```

**Prompt (SCOPE_ANALYZE_SYSTEM, abbreviated)**:

```
You are a requirements analyst. Given a user request and a list of
related code entities already indexed in the workspace, classify the
scope as ONE OF:

- standalone-feature: A single, focused capability. No breakdown needed.
  Example: "Build a caching layer."
- extension: Extends or integrates with existing code indexed in the
  workspace. Example: "Build new matching module" when a Contracts
  module already exists.
- broad: Too large for one document. Requires breaking into sub-epics.
  Example: "Write requirements for an Accounts Payable platform."

Output JSON:
{
  "classification": "...",
  "summary": "one paragraph summarizing scope",
  "extendsEntities": ["entityId1", ...],     // empty unless 'extension'
  "proposedDomains": ["Ingestion", ...]      // empty unless 'broad'
}
```

### 5.2 `breakdown-draft` + `breakdown-review`

**breakdown-draft (local)**:

```typescript
async breakdownDraft(ctx, state) {
  const provider = ctx.providers.resolve('requirements', 'breakdown-draft');
  const resp = await provider.complete([
    { role: 'system', content: BREAKDOWN_DRAFT_SYSTEM },
    { role: 'user', content: buildBreakdownUser(state.scope) },
  ], { maxTokens: 1200, temperature: 0.3 });

  const items = parseBreakdownItems(resp.text);
  return {
    state: { ...state, subEpics: items.map(i => ({ ...i, approved: false })) },
    next: 'breakdown-review',
  };
}
```

**Prompt (BREAKDOWN_DRAFT_SYSTEM)**:

```
You are a senior product analyst. Break the user's scope into 3-8
sub-epics that together cover the full capability.

Rules:
- Each sub-epic is a cohesive module (e.g., "Ingestion", "Extraction").
- Sub-epics are capabilities, NOT implementation steps (no
  "Set up the database").
- Order them by logical dependency (modules that produce data before
  modules that consume it).
- If the scope is an extension to existing code (see context), each
  sub-epic should name the existing module it extends.

Output a numbered list:
1. <title> -- <one-line description>. Depends on: <other titles or none>.
2. ...
```

**breakdown-review (cloud)**:

```typescript
async breakdownReview(ctx, state) {
  const provider = ctx.providers.resolve('requirements', 'breakdown-review');
  const resp = await provider.complete([
    { role: 'system', content: BREAKDOWN_REVIEW_SYSTEM },
    { role: 'user', content: buildReviewUser(state.subEpics, state.scope) },
  ], { maxTokens: 1500, temperature: 0.2 });

  const enhanced = parseBreakdownItems(resp.text);
  return {
    state: { ...state, subEpics: enhanced.map(i => ({ ...i, approved: false })) },
    next: 'breakdown-gate',
  };
}
```

**Prompt (BREAKDOWN_REVIEW_SYSTEM)**: critiques the draft for
completeness, overlap, missing domains; returns the same format
with corrections.

### 5.3 `breakdown-gate`

Produces a `ListReviewGatePayload` and fires the gate. The EditorPane
consumes it. Reply loop:

```typescript
async breakdownGate(ctx, state) {
  const reply = await ctx.gate({
    kind: 'list-review-requirements',
    title: 'Review sub-epic breakdown',
    content: `${state.subEpics.length} sub-epics proposed.`,
    context: {
      kind: 'sub-epic-list',
      items: state.subEpics.map((s, i) => ({
        id: String(i),
        title: s.title,
        description: s.description,
      })),
      bulkActions: ['approve-all', 'reject-all', 'regenerate'],
    },
    actions: [/* editor pane handles the actions */],
  });

  if (reply.bulk === 'regenerate') {
    return { state, next: 'breakdown-draft' };
  }

  const updated = state.subEpics.map((s, i) => {
    const itemReply = reply.items[i];
    return {
      ...s,
      title: itemReply.updatedTitle ?? s.title,
      description: itemReply.updatedDescription ?? s.description,
      approved: itemReply.decision === 'approve',
    };
  });

  if (!updated.some(s => s.approved)) {
    // All rejected. Regenerate with feedback.
    return { state: { ...state, subEpics: updated }, next: 'breakdown-draft' };
  }

  return {
    state: { ...state, subEpics: updated.filter(s => s.approved) },
    next: 'scaffold',
  };
}
```

### 5.4 `scaffold`

Covered in stage 3 (agent-core). Real work; no LLM call.

### 5.5 `main-doc-author`

Two-stage: local draft -> cloud review -> write to disk.

```typescript
async mainDocAuthor(ctx, state) {
  const drafter = ctx.providers.resolve('requirements', 'main-doc-draft');
  const reviewer = ctx.providers.resolve('requirements', 'main-doc-review');

  // Draft
  const draft = await drafter.complete([
    { role: 'system', content: MAIN_DOC_DRAFT_SYSTEM },
    { role: 'user', content: buildMainDocUser(state) },
  ], { maxTokens: 4000, temperature: 0.3 });

  // Review
  const reviewed = await reviewer.complete([
    { role: 'system', content: MAIN_DOC_REVIEW_SYSTEM },
    { role: 'user', content: buildReviewMainDoc(draft.text, state) },
  ], { maxTokens: 4000, temperature: 0.1 });

  // User gate (standard chat response gate; no EditorPane)
  const reply = await ctx.gate({
    title: 'Review Main Epic document',
    content: reviewed.text,
    actions: [
      { name: 'approve', label: 'Approve' },
      { name: 'edit', label: 'Edit...' },
      { name: 'regenerate', label: 'Regenerate' },
    ],
  });

  if (reply.action === 'regenerate') return { state, next: 'main-doc-author' };

  const finalContent = reply.action === 'edit' ? reply.feedback! : reviewed.text;
  await writeMainEpicDoc(state, finalContent);

  return { state, next: 'sub-section-plan' };
}
```

**Prompts**:

- `MAIN_DOC_DRAFT_SYSTEM`: generate the Main Epic doc following §8.1
  of the design doc. Overall Scope, Sub-sections table (with REQ IDs
  from `state.subEpics`), Personas, System NFRs, Open Items.
- `MAIN_DOC_REVIEW_SYSTEM`: check for missing personas, unrealistic
  NFRs, vague scope language, inconsistencies with sub-epic titles.

### 5.6 `sub-section-plan`

No LLM. Builds the handoff payload and terminates the session.
See `editor-pane.md` Mode 3 for the rendered UX. Terminates with
`next: null`.

### 5.7 `story-list-author`

Runs on continuation session (via the deep link from `sub-section-
plan`). Local draft -> cloud review -> list-review gate.

Prompts emphasize that stories are **functional capabilities only**
(not implementation steps, not UI screens). Format:

```
Output a numbered list of 3-10 stories for this sub-epic:
1. <action-oriented title> -- <one-line user-facing benefit>
2. ...
```

Gate payload: `kind: 'story-list'`. Same EditorPane list-review mode.

### 5.8 `story-detail-loop`

For each approved story title, generate the full 12-section story
doc (see design doc §8.3). Chat-view gate per story:

```typescript
async storyDetailLoop(ctx, state) {
  const stories = state.currentSubEpic!.stories;
  for (let i = state.currentSubEpic!.completedStoryIds.length; i < stories.length; i++) {
    const story = stories[i];

    // Draft
    const drafted = await draft(story);
    // Review
    const reviewed = await review(drafted);

    const reply = await ctx.gate({
      title: `Review: ${story.title}`,
      content: reviewed,  // full 12-section story
      actions: [
        { name: 'approve', label: 'Approve' },
        { name: 'edit', label: 'Edit' },
        { name: 'regenerate', label: 'Regenerate' },
      ],
    });

    if (reply.action === 'regenerate') { i--; continue; }
    const finalStory = reply.action === 'edit' ? parseStoryFromMd(reply.feedback!) : parseStoryFromMd(reviewed);

    // Harvest NFRs from section 10
    if (finalStory.nonFunctional?.length) {
      state.currentSubEpic!.pendingNfrs.push(...finalStory.nonFunctional);
    }

    state.currentSubEpic!.completedStoryIds.push(finalStory.id);
    // Persist partial progress (writeSubEpicDoc handles append)
    await writeSubEpicDoc(state.currentSubEpic!, ctx.config);
  }

  return { state, next: 'nfr-consolidate' };
}
```

The loop is resumable: `completedStoryIds` is part of the checkpointed
state, so a crash mid-loop continues at the next story.

### 5.9 `nfr-consolidate`

Takes `state.currentSubEpic.pendingNfrs` (raw bullet points harvested
from each story's section 10) and produces a deduplicated,
merged set organized by category (performance, security, audit,
accessibility, etc.).

```typescript
async nfrConsolidate(ctx, state) {
  const provider = ctx.providers.resolve('requirements', 'nfr-consolidate');
  const resp = await provider.complete([
    { role: 'system', content: NFR_CONSOLIDATE_SYSTEM },
    { role: 'user', content: buildNfrConsolidateUser(state.currentSubEpic!.pendingNfrs) },
  ], { maxTokens: 2000, temperature: 0 });

  // List-review gate: user approves consolidated NFR set
  const consolidated = parseNfrItems(resp.text);
  const reply = await ctx.gate({
    kind: 'list-review-requirements',
    title: 'Review consolidated module NFRs',
    context: {
      kind: 'nfr-list',
      items: consolidated.map((c, i) => ({
        id: String(i),
        title: c.category,
        description: c.statement,
      })),
      bulkActions: ['approve-all', 'regenerate'],
    },
    actions: [],
  });

  // Write final NFRs into the sub-epic doc's "Module NFRs" section
  const approved = reply.items
    .filter(i => i.decision === 'approve')
    .map(i => ({ category: i.updatedTitle ?? i.title, statement: i.updatedDescription ?? i.description }));

  state.consolidatedNfrs = approved.map(a => `**${a.category}**: ${a.statement}`);
  await writeSubEpicDoc(state.currentSubEpic!, ctx.config);

  return { state, next: 'offer-push' };
}
```

**NFR_CONSOLIDATE_SYSTEM prompt**:

```
You are a systems architect. Given a list of non-functional notes
collected from N individual user stories in a sub-epic, produce a
deduplicated, categorized module-level NFR set.

Rules:
- Merge duplicates (same intent in different words).
- Keep story-specific NFRs only if they generalize to the sub-epic.
- Categorize: Performance, Security, Privacy, Audit, Accessibility,
  Availability, Observability, Data retention, Compliance.
- For each category present, emit one statement.

Output list format:
- <Category>: <one-sentence statement>
```

### 5.10 `offer-push`

Covered in `github-push.md` (stage 7). Stage 5 commits end with this
step gated behind a feature flag -- the `offer-push` gate reads
"GitHub push not yet implemented" and terminates until stage 7 lands.

## Knowledge-graph scope analysis (`scope-graph.ts`)

```typescript
import { searchEntities } from '../../../db/search.js';  // via daemon RPC

export async function queryScopeContext(
  ctx: StepContext,
  message: string,
  opts: { topK?: number; repos?: string[] } = {},
): Promise<Array<{ name: string; file: string; kind: string; score: number }>> {
  const topK = opts.topK ?? 20;
  const queryEmbedding = await ctx.embedQuery(message);
  // daemon RPC: 'search.entities'
  const results = await ctx.rpc('search.entities', {
    vector: queryEmbedding,
    topK,
    repos: opts.repos,
  });
  if (!results) return [];
  return (results as Array<{name: string; file: string; kind: string; score: number}>)
    .filter(r => r.score > 0.3);  // relevance floor
}
```

The daemon already exposes entity search; no new RPC needed.

## Output parsing helpers (`prompts.ts`)

Helpers to parse LLM output that's expected to be structured:

- `parseBreakdownItems(text)` -- numbered list -> `{ title, description, dependsOn }[]`.
- `parseScopeClassification(text)` -- JSON block.
- `parseStoryFromMd(text)` -- 12-section MD doc -> `Story` object.
- `parseNfrItems(text)` -- categorized list -> `{ category, statement }[]`.

All parsers tolerate minor format drift (extra whitespace, missing
bullets) by using regex matchers, not strict grammars. On parse
failure, the step logs the raw response and gates the user to
approve the raw text as-is or regenerate.

## Commit boundary for stage 5

1. `prompts.ts` with all system prompts + parsers.
2. `scope-graph.ts` helper.
3. `scope-analyze` + `breakdown-draft` + `breakdown-review` +
   `breakdown-gate`.
4. `main-doc-author`.
5. `story-list-author`.
6. `story-detail-loop`.
7. `nfr-consolidate` + `nfr-consolidate.ts`.
8. `offer-push` placeholder (gated behind "not implemented" notice).

## Verification

- Run the agent with `/intent requirements Write requirements for an
  Accounts Payable platform`. Expect: scope classified as `broad`,
  breakdown lists ~5 sub-epics (Ingestion, Classification, etc.),
  EditorPane opens for approval, main doc writes after approval,
  sub-section plan lists sub-epics with Start-chat buttons.
- Continue from one sub-epic via the Start-chat button. Expect:
  story-list-author produces 3-8 stories, EditorPane opens, approve,
  story-detail-loop runs through each story (chat-view gates),
  `nfr-consolidate` fires, `offer-push` placeholder terminates.
- Inspect `requirements/_index.json` -> matches the tree rendered
  in the pane's tree-browse mode.
- Check the written docs open cleanly in the browser (HTML) or
  render as markdown (MD mode, if configured).
