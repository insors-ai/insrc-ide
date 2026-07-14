# LLD: s2

**Epic:** `support-per-repo-config-overrides-embedding`
**HLD base run:** `wf-1783920776460-bd44gr`
**HLD effective hash:** `ff7482e7beb3...`

## HLD context

**Framework:** A layered config resolver in src/insrc/config reads the existing global loader first and overlays a per-repo override file (JSON) at ~/.insrc/repos/<slug>/config.json when present [[c1]]. All 15 config read sites (daemon boot, indexer, embedder, seven Lance stores, and tests) migrate to a repo-aware loader; the CLI reads / writes / deletes dimensions inside the same override file. No LMDB migration and no repo-tree writes; the global config's schema is unchanged and overrides are hand-editable JSON.
**Rollout phase:** Phase B -- CLI CRUD for overrides
**Consumes:** `sc1` (PerRepoOverrideFile)

## Contract details

**Surface level:** public

### `registerConfigCommands`

```typescript
function registerConfigCommands(program: Command): void
```

**Parameters:**
- `program: Command` — The root commander instance the CLI mounts every subcommand family on. Same handle passed to registerDaemonCommands / registerRepoCommands / registerWorkflowCommands [[c1]].

**Returns:** `void` — Side-effect only — mounts the `config` command family (including the `set` subcommand) on the passed-in program.

**Preconditions:**
- commander's Command class is imported from the same version currently used by the other register*Commands functions.

**Postconditions:**
- `insrc config set <dimension> <value> [--repo <path>]` is a valid CLI invocation.
- The commander root exposes the new command family alongside daemon / repo / setup / workflow.

## Data model changes

### `src/insrc/cli/commands/config.ts` — new

New file mounting the `config` command family. Exports registerConfigCommands(program: Command): void following the surrounding sibling convention (registerDaemonCommands, registerRepoCommands, registerWorkflowCommands) [[c1]]. File name is snake_case per the src/insrc/cli/commands convention (config.ts). The file's action handler for `set` calls listRepos [[c3]] to satisfy ac3 and writeAtomic [[c2]] to perform the durable write. No new class or subsystem is introduced; this is a leaf CLI-command file.

**Call sites:**
- `src/insrc/cli/commands/daemon.ts`
- `src/insrc/cli/commands/repo.ts`
- `src/insrc/cli/commands/workflow.ts`
- `src/insrc/cli/index.ts`

### `insrc CLI root` — invariant-change

The CLI root gains a new `config` command family via a one-line addition in the CLI's index (mirroring the existing `program.addCommand(...)` or `register*Commands(program)` calls). No behavior change to daemon / repo / setup / workflow subcommands; they continue to work exactly as today [[c1]].

**Call sites:**
- `src/insrc/cli/index.ts`

## Interaction with shared contracts

| Contract | Role | How |
| :--- | :--- | :--- |
| `sc1` | consumes | This Story CONSUMES sc1. It implements the write side for the set operation: (1) computes the file path per sc1's path convention `~/.insrc/repos/<slug>/config.json` via the same repo-registry slug helper s1 uses on the read side (ensuring the CLI writes to exactly where the daemon reads); (2) validates the CLI's <dimension> positional against sc1's four allowed keys (embeddingModel, embeddingDim, coreModel, shaperModel) and refuses anything else with a message enumerating the allowed set; (3) coerces the <value> positional to the correct type per sc1's type contract (Number(value) for embeddingDim with an integer sanity check, string-verbatim for the three model names); (4) reads the current on-disk JSON (or seeds an empty object when the file does not exist), sets the one dimension in-memory, and writes the whole object atomically via writeAtomic [[c2]]. sc1's on-disk shape does not change under this Story — only the write code is added. s1 reads what s2 writes, byte-for-byte; s3 (list) reads it; s4 (unset) writes the reduced form. |

## Error paths

### Error cases

