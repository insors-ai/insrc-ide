# Agent core (stages 1-3)

Config + types + hash/IO helpers + agent skeleton + intent reroute.
Lands the complete end-to-end wiring with step stubs so subsequent
stages plug into a live agent.

## Stage 1 -- Config + types

### Files

| File | Change |
|---|---|
| `src/insrc/shared/types.ts` | Extend `AgentConfig` with `requirements?: { dir?: string; format?: 'html' \| 'md' }`. Extend `AgentProviderConfigs` with `requirements?: AgentStepConfig`. Add `Intent` already has `'requirements'` -- no change there. |
| `src/insrc/agent/config.ts` | Default values: `DEFAULT_CONFIG.requirements = { dir: 'requirements', format: 'html' }`. Add merge handling in `mergeConfig()` under `raw['requirements']`. |
| `src/insrc/agent/tasks/requirements/types.ts` | NEW. See shape below. |

### `agent/tasks/requirements/types.ts`

```typescript
import type { LLMProvider } from '../../../shared/types.js';

// ---------------------------------------------------------------------------
// Input (what the agent is handed at session start)
// ---------------------------------------------------------------------------

export interface RequirementsInput {
  /** User prompt (or continuation message for a sub-section). */
  message: string;
  /** Repo root -- used to resolve `requirements.dir`. */
  repoPath: string;
  /** If triggered via brainstorm handoff, the finalized brainstorm doc. */
  brainstormSpec?: string;
  /** When continuing a sub-section from a new chat. */
  continuation?: {
    parentId: string;   // REQ-XXXXXX
    subEpicId: string;  // REQ-XXXXXX
  };
}

// ---------------------------------------------------------------------------
// Persisted index (requirements/_index.json)
// ---------------------------------------------------------------------------

export type RequirementsFormat = 'html' | 'md';
export type DocKind = 'epic' | 'sub-epic';
export type DocStatus = 'draft' | 'ready' | 'in-progress' | 'done';

export interface IndexDoc {
  title: string;
  file: string;                 // relative to requirements/ dir
  parent: string | null;        // REQ-XXXXXX or null for root
  children: string[];           // REQ-XXXXXX[]
  kind: DocKind;
  status: DocStatus;
  created: string;              // ISO 8601
  updated: string;              // ISO 8601
  stories?: string[];           // STR-XXXXXXXXXXXX[], only for sub-epic
  gh?: {                        // populated after push
    issueNumber: number;
    projectItemId: string;
    projectId: string;
    repoOwner: string;
    repoName: string;
  };
}

export interface RequirementsIndex {
  version: 1;
  docs: Record<string, IndexDoc>;   // keyed by REQ-XXXXXX
  renames: Record<string, string>;  // oldId -> newId (title changes)
}

// ---------------------------------------------------------------------------
// Story model (in-memory; serialized into sub-epic doc)
// ---------------------------------------------------------------------------

export interface Story {
  id: string;        // STR-XXXXXXXXXXXX
  title: string;
  parentId: string;  // REQ-XXXXXX of the sub-epic it lives in
  userStory?: {
    persona: string;
    goal: string;
    outcome: string;
  };
  context?: string;
  scope?: { inScope: string[]; outOfScope: string[] };
  requirements?: {
    functional: string[];
    businessRules: string[];
  };
  userFlow?: string[];
  acceptanceCriteria?: string[];
  uiNotes?: string;
  dataApiNotes?: string;
  edgeCases?: string[];
  nonFunctional?: string[];  // feeds module-NFR consolidation
  dependencies?: {
    blockedBy: string[];   // STR-... or REQ-... or #NN (GH)
    requires: string[];
    related: string[];
  };
  testNotes?: string[];
  status: DocStatus;
}

// ---------------------------------------------------------------------------
// Agent state (checkpointed between steps)
// ---------------------------------------------------------------------------

export type ScopeClassification = 'standalone-feature' | 'extension' | 'broad';

export interface RequirementsState {
  input: RequirementsInput;
  scope: {
    classification: ScopeClassification;
    summary: string;            // short narrative
    existingEntities?: Array<{  // from knowledge-graph scope-analyze
      name: string;
      file: string;
      kind: string;
      score: number;
    }>;
  };
  subEpics: Array<{
    title: string;
    description: string;
    approved: boolean;
    dependsOn: string[];        // other sub-epic titles (pre-scaffold, no IDs yet)
  }>;
  mainDocId?: string;           // REQ-XXXXXX of the Main Epic once scaffold runs
  currentSubEpic?: {
    id: string;
    stories: Story[];
    completedStoryIds: string[];
    pendingNfrs: string[];      // raw NFR strings from story-detail-loop
  };
  consolidatedNfrs?: string[];
  pushPlan?: unknown;           // github-push.md defines this
}

// ---------------------------------------------------------------------------
// Gate payload shapes (rendered by the EditorPane)
// ---------------------------------------------------------------------------

export interface ListReviewItem {
  id: string;        // local id within the list; not the REQ/STR id
  title: string;
  description: string;
  approved?: boolean;
  feedback?: string;
}

export interface ListReviewGatePayload {
  kind: 'sub-epic-list' | 'story-list' | 'feature-list' | 'nfr-list' | 'reconciliation-plan';
  items: ListReviewItem[];
  bulkActions: Array<'approve-all' | 'reject-all' | 'regenerate'>;
}
```

