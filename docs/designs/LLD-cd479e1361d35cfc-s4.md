# LLD: s4

**Epic:** `support-per-repo-config-overrides-embedding`
**HLD base run:** `wf-1783920776460-bd44gr`
**HLD effective hash:** `ff7482e7beb3...`

## HLD context

**Framework:** A layered config resolver in src/insrc/config reads the existing global loader first and overlays a per-repo override file (JSON) at ~/.insrc/repos/<slug>/config.json when present [[c1]]. All 15 config read sites (daemon boot, indexer, embedder, seven Lance stores, and tests) migrate to a repo-aware loader; the CLI reads / writes / deletes dimensions inside the same override file. No LMDB migration and no repo-tree writes; the global config's schema is unchanged and overrides are hand-editable JSON.
**Rollout phase:** Phase B -- CLI CRUD for overrides
**Consumes:** `sc1` (PerRepoOverrideFile)

## Contract details

**Surface level:** internal

## Data model changes

### `src/insrc/cli/commands/config.ts` — invariant-change

The same registerConfigCommands(program: Command): void function s2 introduces (and s3 extends with `list`) gains a third subcommand: `unset`. The `set` (s2) and `list` (s3) subcommands are unchanged. `unset` accepts one positional argument <dimension> and one option --repo <path> (defaulting to cwd), mirroring s2's positional shape. The action handler reuses the s2/s3 building blocks verbatim: listRepos + repo-registry slug helper for the not-registered-repo check [[c2]], writeAtomic for the file-shrink case [[c1]], and adds one new primitive — fs.unlinkSync — in the last-dim-removed branch. The existing register*Commands pattern is preserved [[c1]].

**Call sites:**
- `src/insrc/cli/commands/config.ts`
- `src/insrc/workflow/storage.ts`
- `src/insrc/db/repos.ts`

## Interaction with shared contracts

| Contract | Role | How |
| :--- | :--- | :--- |
| `sc1` | consumes | This Story CONSUMES sc1. It implements the delete/shrink side of the CLI CRUD triad: (1) computes the file path via the same repo-registry slug helper s1/s2/s3 use; (2) validates the <dimension> positional against sc1's four allowed keys (embeddingModel, embeddingDim, coreModel, shaperModel) and refuses anything else with the same UnknownDimensionError message shape s2 defines; (3) reads the current on-disk JSON; if the file is missing OR the requested dimension is not present, the command succeeds as a no-op with the exact ac3-required message shape (`nothing was set for '<dimension>' on <repoPath>`); (4) if the dimension IS present, removes it from the parsed JSON object in memory and branches: if at least one key remains, calls writeAtomic with the reduced object; if zero keys remain, calls fs.unlinkSync to delete the file (HLD boundary requirement: 'delete the file when the last dimension is unset so a missing file cleanly indicates no overrides'). sc1's on-disk shape is preserved verbatim across every path — no new keys, no null values (both sc1-forbidden). The file-cleanup semantic preserves sc1's 'missing file = fall through to global' invariant that s1's reader relies on. |

## Error paths

### Error cases

- **The user passes a <dimension> positional that is not one of sc1's four allowed keys.** (recoverable)
  - Detection: The action handler checks the positional string against the hardcoded set { embeddingModel, embeddingDim, coreModel, shaperModel } — same validator surface as s2's set. A miss trips UnknownDimensionError before listRepos or any fs call.
  - Response: Print `error: unknown dimension '<X>'. Allowed: embeddingModel, embeddingDim, coreModel, shaperModel.` to stderr and exit non-zero — message shape identical to s2. No file is read or modified.
  - User impact: The command exits without touching any file. User retries with a valid name.
- **The user passes --repo <path> for a path that is not a registered insrc repo.** (recoverable)
  - Detection: listRepos + canonical-path comparison, same check s2/s3 use. No match trips UnregisteredRepoError.
  - Response: Print `error: repo '<path>' is not registered with insrc. Run 'insrc repo add <path>' first.` to stderr and exit non-zero — identical message shape to s2/s3.
  - User impact: No file mutation. Uniform CLI error UX across every config subcommand.