- **The user passes a <dimension> positional that is not one of sc1's four allowed keys.** (recoverable)
  - Detection: The action handler checks the positional string against the hardcoded set { embeddingModel, embeddingDim, coreModel, shaperModel } (the exact key set sc1 defines). A miss trips a Story-level UnknownDimensionError before listRepos or any fs call.
  - Response: Print `error: unknown dimension '<X>'. Allowed: embeddingModel, embeddingDim, coreModel, shaperModel.` to stderr and exit non-zero. Do NOT read or write any file.
  - User impact: The command exits with the enumeration of allowed dimensions. The user retries with a valid name.
- **The user sets embeddingDim to a value that is not a positive integer.** (recoverable)
  - Detection: The action handler calls Number(value) and checks Number.isInteger + value > 0. Non-integer or non-positive input trips InvalidDimensionValueError.
  - Response: Print `error: dimension 'embeddingDim' requires a positive integer, got '<value>'.` to stderr and exit non-zero. No write occurs.
  - User impact: The command refuses before any file mutation. Existing overrides on this repo are untouched.
- **The user passes --repo <path> for a path that is not a registered insrc repo (ac3).** (recoverable)
  - Detection: After argument validation but before any write, the action handler calls listRepos and checks whether any RegisteredRepo's canonical path matches the passed --repo (or cwd when --repo is omitted). No match trips UnregisteredRepoError.
  - Response: Print `error: repo '<path>' is not registered with insrc. Run 'insrc repo add <path>' first.` to stderr and exit non-zero. No file is created.
  - User impact: The command refuses to create an override for a repo the daemon has not been told about. ac3 satisfied.
- **The atomic write fails at the OS level (disk full, quota exceeded, permission denied on ~/.insrc/repos/<slug>/).** (recoverable)
  - Detection: writeAtomic wraps writeFileSync + renameSync; both raise typed errno errors. The action handler's try/catch around writeAtomic catches the error and surfaces it.
  - Response: Print `error: failed to write override file <path>: <os-error-message>` to stderr and exit non-zero. Any .tmp file writeAtomic left behind is a known transient artifact that gets cleaned up next successful write.
  - User impact: The command fails with the OS-level error naming the file path so the user knows what to fix.
- **The current on-disk override file exists but its JSON is malformed.** (recoverable)
  - Detection: The action handler's JSON.parse of the read file body raises SyntaxError; the handler's try/catch converts to MalformedOverrideFileError.
  - Response: Print `error: existing override file at <path> is malformed JSON: <parser message>. Fix or delete the file, then re-run.` to stderr and exit non-zero. Do NOT overwrite with a fresh file — that would silently discard whatever the user was trying to preserve.
  - User impact: The set command refuses to silently obliterate corruption. User inspects the file, fixes or deletes it, retries.

### Edge cases

| Input | Expected |
| :--- | :--- |
| The override file does not exist yet (first `set` on this repo). | The handler treats a missing file identically to an empty JSON object `{}`, sets the one dimension in-memory, and writes the whole JSON via writeAtomic. writeAtomic creates parent dirs as needed (its documented behavior at src/insrc/workflow/storage.ts:62-73), so ~/.insrc/repos/<slug>/ is created implicitly. |
| The override file exists with only some of the four dimensions set; user sets a dimension that is NOT among them. | The dimension is added to the JSON object; the other pre-existing dimensions are preserved verbatim. Written file has the union of prior dimensions + the new one. |
| The override file already carries the dimension the user is setting, and the new value equals the current value. | The command is idempotent: the same JSON gets re-written to disk. ac2 semantics (previous value replaced) hold trivially. No signal to the user that nothing changed — the CLI does not read-diff before writing. |
| The user sets a model name string containing shell-unfriendly characters (spaces, colons, tags: e.g. `qwen3-embedding:0.6b`). | The value is written verbatim as a JSON string; shell quoting is the user's responsibility. The colon-containing model tag lands unchanged in the JSON string value. |
| The --repo path is a symlink to the actual repo directory. | The handler resolves the passed path through the repo-registry slug helper, which follows the same canonicalization the daemon uses on the read side. Symlink and target both map to the same slug — identical override file location for both invocations. |
| The user omits --repo and cwd is not itself a registered repo but is inside a registered repo tree. | The handler treats the exact cwd as the repo path candidate. If cwd is a subdirectory of a registered repo, the listRepos check fails with UnregisteredRepoError (the CLI does not walk up looking for a parent repo — that heuristic is out of scope). Users pass --repo explicitly in this case. |