### Verification

- `npx tsc -p src/insrc/tsconfig.json --noEmit` -- types compile.
- `npx tsc -p src/tsconfig.json --noEmit` -- workbench types still clean.
- Launch the daemon, verify `loadConfig()` returns
  `requirements.dir = 'requirements'`, `requirements.format = 'html'`
  when the field is absent from the config file.

## Stage 2 -- Hash + I/O helpers

### Files

| File | Purpose |
|---|---|
| `src/insrc/agent/tasks/requirements/ids.ts` | `reqId(title)`, `storyId(parentId, title)`, `normalizeTitle(title)` |
| `src/insrc/agent/tasks/requirements/io.ts` | `resolveRequirementsDir(cfg, repoPath)`, `readIndex(dir)`, `writeIndex(dir, index)`, `writeDoc(dir, doc, format)`, `docFilename(doc, format)` |
| `src/insrc/agent/tasks/requirements/templates.ts` | HTML + MD template strings for main / sub-epic / story |
| `src/insrc/agent/tasks/requirements/render.ts` | `renderMain(state, format)`, `renderSubEpic(state, format)`, `renderStory(story, format)` |

### `ids.ts` signatures

```typescript
import { createHash } from 'node:crypto';

export function normalizeTitle(title: string): string {
  return title.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** REQ-XXXXXX -- 6 hex chars of SHA-256(normalized title). */
export function reqId(title: string): string {
  return 'REQ-' + createHash('sha256')
    .update(normalizeTitle(title))
    .digest('hex')
    .slice(0, 6);
}

/** STR-XXXXXXXXXXXX -- 12 hex chars of SHA-256(parentId|title). */
export function storyId(parentId: string, title: string): string {
  return 'STR-' + createHash('sha256')
    .update(parentId + '|' + normalizeTitle(title))
    .digest('hex')
    .slice(0, 12);
}

export function kebab(title: string, max = 32): string {
  const slug = normalizeTitle(title).slice(0, max);
  return slug.endsWith('-') ? slug.slice(0, -1) : slug;
}
```

### `io.ts` signatures

```typescript
import type { AgentConfig } from '../../../shared/types.js';
import type { IndexDoc, RequirementsFormat, RequirementsIndex } from './types.js';

export function resolveRequirementsDir(cfg: AgentConfig, repoPath: string): string;

export function docFilename(doc: IndexDoc, format: RequirementsFormat): string;
//   `${id}-${kebab(title, 32)}.${format}`

export async function readIndex(dir: string): Promise<RequirementsIndex>;
//   returns empty index if _index.json missing

export async function writeIndex(dir: string, index: RequirementsIndex): Promise<void>;
//   atomic write: temp file + rename

export async function writeDoc(
  dir: string,
  doc: IndexDoc,
  content: string,
  format: RequirementsFormat,
): Promise<string>;
//   returns absolute path
//   atomic write
//   updates _index.json in lock-step: index write is a SEPARATE call
//   (caller is responsible for pairing)

export function collectIndex(index: RequirementsIndex): {
  epic: IndexDoc | null;
  subEpics: IndexDoc[];          // all docs with kind='sub-epic'
  byParent: Map<string, IndexDoc[]>;
};
```

### Templates note

Templates go in `templates.ts` as tagged-template functions
(`html\`...\``, `md\`...\``) that accept typed parameters and
produce the rendered content. Keep them simple -- string concatenation
is fine. The HTML template includes inline `<style>` so the rendered
doc is self-contained (business users may open it directly from a
file manager).

### Verification

- Unit-level smoke test (optional): import `reqId('Ingestion')` ->
  verify it returns a stable 10-char string beginning with `REQ-`.