- **The current on-disk override file exists but its JSON is malformed.** (recoverable)
  - Detection: JSON.parse of the file body raises SyntaxError; the handler's try/catch converts to MalformedOverrideFileError — same type name s2/s3 define.
  - Response: Print `error: existing override file at <path> is malformed JSON: <parser message>. Fix or delete the file, then re-run.` to stderr and exit non-zero. Do NOT overwrite or delete a malformed file — user content that we cannot parse is not ours to destroy.
  - User impact: The unset command refuses to silently obliterate a malformed file. User inspects, fixes or deletes, retries.
- **The current file exists but parses to a non-object root (array, number, string, boolean, or null).** (recoverable)
  - Detection: After JSON.parse, the handler checks `typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)`. Anything else trips MalformedOverrideFileError with `expected object, got <actual type>`.
  - Response: Same MalformedOverrideFileError path — fail fast, do not modify or delete the file.
  - User impact: Same as the SyntaxError case.
- **The atomic write fails at the OS level (disk full, quota exceeded, permission denied on ~/.insrc/repos/<slug>/).** (recoverable)
  - Detection: try/catch around writeAtomic catches typed errno errors from writeFileSync + renameSync.
  - Response: Print `error: failed to write override file <path>: <os-error-message>` to stderr and exit non-zero. The pre-existing file is untouched because writeAtomic's rename-in-place semantic means a failed write leaves the previous version intact.
  - User impact: The unset fails cleanly with an actionable OS-level error; the existing overrides remain.
- **The file-delete (fs.unlinkSync) fails at the OS level in the last-dim-removed branch (permission denied, filesystem read-only, etc).** (recoverable)
  - Detection: try/catch around fs.unlinkSync catches the errno.
  - Response: Print `error: failed to delete override file <path>: <os-error-message>` to stderr and exit non-zero. The file remains on disk WITH the last dimension already removed from the JSON — a partial-cleanup state. Do NOT attempt to roll back by re-writing the pre-unset state; leave the reduced file so the user's chosen dimension actually gets unset even if cleanup fails.
  - User impact: The user's intended unset succeeded at the semantic level; only the file-cleanup step failed. The reader still sees no active overrides because the file has empty object contents — which the daemon treats identically to a missing file per s3's edge case. Next successful unset (or hand cleanup) removes the file.

### Edge cases

| Input | Expected |
| :--- | :--- |
| The override file does not exist and the user runs unset on any dimension. | Idempotent no-op success. Print `nothing was set for '<dimension>' on <repoPath>` — the exact ac3 wording. Exit zero. Do NOT create the file. |
| The override file exists but the requested dimension is not present in the parsed JSON. | Same idempotent no-op success message as the missing-file case. Do NOT modify the file. Exit zero. |
| The override file has exactly one dimension set and the user unsets it. | The file is deleted via fs.unlinkSync (the last-dim-removed branch). Print `unset '<dimension>' on <repoPath>` (or similar success message; the exact wording is not ac-constrained). Exit zero. |
| The override file has multiple dimensions set and the user unsets one of them. | writeAtomic rewrites the file with the reduced object; the other pre-existing dimensions are preserved verbatim (ac1). Exit zero. |
| The override file exists and parses to `{}` (empty object). | Same as the missing-file case — no-op success. The file existing as an empty object is behaviorally equivalent to missing per s3's edge case, so unset can treat them uniformly. |
| The user unsets a dimension, then immediately unsets it again. | First call: mutation succeeds. Second call: no-op success (dimension not present). Idempotent. |
| The --repo path is a symlink to the actual repo directory. | Same slug-helper canonicalization as s1/s2/s3 — symlink and target map to the same slug and the same override file. |
| The user omits --repo and cwd is not a registered repo. | Same UnregisteredRepoError shape as s2/s3 — uniform CLI error UX. |

### Invariants to preserve