### Invariants to preserve

- The atomic-write primitive at src/insrc/workflow/storage.ts:62-73 is reused verbatim; its documented behavior (mkdir -p parent dirs, write to .tmp, rename) is what sc1's durability nonFunctional relies on. Adding a second atomic-write helper for the CLI would fragment the durability guarantee. [[c2]]
- The existing register*Commands(program: Command): void pattern in src/insrc/cli/commands (daemon.ts, repo.ts, workflow.ts) is preserved; the new config.ts file adds a sibling of exactly the same shape. No changes to the existing subcommand modules. [[c1]]

## Test strategy

**Test framework:** `node:test with tsx (the repo-wide test runner used by every workflow / daemon / config test today)`

### Test levels

- **unit** — Exercise the dimension validator, value coercer, and the load-patch-write flow against tmpdir-backed override files. Cover every legal (dimension, value) pair from sc1's four keys plus every InvalidDimensionValueError / UnknownDimensionError case from s5.
  - Subjects: `the dimension validator inside the set action handler`, `the value coercer for embeddingDim (Number.isInteger + > 0)`, `the load-patch-write path for both file-missing and file-present cases`
  - Fixtures: `a tmpdir stubbing ~/.insrc/repos/<slug>/config.json for various pre-existing contents (no file, empty JSON object, one dim already set, all four dims set, malformed JSON)`, `a stub for the repo-registry slug helper returning a fixed slug for a canonical repo path so the resolver is deterministic`
- **unit** — Verify the listRepos check runs before any write and produces the exact error string for ac3.
  - Subjects: `the not-registered-repo check`, `the exact UnregisteredRepoError message shape`
  - Fixtures: `a stub for listRepos returning a fixed RegisteredRepo[] so the test can force both hit and miss paths`
- **integration** — Drive the actual CLI via node:test's child_process to exec `insrc config set <dim> <val> --repo <path>` against a registered tmpdir repo. Assert the override file lands with the exact JSON shape sc1 defines, and that a subsequent invocation replaces the dimension in place (ac2).
  - Subjects: `the wired-up commander subcommand`, `the CLI's end-to-end argument-to-file flow`
  - Fixtures: `a tmpdir install with a repo registered via `insrc repo add``, `the built CLI binary or an npx tsx invocation of src/insrc/cli/index.ts`
- **integration** — End-to-end read-write consistency: run `insrc config set embeddingModel qwen3` on a registered repo, then invoke loadEffectiveLocalConfig(repoPath) from s1's read side and assert the effective embeddingModel is 'qwen3'. This proves the CLI writes to exactly where the daemon reads.
  - Subjects: `s1 read / s2 write path agreement on sc1's on-disk location`
  - Fixtures: `a two-side test that runs the CLI, then invokes the resolver from src/insrc/config`
- **contract** — sc1 write-side contract test: given every legal (dimension, value) pair, the written file matches the sc1 shape byte-for-byte. Given every illegal input from s5 error cases, no file is written and the exact error message shape is emitted.
  - Subjects: `sc1 write-side contract`, `UnknownDimensionError + InvalidDimensionValueError + UnregisteredRepoError + MalformedOverrideFileError message shapes`

### Acceptance mapping

