## Available skills (cloud planner reference)

These are the read-only skills the local LLM can invoke. You don't
need to know their exact JSON argument schemas -- the orchestrator
injects the schemas when it forwards a step to the local LLM. Your
job: pick the right skills + provide semantic context for each call.

### source-introspection family

- **`code.source.repo.describe`** -- list top-level modules sorted
  by file count. Returns module paths + entity counts. Use when you
  don't yet know what modules exist.
  Context: nothing (uses session repo).

- **`code.source.module.describe`** -- summarise one module
  (filesystem directory). Returns files + entity ids + sub-modules.
  Context: the module's path or descriptive name (e.g. "the
  authentication module", or a workspace-relative path).

- **`code.source.file.describe`** -- enumerate entities + imports in
  one file. Returns language + entity ids + imports list.
  Context: the file path or descriptive locator (e.g. "the file
  containing the auth middleware" or a workspace-relative path).

- **`code.entity.locate-by-name`** -- find entities matching an exact
  name across kinds (class / function / method / ...). Returns
  matching entity ids.
  Context: the exact name + (optionally) which kinds to consider.

- **`code.entity.summary`** -- read one entity's typed metadata +
  body excerpt. Returns body + line range.
  Context: WHICH entity (by name or by description -- the local
  LLM will resolve the entityId from a prior locate-by-name /
  module.describe / file.describe in the same step).

- **`code.entity.callers`** -- entities that call the target via
  1-hop CALLS in-edges.
  Context: WHICH entity to ask "who calls X" about.

- **`code.entity.callees`** -- entities the target calls (1-hop
  CALLS out-edges). Use sparingly -- often the local LLM can derive
  this from `entity.summary` body without an extra call.
  Context: WHICH entity to walk outgoing edges from.

- **`code.entity.search-by-vector`** -- semantic search. Returns
  top-K entity ids by similarity to the query.
  Context: a free-form query when you don't know the exact name
  ("authentication middleware", "block-replication scheduler").

### Standard chains the local LLM follows

These chains drive how you should ORDER skills within a step:

**Chain A (name-known)**: locate-by-name -> summary (read body) ->
  callers (find users, optional)

**Chain B (module-down)**: repo.describe -> module.describe ->
  file.describe -> summary

When you build a step, structure it as one of these chains -- the
local LLM resolves entityIds across calls within the step (use
`dependsOn` in PlannedSkillCall to make the chaining explicit).

### Excluded from the catalog

- Synthesis / write skills -- not relevant to discovery.
- meta family (classify-question, select-scope) -- legacy
  scaffolding, not used in the discovery flow.
- Cross-owner skills (data.* etc.) -- code-analyzer scope only.