- The atomic-write primitive at src/insrc/workflow/storage.ts:62-73 is reused verbatim for the file-shrink case; s4 does NOT introduce a second atomic-write helper. sc1's durability nonFunctional relies on this single primitive. [[c1]]
- The existing register*Commands(program: Command): void pattern in src/insrc/cli/commands is preserved; s4 adds an `unset` subcommand to the same registerConfigCommands function s2 introduces (and s3 extends with `list`), no new register* function. [[c1]]
- The UnregisteredRepoError, UnknownDimensionError, and MalformedOverrideFileError shapes (both type names and exact message wording) are shared verbatim with s2's set and s3's list — CLI users see the same error text for the same failure mode across every config subcommand. [[c2]]
- sc1's 'missing file = fall through to global config' invariant is preserved BOTH via the ac2 file-cleanup semantic (last unset deletes the file) AND via the edge case where a failed fs.unlinkSync leaves an empty-object file (which the daemon reader treats identically per s1 LLD + s3 LLD). [[c1]]

## Test strategy

**Test framework:** `node:test with tsx (the repo-wide test runner used by every workflow / daemon / config test today — same as s2/s3)`

### Test levels

- **unit** — Exercise the unset action handler's four branches (missing file, dim-not-present, dim-present-multi, dim-present-last) against tmpdir-backed override files and assert the correct writeAtomic-vs-unlink outcome for each.
  - Subjects: `the unset action handler's load-patch-write/delete flow`, `the last-dim-removed branch selecting fs.unlinkSync`, `the multi-dim branch selecting writeAtomic with reduced object`, `the no-op success message shape`
  - Fixtures: `a tmpdir stubbing ~/.insrc/repos/<slug>/config.json for various pre-existing contents (no file, empty object, one dim set, two dims set, four dims set, malformed JSON, non-object root)`, `a stub for listRepos returning a fixed RegisteredRepo[] so the handler proceeds past the gate deterministically`
- **unit** — Verify the shared-error-message parity: UnknownDimensionError + UnregisteredRepoError + MalformedOverrideFileError message text byte-for-byte matches s2's set command errors.
  - Subjects: `shared error message shapes across s2/s3/s4`
  - Fixtures: `fixture reusing s2's error-message expected constants for direct string comparison`
- **integration** — Drive the actual CLI via child_process to exec `insrc config unset <dim> --repo <path>` against a registered tmpdir repo in three states (missing file, multi-dim file, single-dim file) and assert (1) the file mutation is correct, (2) the file is deleted when zero dims remain, (3) stdout carries the right success message, (4) exit code is zero.
  - Subjects: `end-to-end argument-to-file flow of the unset subcommand`
  - Fixtures: `a tmpdir install with a repo registered via `insrc repo add``, `the built CLI binary or an npx tsx invocation of src/insrc/cli/index.ts`
- **integration** — Round-trip with s2 + s3: set multiple dimensions via `insrc config set`, verify with `insrc config list`, unset one dimension, verify via list that only that one is gone; then unset the remainder and verify the file is deleted (via fs.existsSync check on the expected path) and `insrc config list` shows all four rows as `(global fallback)`.
  - Subjects: `s2/s3/s4 command-triad interoperability against the sc1 on-disk contract`
  - Fixtures: `the same tmpdir install used above`
- **integration** — Verify ac2 with the read side: after unsetting the last dimension and confirming the file is gone, invoke loadEffectiveLocalConfig(repoPath) from s1's read side and assert it returns exactly what the global loader alone returns — no per-repo overlay.
  - Subjects: `ac2 read-back verification against the s1-owned resolver`
  - Fixtures: `a two-side test that runs the CLI unset chain, then invokes the resolver from src/insrc/config`
- **contract** — sc1 delete-side contract test: given every legal starting shape (per-dimension subset), unsetting each dimension produces either the correct reduced sc1-shape or the file-deleted state. Given every disallowed input from s5 error cases, no mutation occurs and the correct error shape is emitted.
  - Subjects: `sc1 delete-side contract`, `error-shape parity with s2/s3`

### Acceptance mapping