| Criterion | Proving tests |
| :--- | :--- |
| `ac1` | `unit: dimension validator accepts each of the four sc1 keys and the load-patch-write flow persists the correct value for each`, `integration: after `insrc config set embeddingModel qwen3 --repo <registered>`, the file at ~/.insrc/repos/<slug>/config.json contains { "embeddingModel": "qwen3" } exactly`, `integration: after the set command, calling loadEffectiveLocalConfig(repoPath) returns the overridden value (proves ac1's 'next daemon read picks up the new value' clause)` |
| `ac2` | `unit: with a pre-existing file { "embeddingModel": "old" }, setting embeddingModel=new writes { "embeddingModel": "new" }, no other keys`, `integration: two consecutive `insrc config set embeddingModel X` invocations leave only the second value on disk` |
| `ac3` | `unit: the not-registered-repo check produces the exact 'error: repo <path> is not registered with insrc. Run insrc repo add <path> first.' message and exits non-zero`, `integration: `insrc config set embeddingModel qwen3 --repo /tmp/does-not-exist` exits non-zero and no override file is created anywhere under ~/.insrc/repos/` |

## Migration

**State before:** src/insrc/cli/commands exposes four sibling subcommand files (daemon.ts, repo.ts, setup.ts, workflow.ts) each with a `register*Commands(program: Command): void` export mounted onto the CLI root [[c1]]. There is no `insrc config` command family and no way for a user to set a per-repo model override from the command line: users would have to hand-edit ~/.insrc/config.json globally or later hand-edit ~/.insrc/repos/<slug>/config.json directly. The atomic-write primitive at src/insrc/workflow/storage.ts:62-73 [[c2]] exists and is exercised elsewhere in the codebase; listRepos at src/insrc/db/repos.ts:213-222 [[c3]] exists and returns the registered repo list.

**State after:** src/insrc/cli/commands has a fifth sibling file (config.ts) exporting registerConfigCommands(program: Command): void, mounted onto the CLI root alongside daemon / repo / setup / workflow. Running `insrc config set <dimension> <value> [--repo <path>]` writes the given dimension into ~/.insrc/repos/<slug>/config.json via writeAtomic. The write path validates the dimension against sc1's four allowed keys, coerces the value per sc1's type contract, checks listRepos to satisfy ac3, and preserves any pre-existing dimensions in the file. The existing four register*Commands functions and their subcommands are unchanged.

**Zero downtime:** yes — **Data rewrite:** no

### Steps

1. Create src/insrc/cli/commands/config.ts. Export a single registerConfigCommands(program: Command): void function that mounts the `config` command family with one subcommand `set` accepting two positional args (<dimension>, <value>) and one option (--repo, defaulting to cwd). The action handler is a shell at this step — no validation, no write — so the commander wiring alone can be verified. — ↩ rollbackable
2. Wire registerConfigCommands into the CLI root by adding a single line to src/insrc/cli/index.ts (or wherever the other register*Commands are invoked). No other CLI code changes. — ↩ rollbackable
3. Add the dimension validator + value coercer inside the `set` action handler. Validator hardcodes the four sc1 keys (embeddingModel, embeddingDim, coreModel, shaperModel). Coercer applies Number(value) + Number.isInteger + > 0 for embeddingDim; the other three pass through as strings. — ↩ rollbackable
4. Add the not-registered-repo check: call listRepos and compare the resolved --repo path against the returned RegisteredRepo[]. Miss trips UnregisteredRepoError with the exact ac3 message shape. — ↩ rollbackable
5. Add the load-patch-write flow: resolve the override file path via the same repo-registry slug helper the daemon reader uses, read the existing JSON (treat missing file as `{}`), set the one dimension, and call writeAtomic with the serialized full object. Wrap fs + JSON.parse in try/catch surfacing MalformedOverrideFileError on parse failure. — ↩ rollbackable
6. Add the unit + integration tests under src/insrc/cli/commands/__tests__/config-set.test.ts covering every acceptance mapping from s6 and every error case from s5. — ↩ rollbackable
7. Update docs (docs/config.md or the existing daemon docs — whichever the setup wizard already references) to explain `insrc config set` with a short example and a link to sc1's on-disk shape for hand-editors. — ↩ rollbackable

