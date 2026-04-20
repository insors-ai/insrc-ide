# GitHub push (stage 7)

Schema reconciliation + issue creation + project population.
Delegate-agent-driven; runs against the user's target GitHub project
and never overwrites existing configuration.

## Scope

- **New gh tools** (7) for creating / updating schema objects.
- **Reconciliation step** in the requirements agent (`offer-push` ->
  `reconcile-schema` -> `delegate-push`).
- **Delegate plan** generator converting the reconciled schema +
  requirements tree into a linear plan the Delegate agent runs.
- **`_index.json` round-trip** so repeat pushes don't duplicate
  issues or re-create project items.

## New gh tools

Each is a separate module file under
`src/insrc/daemon/tools/builtins/gh/` and registered in the `index.ts`
map. Each has approval gating (see the existing `gh:issue:create`
pattern for the template) since they're mutation-class.

| Tool | Module | GitHub API | Purpose |
|---|---|---|---|
| `gh:label:create` | `label-create.ts` | REST `POST /repos/{owner}/{repo}/labels` | Create one label |
| `gh:milestone:create` | `milestone-create.ts` | REST `POST /repos/{owner}/{repo}/milestones` | Create a milestone |
| `gh:project:create` | `project-create.ts` | GraphQL `createProjectV2` | Create a project (requires org / owner node id) |
| `gh:project:field-create` | `project-field-create.ts` | GraphQL `createProjectV2Field` | Create a single-select / text / number / iteration field |
| `gh:project:field-update` | `project-field-update.ts` | GraphQL `updateProjectV2Field` or option-additions through `createProjectV2FieldOption` (if separate) | Add options to existing single-select without replacing |
| `gh:project:view-list` | `project-view-list.ts` | GraphQL `projectV2.views` | List saved views |
| `gh:project:view-create` | `project-view-create.ts` | GraphQL `createProjectV2View` + filter/sort/group mutations | Create a saved view with filter + grouping |

**All use the existing `gh` OAuth flow**; no auth changes needed.
Approval gate text follows the existing convention: describes the
action, lists the repo / project, waits for user approval before
the HTTP call.

### Reuse existing tools

| Tool | Use |
|---|---|
| `gh:project:list` | Find the target project by title or org+name |
| `gh:project:field-list` | Snapshot current schema |
| `gh:label:list` | Snapshot current labels |
| `gh:milestone:list` | Snapshot current milestones |
| `gh:issue:create` | Create issues (labels + milestone in one call) |
| `gh:issue:edit` | Patch parent bodies with child task-lists |
| `gh:project:item-add` | Add issue to project |
| `gh:project:item-update` | Set custom field values |

## Agent-side additions

### `agent/tasks/requirements/steps.ts`

```typescript
async offerPush(ctx, state) {
  const reply = await ctx.gate({
    title: 'Push to GitHub?',
    content: `${epicCount} Epic, ${subEpicCount} Sub-epics, ${storyCount} Stories ready. Push to GitHub Issues + Projects v2?`,
    actions: [
      { name: 'push', label: 'Push now' },
      { name: 'later', label: 'Not now' },
      { name: 'config', label: 'Configure target...' },
    ],
  });

  if (reply.action === 'later') return { state, next: null };

  const pushConfig = reply.action === 'config'
    ? await pickPushTarget(ctx, state)   // prompts for repo + project + labels prefix
    : await defaultPushTarget(ctx, state);  // reads git remote + uses defaults

  return { state: { ...state, pushConfig }, next: 'reconcile-schema' };
}

async reconcileSchema(ctx, state) {
  const snap = await snapshotProjectSchema(ctx, state.pushConfig!);
  const plan = computeReconciliationPlan(snap, state);

  if (plan.additions.length === 0 && plan.extensions.length === 0) {
    // Nothing to reconcile
    return { state: { ...state, reconciliationPlan: plan }, next: 'delegate-push' };
  }

  // EditorPane list-review gate
  const reply = await ctx.gate({
    kind: 'list-review-requirements',
    title: 'Reconcile GitHub project schema',
    content: `${plan.additions.length} additions and ${plan.extensions.length} extensions proposed.`,
    context: {
      kind: 'reconciliation-plan',
      items: plan.toListReviewItems(),
      bulkActions: ['approve-all', 'reject-all', 'apply'],
    },
    actions: [],
  });

  const approvedPlan = plan.applyUserDecisions(reply);
  return { state: { ...state, reconciliationPlan: approvedPlan }, next: 'delegate-push' };
}

async delegatePush(ctx, state) {
  const plan = buildDelegatePlan(state);  // see below
  const delegateResult = await runDelegate(ctx, plan);

  // Update _index.json with gh info per doc
  await persistGhMappings(state, delegateResult);

  return { state, next: null };
}
```

### Reconciliation plan shape (`reconcile.ts`)