| Criterion | Proving tests |
| :--- | :--- |
| `ac1` | `unit: starting file `{ embeddingModel: 'x', coreModel: 'y' }`, unset coreModel — writeAtomic is called with exactly `{ embeddingModel: 'x' }`, no other keys, no null values, no file delete`, `integration: `insrc config set embeddingModel x --repo <path>` + `insrc config set coreModel y --repo <path>` + `insrc config unset coreModel --repo <path>` + `insrc config list --repo <path>` — list output shows embeddingModel: x and coreModel: (global fallback), with embeddingDim and shaperModel still on (global fallback)` |
| `ac2` | `unit: starting file with exactly one dim set, unset that dim — fs.unlinkSync is called on the override file path, writeAtomic is NOT called, the file no longer exists on disk`, `integration: after unsetting every dim, loadEffectiveLocalConfig(repoPath) returns identical LocalProviderInfraConfig to what the global loader alone returns — proves the daemon falls through to global` |
| `ac3` | `unit: with missing override file, unset any dim — no fs write or unlink occurs, stdout contains `nothing was set for '<dim>' on <repoPath>` verbatim, exit code zero`, `unit: with existing file that has embeddingModel set, unset coreModel — same no-op message, no fs mutation`, `integration: `insrc config unset shaperModel --repo <path>` on a repo with no override file exits zero with the exact ac3 message on stdout` |

## Migration

**State before:** After s2 + s3 land, src/insrc/cli/commands/config.ts exports registerConfigCommands(program: Command): void with two subcommands: `set` (s2) and `list` (s3). There is no `insrc config unset` command; the only way to remove an override is to hand-edit ~/.insrc/repos/<slug>/config.json or delete the file. writeAtomic at src/insrc/workflow/storage.ts:62-73 [[c1]] and listRepos at src/insrc/db/repos.ts:213-222 [[c2]] are both exercised by s2 and reusable verbatim.

**State after:** src/insrc/cli/commands/config.ts's registerConfigCommands gains a third subcommand `unset` alongside `set` (s2) and `list` (s3). Running `insrc config unset <dimension> [--repo <path>]` removes the requested dimension from the sc1 override file. When at least one dimension remains, writeAtomic re-serializes the reduced object; when zero dimensions remain, fs.unlinkSync deletes the file so the daemon reader's 'missing file = fall through' invariant is preserved. Idempotent: missing file OR dimension-not-in-file both succeed with the ac3 no-op message. Error message shapes match s2/s3 verbatim for uniform CLI UX.

**Zero downtime:** yes — **Data rewrite:** no

### Steps

1. Add an `unset` subcommand under the same `config` command family the `set` and `list` subcommands mount on. Accept one positional argument <dimension> and one option --repo <path> (defaulting to cwd). Wire the action handler as a shell (no read, no write) so the commander wiring alone can be verified. — ↩ rollbackable
2. Add the dimension validator by referencing the same hardcoded four-key set s2's set command uses (embeddingModel, embeddingDim, coreModel, shaperModel). A miss trips the shared UnknownDimensionError with byte-identical message shape. — ↩ rollbackable
3. Add the not-registered-repo check by reusing the same listRepos + repo-registry slug helper the set and list actions use. Miss trips the shared UnregisteredRepoError. — ↩ rollbackable
4. Add the load step: resolve the sc1 file path via the shared slug helper. Missing file (ENOENT) branches to the idempotent no-op success path with the ac3 message. Existing file gets read + parsed with the same MalformedOverrideFileError typing s2/s3 use on parse failure / non-object root. — ↩ rollbackable
5. Add the patch step: if the parsed JSON does not contain the requested dimension, branch to the no-op success path with the same message. If it does contain the dimension, delete the key from the in-memory object. — ↩ rollbackable
6. Add the write-or-delete branch: if the reduced object has at least one key, serialize + writeAtomic. If it has zero keys, call fs.unlinkSync on the file path. Both branches are wrapped in try/catch to surface OS errors as the appropriate error shape from s5. — ↩ rollbackable
7. Extend src/insrc/cli/commands/__tests__/ (config-set.test.ts extension or sibling config-unset.test.ts, matching the existing convention when the module lands) with the unit + integration tests from s6 covering every acceptance mapping and every error case from s5. — ↩ rollbackable
8. Update the docs stub s2 introduced (docs/config.md or the setup-wizard-linked doc) with a brief mention of `insrc config unset` including the file-cleanup semantic and the ac3 no-op example. — ↩ rollbackable

