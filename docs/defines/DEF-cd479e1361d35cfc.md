# Epic: Users cannot pin model choices (embedding, shaper, core) per repo today; every choice comes from the single global ~/.insrc/config.json file [[c1]].

**Flavor:** enhancement

## Problem

Users cannot pin model choices (embedding, shaper, core) per repo today; every choice comes from the single global ~/.insrc/config.json file [[c1]]. Switching between repos with different embedding needs (GPU-rich Ollama vs. CPU-only ONNX vs. cloud CLI-only) forces hand-editing the global config and wiping the vector store on every switch, and two repos on the same machine can never disagree about which model they want. The friction blocks anyone with multiple projects from using insrc across all of them without conscious model-choice bookkeeping.

## Non-goals

- **Team-level or org-level shared config sync.** — Users manage their own machines today; adding remote sync would introduce a wholly different failure mode (network / auth / merge) beyond the scope of a per-repo override.
- **Runtime hot-swap of a changed embedding model without a re-index.** — Changing embedding model requires wiping Lance and re-embedding to avoid dim-mismatch; the daemon-startup docs already reflect this and no user has asked for hot-swap.
- **Extending the per-repo override to config dimensions beyond model choices (logging levels, routing modes, permission gates, etc.).** — The ask is explicitly scoped to model choices. A broader per-repo scope would multiply the surface without a concrete user need.

## Assumptions

- `high` The insrc/config module is the correct owning site for the new per-repo dimension; no other module currently reads model config. [[c1]]
- `high` Users accept that changing the embedding model for a repo requires wiping that repo's Lance store and re-indexing (the same trade-off the global path already carries). [[c1]]
- `med` The three model dimensions in LocalProviderInfraConfig (embeddingModel, coreModel) plus the shaper dimension in AnalyzeShaperConfig cover the full override surface today. [[c2]]

## Constraints

| ID | Type | Text | Source |
| :--- | :--- | :--- | :--- |
| `k1` | convention | Any new code in insrc/config MUST follow the module's existing conventions: camelCase functions, PascalCase classes, snake_case filenames, *.test test files. | [[c3]] |
| `k2` | invariant | The global ~/.insrc/config.json MUST remain the fallback when a repo has no override; existing single-repo installs continue to work without any change. | [[c1]] |
| `k3` | contract | The overridable dimensions MUST be exactly the model dimensions already exposed by the global surface: embeddingModel, embeddingDim, coreModel, shaperModel. Adding other config dimensions is out of scope (non-goal). | [[c2]] |
| `k4` | convention | CLI commands MUST live inside the existing insrc CLI command tree (same commander framework the current daemon / repo / setup / workflow commands use); no new binary. | [[c1]] |
| `k5` | invariant | The runtime programmatic override entry point already used by callers (ShaperProviderOverrides in src/insrc/analyze/context/shaper-provider.ts) MUST continue to work; per-repo config becomes a new SOURCE of overrides, not a replacement of the runtime API. | [[c4]] |

## Stories

### s1: As a user of multiple repos, I can rely on the daemon serving the effective model choices for each repo, honouring per-repo overrides over the global default

**User value:** `size: M`

When I work across repos with different needs — a heavy Ollama box for one, an ONNX-only laptop for another, a Claude-CLI-only cloud VM for a third — each repo runs with the models I picked for it, without me hand-editing the global config or wiping state on every switch. The daemon reads the per-repo override at repo scope and applies the correct models automatically.

**Extends:** [[c1]] [[c2]] [[c4]]

**Acceptance criteria:**

- **ac1:** Given a repo has no per-repo override, when the daemon serves an embed, shape, or core operation on that repo, then it uses the global ~/.insrc/config.json model choices, exactly as it does today. _(operationalizes `k2`)_
- **ac2:** Given a repo has a per-repo override for the embedding model, when the daemon indexes or queries that repo, then it uses the overridden embedding model and dimension, not the global values. _(operationalizes `k3`)_
- **ac3:** Given a repo has a per-repo embedding override whose dimension conflicts with what the repo's vector store already persisted, when the daemon boots serving that repo, then it surfaces a clear error naming the required cleanup step (same recovery path already documented for ONNX-vs-Ollama dim mismatch on the global path). _(operationalizes `k2`, `k3`)_
- **ac4:** Given callers use the existing programmatic override entry point today, when per-repo config overrides are added, then the programmatic entry point continues to work unchanged and per-repo config is layered as an additional source, not a replacement. _(operationalizes `k5`)_