```typescript
export interface ProjectSnapshot {
  projectExists: boolean;
  projectId?: string;
  fields: Array<{ name: string; kind: 'text' | 'single-select' | 'iteration' | 'number' | 'date'; options?: string[] }>;
  views: string[];  // view names
  labels: string[];
  milestones: string[];
}

export interface ReconciliationAction {
  id: string;            // unique for the gate
  kind: 'create-project' | 'create-field' | 'extend-field' | 'create-view' | 'create-label' | 'create-milestone';
  description: string;   // human-readable for the gate
  payload: Record<string, unknown>;
  defaultApproved: boolean;  // true for adds, false for extensions-to-existing
}

export interface ReconciliationPlan {
  additions: ReconciliationAction[];
  extensions: ReconciliationAction[];  // touches existing config; defaults unchecked

  toListReviewItems(): ListReviewItem[];
  applyUserDecisions(reply: ListReviewGateReply): ApprovedPlan;
}

export interface ApprovedPlan {
  actions: ReconciliationAction[];  // only the approved ones, in execution order
}
```

`computeReconciliationPlan(snap, state)`:

1. **Project existence**: if `!snap.projectExists`, add
   `create-project` action (default-approved).
2. **Required fields**: for each of Kind, Parent, Status, Priority,
   Size, Iteration, Domain, InsrcReqId:
   - If missing, add `create-field` (default-approved).
   - If present but has a different type, log a conflict and skip
     (user reconciles manually).
   - If present as single-select with missing required options, add
     `extend-field` (default-UNchecked so user must opt in).
3. **Required views**: for each of Epic Roadmap, Story Backlog,
   Sprint Board, Dependencies, Needs Grooming, if missing, add
   `create-view` (default-approved).
4. **Labels**: for each required label (`type:epic`, `type:sub-epic`,
   `type:story`, `source:insrc`, per-domain), if missing, add
   `create-label` (default-approved).
5. **Milestone**: one per Main Epic title that doesn't already exist,
   add `create-milestone` (default-approved).

`applyUserDecisions(reply)` returns an `ApprovedPlan` with only the
actions the user approved.

### Delegate plan generator (`build-delegate-plan.ts`)

```typescript
export function buildDelegatePlan(state: RequirementsState): DelegatePlan {
  return {
    title: `Push ${state.mainDocId} to GitHub`,
    commitStrategy: 'none',
    steps: [
      // Phase A -- apply reconciliation
      ...state.reconciliationPlan!.actions.map(a => ({
        title: a.description,
        kind: 'tool' as const,
        toolId: toolIdForAction(a),
        input: a.payload,
      })),

      // Phase B -- create issues in dependency order (Epic first,
      // then sub-epics, then stories), capturing issue numbers in
      // a context map between steps.
      {
        title: 'Create Main Epic issue',
        kind: 'tool',
        toolId: 'gh:issue:create',
        input: buildIssueInput(state, state.mainDocId),
        captureOutput: 'mainEpicIssueNumber',
      },
      ...state.subEpics.map(sub => ({
        title: `Create Sub-epic: ${sub.title}`,
        kind: 'tool',
        toolId: 'gh:issue:create',
        input: buildIssueInput(state, reqIdFromTitle(sub.title), { parentNumber: '$mainEpicIssueNumber' }),
        captureOutput: `subEpic_${reqIdFromTitle(sub.title)}`,
      })),
      ...allStories(state).map(story => ({
        title: `Create Story: ${story.title}`,
        kind: 'tool',
        toolId: 'gh:issue:create',
        input: buildStoryIssueInput(state, story),
        captureOutput: `story_${story.id}`,
      })),

      // Phase B continued -- patch parent bodies
      {
        title: 'Patch Main Epic body with sub-epic task-list',
        kind: 'tool',
        toolId: 'gh:issue:edit',
        input: buildPatchedMainEpicBody(state),
      },
      ...state.subEpics.map(sub => ({
        title: `Patch Sub-epic body: ${sub.title}`,
        kind: 'tool',
        toolId: 'gh:issue:edit',
        input: buildPatchedSubEpicBody(state, sub),
      })),

      // Phase B continued -- add to project
      ...allIssues(state).map(issue => ({
        title: `Add ${issue.title} to project`,
        kind: 'tool',
        toolId: 'gh:project:item-add',
        input: { projectId: state.pushConfig!.projectId, issueNumber: issue.number },
        captureOutput: `projectItem_${issue.id}`,
      })),
      ...allIssues(state).map(issue => ({
        title: `Set fields on ${issue.title}`,
        kind: 'tool',
        toolId: 'gh:project:item-update',
        input: buildProjectFieldValues(state, issue),
      })),
    ],
  };
}
```

The `captureOutput` mechanism isn't currently in the Delegate agent
protocol. **This is the additional change to Delegate**: support a
per-step `captureOutput` key that stores the tool's result under
`state.context[captureOutput]`. Subsequent steps can interpolate
`$varname` in their input. If `captureOutput` integration is too
invasive, fall back to a post-step hook that reads the tool result
and stores it in the state -- same effect, different shape.

### Parent/child body mechanics