**Backward compat:** The insrc CLI gains a new `config` command family that did not exist before; existing subcommands (daemon / repo / setup / workflow) are unchanged and continue to work exactly as today. No global config file changes; users who never invoke `insrc config set` see zero difference. The programmatic override entry point (ShaperProviderOverrides) and the daemon's runtime API are untouched. There is no data migration: the CLI simply gains a way to produce sc1-shaped files at the location the daemon reader already reads from.

## Alternatives considered

### a1: Subcommand-per-dimension

Give each of the four covered dimensions its own commander subcommand under `insrc config set` (e.g. `insrc config set embedding-model <value> --repo <path>`).

Register four commander subcommands under a parent `config set` group: `embedding-model`, `embedding-dim`, `core-model`, `shaper-model`. Each subcommand accepts one positional `<value>` argument and an optional `--repo <path>` (defaulting to cwd). The kebab-case in the CLI maps to sc1's camelCase keys via a static mapping table. The subcommand's action handler resolves the repo path, calls listRepos to satisfy ac3, loads (or creates) the JSON object, sets its own dimension, and writes atomically via writeAtomic.

Because each dimension is a distinct commander definition, an unknown dimension name is caught by commander itself (`Unknown command 'embeddigmodel'`) before any user code runs.

**Rejected because:** Satisfies every AC + every applicable Epic constraint but ships 4 subcommand definitions when 1 covers the same surface area. The 'commander catches unknown dimension' pro is real but the same effect is achievable in a2 with a one-line validation that also produces a more precise error message (enumerating the four allowed dimensions verbatim from sc1).

### a2: Single subcommand with positional dimension — **CHOSEN**

`insrc config set <dimension> <value> [--repo <path>]` — one subcommand, dimension is a validated positional argument.

Register a single commander subcommand `config set` that accepts two positional arguments (`<dimension>` and `<value>`) plus an optional `--repo <path>` option (defaulting to cwd). The action handler validates `<dimension>` against sc1's four allowed dimension names, coerces `<value>` to the correct type per sc1's type contract (number for embeddingDim, string for the three model names), resolves the repo path, checks listRepos for ac3, loads (or creates) the JSON object, sets the dimension, and writes atomically via writeAtomic.

The dimension name matches sc1's exact camelCase keys (embeddingModel, embeddingDim, coreModel, shaperModel) so the CLI vocabulary is byte-identical to the on-disk file's key set.

### a3: Flag-only invocation

`insrc config set --dimension <name> --value <value> [--repo <path>]` — no positional args; every field is a named flag.

Register one commander subcommand `config set` whose action takes three required options: --dimension, --value, --repo (defaulting to cwd). Same validation + write path as a2, but the CLI shape is uniformly flag-driven. Matches the shape of insrc's existing commands where flags dominate (e.g. `insrc workflow amend <slug> --approve <id>`).

**Rejected because:** Fully satisfies but the CLI shape (all flags) is verbose vs. a2's positional idiom and diverges from `insrc repo add <path>`. No ac / constraint gain over a2 to offset the ergonomics loss.

## Citations

- **[[c1]]** `analyze-bundle` `s1 bundle 1: module.profile+symbol.locate on src/insrc/cli/commands` — "4 sibling subcommand files each exporting a single register*Commands(program: Command): void. registerDaemonCommands (daemon.ts:18-45), registerRepoCommands (repo.ts:10-27), registerWorkflowCommands ("
- **[[c2]]** `code` `src/insrc/workflow/storage.ts:62-73:writeAtomic` — "writeAtomic(absPath: string, content: string): void — atomic write-then-rename primitive, creates parent dirs as needed. Located via s1 bundle 2 symbol.locate."
- **[[c3]]** `code` `src/insrc/db/repos.ts:213-222:listRepos` — "listRepos(_db: DbClient): Promise<RegisteredRepo[]> — returns the registered repo list. Located via s1 bundle 2 symbol.locate."