- Call `writeDoc(tempDir, ...)` twice with same content -> idempotent,
  no error.

## Stage 3 -- Agent skeleton + intent reroute

### Files

| File | Change |
|---|---|
| `src/insrc/agent/tasks/requirements/agent.ts` | NEW. `requirementsAgent: AgentDefinition<RequirementsState>` with 9 step stubs. |
| `src/insrc/agent/tasks/requirements/steps.ts` | NEW. Step implementations; stubs log + advance in this stage. |
| `src/insrc/agent/tasks/requirements/agent-state.ts` | NEW. `RequirementsState` re-export + `initialState(input)` factory. |
| `src/insrc/agent/tasks/requirements/index.ts` | NEW. Export `requirementsAgent`, types, and a `runRequirementsAgent()` convenience similar to `runPairAgent`. |
| `src/insrc/agent/index.ts` | Reroute `requirements` intent from Designer to `requirementsAgent`. Remove the branch at lines 540-560 that calls `runDesignerAgent()` for `intent='requirements'`; add an equivalent branch calling `requirementsAgent`. |
| `src/insrc/agent/cli.ts` | Same reroute in the CLI handler. |
| `src/insrc/daemon/chat-handler.ts` | Confirm routing path still works (chat-handler doesn't special-case the intent; the framework runner picks up `requirementsAgent` when the decomposer routes to it). |

### Agent step map (stubs)

```typescript
// agent.ts
export const requirementsAgent: AgentDefinition<RequirementsState> = {
  id: 'requirements',
  version: 1,
  initialState,
  firstStep: 'scope-analyze',
  steps: {
    'scope-analyze':      scopeAnalyze,      // stage 5
    'breakdown-draft':    breakdownDraft,    // stage 5
    'breakdown-review':   breakdownReview,   // stage 5
    'breakdown-gate':     breakdownGate,     // stage 4 consumes; stage 5 produces
    'scaffold':           scaffold,          // stage 3 (here)
    'main-doc-author':    mainDocAuthor,     // stage 5
    'sub-section-plan':   subSectionPlan,    // stage 4 + stage 5
    'story-list-author':  storyListAuthor,   // stage 5
    'story-detail-loop':  storyDetailLoop,   // stage 5
    'nfr-consolidate':    nfrConsolidate,    // stage 5
    'offer-push':         offerPush,         // stage 7
    'delegate-push':      delegatePush,      // stage 7
  },
};
```

Stage-3 responsibility: wire up `scope-analyze` -> `breakdown-draft`
-> `breakdown-review` -> `breakdown-gate` -> `scaffold` -> `main-doc-
author` -> `sub-section-plan`, terminating at `sub-section-plan` with
`next: null`.

For this stage, the steps do the following minimal work so
end-to-end runs complete successfully:

- **`scope-analyze`**: classify everything as `standalone-feature`,
  no knowledge-graph query. Advance.
- **`breakdown-draft`**: produce a single dummy sub-epic
  `{ title: state.input.message, description: 'placeholder' }`.
  Advance.
- **`breakdown-review`**: no-op. Advance.
- **`breakdown-gate`**: auto-approve (no gate fired yet; stage 4 adds
  the gate via the EditorPane). Advance.
- **`scaffold`**: create the directory + Main Epic placeholder file +
  sub-epic placeholder files + `_index.json` using stage-2 helpers.
  This is real work; it's the skeleton that later stages build on.
- **`main-doc-author`**: write a minimal placeholder HTML to the Main
  Epic file. Advance.
- **`sub-section-plan`**: log the list of sub-epic IDs + titles; emit
  a `progress` message with the deep-link command per sub-epic.
  Terminate with `next: null`.

### Stage-3 commit sequence

1. Types + config defaults (stage 1 content).
2. Hash + IO helpers (stage 2).
3. Templates + render helpers (stage 2).
4. Agent skeleton + step stubs.
5. Intent reroute (index.ts + cli.ts) -- last commit in the stage, so
   the fork remains shippable at every point before this.

### Verification

1. `/intent requirements draft an API for user invites` -> agent runs
   end-to-end, creates `requirements/REQ-XXXXXX-draft-an-api-for-user-
   invites.html` + `_index.json`, reports the deep-link command for
   the single sub-epic, terminates cleanly.
2. Re-run same prompt -> hash matches existing doc -> no duplicate
   file.
3. `tsc` clean on both sides.
4. `git status` shows only the expected new files under
   `src/insrc/agent/tasks/requirements/` + two small edits to
   `agent/index.ts` + `agent/cli.ts` + shared types.