**Backward compat:** The `unset` subcommand is purely additive. The `set` (s2) and `list` (s3) subcommands are unchanged. Existing insrc CLI subcommands (daemon / repo / setup / workflow) are unchanged. Users who never run `insrc config unset` see zero difference. sc1's on-disk shape is not modified — unset never introduces new keys or null values, and the file-cleanup semantic is a specialization of sc1's 'missing file = fall through' invariant, not a modification of it. The daemon reader (s1 LLD) continues to read the same file the same way.

## Alternatives considered

### a1: Load-patch-write with file-delete on last-dim removal — **CHOSEN**

Read the file, remove the requested key from the JSON object, then either writeAtomic the remaining shape or fs.unlinkSync when zero dimensions remain.

`insrc config unset <dimension> [--repo <path>]` mirrors s2's CLI shape (positional dimension + optional --repo). The action handler validates the dimension against sc1's four keys, calls listRepos for ac3-style not-registered-repo check, reads the current file (missing file = idempotent no-op success), removes the requested key from the parsed JSON object in memory, then branches: if the remaining object has at least one key, writeAtomic serializes and writes it back; if the remaining object has zero keys, fs.unlinkSync removes the file. Missing-file and dimension-not-in-file cases both take the idempotent no-op success path with the message `nothing was set for '<dimension>' on <repoPath>` (ac3).

### a2: Sentinel-value overwrite (keep the file, set the dim to null)

Instead of deleting the key, set the dimension's value to `null` in the JSON so the file always exists and always has the same key set.

The unset command reads the file, sets the requested dimension's value to `null` (not absent), and writes back via writeAtomic. Missing file = create a new file with only that one key set to `null`. The reader (s1 LLD) is expected to treat `null` values identically to absent keys — fall through to global.

The HLD 'delete the file' cleanup semantics are dropped in favor of a persistent file that always exists after any config operation.

**Rejected because:** Two violations (sc1 + k2) + two partials (ac1 + ac2). Both violations trace to the same root: sentinel-null values are not part of sc1's typed contract and would require an HLD amendment to be viable. The one-mechanism 'simplicity' pro does not offset the contract violations.

### a3: Unset-then-list output — print effective state after each unset

Same load-patch-write-or-delete flow as a1, but after every successful unset print the current state of the file (delegating to the s3 list output).

The command performs the same operations as a1 (validate, check registered, load, patch, writeAtomic OR fs.unlinkSync). After a successful mutation, the handler ALSO invokes the s3 list-format helper to print the post-unset state to stdout, so users see immediately what remains overridden and what fell back to global.

Requires refactoring s3's list-format logic into a shared internal function that both `list` and `unset` action handlers call.

**Rejected because:** Fully satisfies but adds work: refactoring s3's list-format function into a shared helper so unset can call it after every mutation. That refactor + the extra stdout output touches s3's tested surface, expanding s4's scope beyond what its ACs require. The trailing-list output also breaks shell composability.

## Citations

- **[[c1]]** `prior-artifact` `.insrc/artifacts/LLD-cd479e1361d35cfc-s2.json (register*Commands + writeAtomic + sc1 file semantics)` — "s2 LLD grounded register*Commands(program: Command): void pattern across daemon.ts:18-45, repo.ts:10-27, workflow.ts:52-293. writeAtomic at src/insrc/workflow/storage.ts:62-73 is the atomic write-then"
- **[[c2]]** `code` `src/insrc/db/repos.ts:213-222:listRepos` — "listRepos(_db: DbClient): Promise<RegisteredRepo[]> — returns the registered repo list; shared not-registered-repo check across `set` (s2), `list` (s3), and `unset` (s4)."