### s2: As a user, I can set a per-repo model override from the command line so my choice persists without editing global files

**User value:** `size: S`

I don't have to hand-edit ~/.insrc/config.json or wipe state to pin a model choice for a repo. One command sets the override and the next daemon read picks it up.

**Depends on:** `s1`

**Extends:** [[c1]]

**Acceptance criteria:**

- **ac1:** Given a repo is registered with insrc, when I run the CLI to set an override for one of the covered model dimensions on that repo, then the override is persisted and the next daemon read of that repo's config picks up the new value. _(operationalizes `k3`, `k4`)_
- **ac2:** Given a per-repo override already exists for a dimension, when I run the CLI to set a new value on the same dimension, then the previous value is replaced and only the new value takes effect on the next read. _(operationalizes `k4`)_
- **ac3:** Given I ask the CLI to set an override for a repo that is not registered with insrc, when the command runs, then it exits with a clear error naming the missing repo and does not create any override entry. _(operationalizes `k4`)_

### s3: As a user, I can list the per-repo overrides active on a repo so I know which model choices are being used

**User value:** `size: S`

Before I run an index or a query I want a fast way to confirm whether a repo is using the global config or an override, and if it is, what value it holds.

**Depends on:** `s1`

**Extends:** [[c1]]

**Acceptance criteria:**

- **ac1:** Given a repo has one or more per-repo overrides set, when I run the CLI to list overrides on that repo, then each active override is shown with its dimension name and the current value. _(operationalizes `k3`)_
- **ac2:** Given a repo has no per-repo overrides, when I run the CLI to list overrides on that repo, then the output states explicitly that no overrides are set and the repo will use the global config. _(operationalizes `k2`)_

### s4: As a user, I can unset a per-repo model override so the repo falls back to the global config without touching the global file

**User value:** `size: S`

When my needs for a repo change and I want to return to the global default for a dimension, I clear the override for that dimension only — without editing global config and without disturbing overrides on other dimensions.

**Depends on:** `s1`

**Extends:** [[c1]]

**Acceptance criteria:**

- **ac1:** Given a repo has per-repo overrides set for multiple dimensions, when I run the CLI to unset an override on one specific dimension, then only that dimension's override is removed and the others remain in effect. _(operationalizes `k4`)_
- **ac2:** Given all per-repo overrides for a repo have been cleared, when the daemon next reads that repo's config, then it uses the global ~/.insrc/config.json values, exactly as it did before any override was ever set. _(operationalizes `k2`)_
- **ac3:** Given the user asks to unset an override that is not currently set on the repo, when the command runs, then it succeeds as a no-op with a clear message saying nothing was set for that dimension. _(operationalizes `k4`)_

## Citations

- **[[c1]]** `analyze-bundle` `capability-discovery: does the codebase already support per-repo config overrides for model choices (embedding, shaper, core), or is config global only?` — "No module in the codebase currently delivers per-repo config overrides. src/insrc/config (partial-match) owns the config surface but none reads a per-repo scope."
- **[[c2]]** `code` `/Users/subhagho/work/projects/insors/insrc-ide/src/insrc/config/local.ts:LocalProviderInfraConfig` — "LocalProviderInfraConfig entity exposes host, embeddingModel, embeddingDim, coreModel."
- **[[c3]]** `convention` `convention.detect on /Users/subhagho/work/projects/insors/insrc-ide/src/insrc/config` — "namingSchema: functions=camelCase, classes=PascalCase, files=snake_case, testFiles=*.test."
- **[[c4]]** `code` `/Users/subhagho/work/projects/insors/insrc-ide/src/insrc/analyze/context/shaper-provider.ts:ShaperProviderOverrides` — "ShaperProviderOverrides entity: programmatic (in-code) override mechanism used by analyze callers to substitute a shaper provider at runtime."