Main Epic body ends with:

```
## Sub-epics
- [ ] #<sub-epic-1-issue> <sub-epic-1-title>
- [ ] #<sub-epic-2-issue> <sub-epic-2-title>
```

Sub-epic body similarly task-lists stories. Both bodies are patched
AFTER all children are created, so the issue numbers resolve. The
Delegate plan's ordering ensures this -- the "Patch" steps come
after all "Create" steps.

Child issue body begins with:

```
Parent: #<parent-issue-number>

... [full doc content] ...

## Dependencies
- Blocked by #<other-issue>
- Requires #<other-issue>
```

Dependency resolution: the requirements agent collects STR-based refs
from story.dependencies and translates them to issue numbers using
the `captureOutput` map before writing the bodies. If any referenced
story hasn't been pushed yet (cross-sub-epic dependency), leave it
as `STR-XXXX` and let the user patch manually post-push.

## `_index.json` round-trip

After push, each doc entry in `_index.json` gains:

```jsonc
{
  "REQ-ab12cd": {
    ...,
    "gh": {
      "issueNumber": 100,
      "projectItemId": "PVTI_xxx",
      "projectId": "PVT_xxx",
      "repoOwner": "acme",
      "repoName": "ap-platform"
    }
  }
}
```

Stories (which don't have their own REQ entries) are tracked
similarly in each sub-epic's `gh.stories` map:

```jsonc
{
  "REQ-def345": {
    ...,
    "stories": ["STR-11223344abcd", ...],
    "gh": { ... epic info ... },
    "ghStories": {
      "STR-11223344abcd": { "issueNumber": 110, "projectItemId": "PVTI_yyy" }
    }
  }
}
```

Re-running the push:

- Reconciliation sees the project + fields + labels already exist -> no
  additions proposed -> user skips Phase A with no-op.
- For each doc with an existing `gh.issueNumber`, skip
  `gh:issue:create`; use `gh:issue:edit` instead to update the body
  with any changes. (Delegate plan differentiates based on presence
  of `gh` block.)
- New stories added since last push are detected by the absence of a
  `ghStories[STR-xxxxx]` entry -> created + added to project as
  usual.

## Verification

**Fresh project test**:

1. New GitHub repo, no project yet. Run requirements agent through
   to `offer-push`.
2. Click "Push now". Reconciliation proposes: create project, create
   8 fields, create 5 views, create ~6 labels, create 1 milestone.
3. Approve all. Delegate runs through the plan with per-step approval
   gates (existing Delegate behavior) -- bulk-approve via "approve
   all remaining" action.
4. Verify on GitHub: project exists, all fields present, views
   present, issues created with correct labels + milestone, parent
   bodies have task-lists, project items have field values set.
5. `_index.json` has `gh` blocks on every doc + `ghStories` entries.

**Existing-project test**:

1. Same repo, re-run push after adding 2 new stories.
2. Reconciliation detects nothing needs adding -> proceeds directly
   to Phase B.
3. Delegate plan contains issue-create steps ONLY for the 2 new
   stories. Existing issues get `gh:issue:edit` calls that preserve
   user-made edits (the edit body includes `<!-- insrc:managed -->`
   tags around the agent-managed sections; diffs outside those tags
   are preserved).

**Partial-approval test**:

1. Fresh project, reconciliation proposes 8 field additions.
2. User approves 5, rejects 3.
3. Phase B runs: issues created, project items added, item-update
   calls only set the 5 approved fields.
4. Final report lists the 3 deferred field creations, user can run
   push again later to complete.

## Commit boundary for stage 7

1. `gh:label:create` tool + tests.
2. `gh:milestone:create` tool.
3. `gh:project:create` tool.
4. `gh:project:field-create` tool.
5. `gh:project:field-update` tool (option additions).
6. `gh:project:view-list` + `gh:project:view-create` tools.
7. `reconcile.ts` + `computeReconciliationPlan`.
8. `buildDelegatePlan` + `build-delegate-plan.ts`.
9. Delegate agent gains `captureOutput` support on plan steps.
10. Requirements `offerPush` + `reconcileSchema` + `delegatePush`
    steps.
11. `_index.json` round-trip persistence.

## Open considerations

- **Rate limiting**: GitHub's REST API has 5000 req/hour authenticated.
  A large push (say, 100 stories) could make ~300 API calls across
  create / edit / item-add / item-update. Well under limit, but the
  Delegate orchestration should back off on 429 responses. The
  existing `runToolLoop` has retry logic; confirm it handles 429.
- **Partial-failure recovery**: if Delegate crashes mid-push,
  `_index.json` is partially written. On next push, the reconciler
  sees some docs have `gh` blocks and others don't; proceeds from
  where it left off. The checkpointing in the Delegate framework
  already handles this.
- **Issue body markers**: use HTML comment markers
  `<!-- insrc:managed-start -->` / `<!-- insrc:managed-end -->`
  around the agent-managed content so re-pushes can replace just the
  managed section and preserve user edits outside it.
