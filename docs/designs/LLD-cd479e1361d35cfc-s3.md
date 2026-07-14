# LLD: s3

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

The same registerConfigCommands(program: Command): void function s2 introduces gains a second subcommand: `list`. The `set` subcommand from s2 is unchanged. `list` accepts one option --repo <path> (defaulting to cwd), calls the same not-registered-repo check listRepos [[c2]] used by `set`, reads sc1's file at ~/.insrc/repos/<slug>/config.json via fs.readFileSync, parses JSON, and prints a four-row table per the winning alternative. The existing register*Commands pattern is preserved [[c1]].

**Call sites:**
- `src/insrc/cli/commands/config.ts`
- `src/insrc/db/repos.ts`

## Interaction with shared contracts

| Contract | Role | How |
| :--- | :--- | :--- |
| `sc1` | consumes | This Story CONSUMES sc1. It reads sc1's file at sc1's exact path convention (~/.insrc/repos/<slug>/config.json) via the same repo-registry slug helper s1 (reader) and s2 (set writer) use. Only sc1's four allowed dimensions (embeddingModel, embeddingDim, coreModel, shaperModel) are printed, in sc1's fixed key order. When the file exists, each key present in the JSON prints as `<dimension>: <value>`; keys absent from the JSON print as `<dimension>: (global fallback)`. When the file does not exist, is empty, or parses to `{}`, all four dimensions print as `(global fallback)` plus a footer line `all four dimensions using global config from ~/.insrc/config.json` — the explicit-wording requirement from ac2. sc1's on-disk shape is not modified; s3 is read-only. Unknown keys in the file (should not occur under normal use per sc1's contract but can arise from hand editing) surface via the same MalformedOverrideFileError s2's contract already defines. |

## Error paths

### Error cases

- **The user passes --repo <path> for a path that is not a registered insrc repo.** (recoverable)
  - Detection: The list action handler calls listRepos and checks whether any RegisteredRepo's canonical path matches the passed --repo (or cwd when --repo is omitted). No match trips UnregisteredRepoError — same shape as s2's set command uses.
  - Response: Print `error: repo '<path>' is not registered with insrc. Run 'insrc repo add <path>' first.` to stderr and exit non-zero. No file is read.
  - User impact: The command exits without printing any dimension info. Users get the same message shape they see from `set` — uniform CLI error UX.
- **The override file exists but is not valid JSON.** (recoverable)
  - Detection: JSON.parse of the file body raises SyntaxError; the handler's try/catch converts to MalformedOverrideFileError — same type name s2 defines.
  - Response: Print `error: existing override file at <path> is malformed JSON: <parser message>. Fix or delete the file, then re-run.` to stderr and exit non-zero. Do NOT pretend the file is empty; the user's intent is not readable and silently showing `(global fallback)` for all four dims would mislead.
  - User impact: The list command refuses to render a false picture. User inspects the file, fixes or deletes it, retries.
- **The override file exists but its JSON parses to a non-object (array, number, string, boolean, or null at the root).** (recoverable)
  - Detection: After JSON.parse, the handler checks `typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)`. Anything else trips MalformedOverrideFileError with a message like `expected object, got <actual type>`.
  - Response: Same MalformedOverrideFileError path — fail fast, name the actual type.
  - User impact: Same as the SyntaxError case — the user knows exactly what to fix.
- **The override file exists but fs.readFileSync raises EACCES / permission denied.** (recoverable)
  - Detection: try/catch around fs.readFileSync catches the errno; the handler surfaces the OS error path + message.
  - Response: Print `error: cannot read override file <path>: <os-error-message>` to stderr and exit non-zero.
  - User impact: User sees the OS-level error naming the file path. No false `(global fallback)` display that would hide the permission problem.

### Edge cases

| Input | Expected |
| :--- | :--- |
| The override file does not exist. | Print the four-row table with all four rows as `<dimension>: (global fallback)` plus the footer `all four dimensions using global config from ~/.insrc/config.json`. This is the ac2 explicit-wording case and it is NOT an error — a missing file is the expected default state for a repo that has never had `set` run against it. |
| The override file exists and parses to `{}` (empty object). | Same output as the missing-file case — four `(global fallback)` rows + the footer. Behaviorally equivalent; the CLI does not signal 'file exists but empty' as distinct from 'file missing'. |
| The override file has exactly one dimension set (e.g. only embeddingModel). | Four rows: embeddingModel: <value>; embeddingDim: (global fallback); coreModel: (global fallback); shaperModel: (global fallback). No footer (footer prints only when ALL four are fallback). |
| The override file has all four dimensions set. | Four rows with real values — no `(global fallback)` markers, no footer. |
| The user omits --repo and cwd is not itself a registered repo. | Same UnregisteredRepoError shape as s2's set command uses — CLI error UX is uniform between set and list. The CLI does not walk up looking for a parent repo. |
| The --repo path is a symlink to the actual repo directory. | The handler resolves the passed path through the same repo-registry slug helper s1 / s2 use — symlink and target both map to the same slug and read the same file. |
| The override file has a value that is technically a string like 'true' or '42' when the sc1 contract expects the corresponding raw type. | The list command prints the value verbatim as parsed by JSON.parse. It does NOT re-validate types against sc1's type contract — that validation lives on the s1 reader (which will surface the mismatch as an InvalidOverrideFileError at daemon load time). Rationale: list should show what's there, not do the reader's validation work; the mismatch will surface loudly on the next daemon read. |

### Invariants to preserve

- sc1's on-disk shape is READ-ONLY under this Story. The list command never writes to ~/.insrc/repos/<slug>/config.json, never creates the file, never mutates existing contents — pure filesystem read + stdout print. [[c1]]
- The existing register*Commands(program: Command): void pattern in src/insrc/cli/commands is preserved; s3 adds a `list` subcommand to the same registerConfigCommands function s2 introduces, no new register* function. [[c1]]
- The UnregisteredRepoError shape (both the type name and the exact message wording) is shared between s2's set command and s3's list command — CLI users see the same error text for the same failure mode across every config subcommand. [[c2]]

## Test strategy

**Test framework:** `node:test with tsx (the repo-wide test runner used by every workflow / daemon / config test today — same as s2 uses)`

### Test levels

- **unit** — Exercise the list action handler against tmpdir-backed override files covering every legal shape (missing, empty, partial, full) and assert the exact four-row output for each.
  - Subjects: `the list action handler's format-and-print flow`, `the `(global fallback)` marker rendering`, `the all-fallback footer rendering`
  - Fixtures: `a tmpdir stubbing ~/.insrc/repos/<slug>/config.json for various pre-existing contents (no file, empty JSON object, one dim set, all four dims set, malformed JSON, non-object root)`, `a stub for listRepos returning a fixed RegisteredRepo[] so the handler proceeds past the not-registered-repo gate deterministically`
- **unit** — Verify the not-registered-repo check for `list` produces the exact same UnregisteredRepoError message shape as `set` (shared CLI error UX invariant).
  - Subjects: `the not-registered-repo check on the list path`, `message shape parity with the set command`
  - Fixtures: `a stub for listRepos to force the miss path`
- **integration** — Drive the actual CLI via child_process to exec `insrc config list --repo <path>` against a registered tmpdir repo in three states: no override file, one-dim override, all-dims override. Assert stdout matches the expected four-row shape verbatim.
  - Subjects: `end-to-end argument-to-stdout flow of the list subcommand`, `commander wiring under registerConfigCommands`
  - Fixtures: `a tmpdir install with a repo registered via `insrc repo add``, `the built CLI binary or an npx tsx invocation of src/insrc/cli/index.ts`
- **integration** — Round-trip check with s2: run `insrc config set embeddingModel qwen3 --repo <path>`, then `insrc config list --repo <path>`, and assert the list output shows `embeddingModel: qwen3` on row 1 and `(global fallback)` on the other three rows.
  - Subjects: `s2/s3 write/read parity on the same on-disk sc1 file`
  - Fixtures: `the same tmpdir install used above`
- **contract** — sc1 read-side display contract: given every legal PerRepoOverrideFile shape (per-dimension subset), the list output matches the expected four-row rendering. Given every disallowed file shape from s5 error cases (malformed JSON, non-object root, permission denied), the correct MalformedOverrideFileError / OS error is emitted with the expected message shape.
  - Subjects: `sc1 read-side display contract`, `MalformedOverrideFileError + UnregisteredRepoError message shape parity with s2`

### Acceptance mapping

| Criterion | Proving tests |
| :--- | :--- |
| `ac1` | `unit: with a per-repo file `{ "embeddingModel": "qwen3", "embeddingDim": 768 }`, the list output has row `embeddingModel: qwen3` and row `embeddingDim: 768` (both containing the dimension name AND the current value verbatim)`, `integration: `insrc config set embeddingModel qwen3 --repo <path>` followed by `insrc config list --repo <path>` prints `embeddingModel: qwen3` verbatim in the list output` |
| `ac2` | `unit: with no override file present at ~/.insrc/repos/<slug>/config.json, the list output has all four rows as `<dim>: (global fallback)` AND the footer line `all four dimensions using global config from ~/.insrc/config.json` verbatim — the exact wording ac2 requires`, `integration: `insrc config list --repo <path>` on a registered repo with no override file emits both the four-fallback rows and the global-config footer to stdout (not stderr)` |

## Migration

**State before:** After s2 lands, src/insrc/cli/commands/config.ts exports registerConfigCommands(program: Command): void with a single `set` subcommand. There is no `insrc config list` command; the only way to inspect what overrides are on a repo is to open the JSON file at ~/.insrc/repos/<slug>/config.json directly. sc1's file convention is defined by s1 and its atomic-write primitive by src/insrc/workflow/storage.ts [[c1]]. listRepos at src/insrc/db/repos.ts:213-222 [[c2]] exists and returns the registered repo list.

**State after:** src/insrc/cli/commands/config.ts's registerConfigCommands gains a second subcommand `list` alongside `set`. Running `insrc config list [--repo <path>]` prints a four-row table naming every sc1 dimension (embeddingModel, embeddingDim, coreModel, shaperModel) in sc1's fixed key order with either the per-repo value or the marker `(global fallback)`. When no dimensions are overridden, a footer line `all four dimensions using global config from ~/.insrc/config.json` prints. UnregisteredRepoError and MalformedOverrideFileError message shapes match s2's exact wording so the CLI's error UX is uniform across every config subcommand.

**Zero downtime:** yes — **Data rewrite:** no

### Steps

1. Add a `list` subcommand under the same `config` command family the `set` subcommand mounts on. Accept one option --repo <path> (defaulting to cwd). Wire the action handler as a shell (no read, no format) so the commander wiring alone can be verified. — ↩ rollbackable
2. Add the not-registered-repo check to the list action by reusing the same listRepos + repo-registry slug helper the `set` action uses. Miss trips the shared UnregisteredRepoError with the exact same message shape as set (verified by test). — ↩ rollbackable
3. Add the file read: resolve the sc1 file path via the shared slug helper, wrap fs.readFileSync in try/catch to surface MalformedOverrideFileError on SyntaxError, non-object root, or EACCES. Missing file (ENOENT) is NOT an error — it's the all-fallback edge case. — ↩ rollbackable
4. Add the format-and-print step: for each of sc1's four dimensions in fixed order, print `<dimension>: <value>` when the key is present in the parsed JSON, else `<dimension>: (global fallback)`. When all four rows are fallback, append the footer line `all four dimensions using global config from ~/.insrc/config.json`. — ↩ rollbackable
5. Extend src/insrc/cli/commands/__tests__/config-set.test.ts (or add a sibling config-list.test.ts, whichever the existing convention prefers when the module lands) with the unit + integration tests from s6 covering every acceptance mapping and every error case from s5. — ↩ rollbackable
6. Update the docs stub s2 introduced (docs/config.md or the setup-wizard-linked doc) with a brief mention of `insrc config list` including the four-row output shape example. — ↩ rollbackable

**Backward compat:** The `list` subcommand is purely additive. The `set` subcommand from s2 is unchanged. Existing insrc CLI subcommands (daemon / repo / setup / workflow) are unchanged. Users who never run `insrc config list` see zero difference. sc1's on-disk shape is not modified; the daemon reader (s1 LLD) continues to read the same file the same way — s3 is READ-ONLY and never writes.

## Alternatives considered

### a1: Sparse list — present-dimensions only + no-overrides banner

Print one line per dimension present in the override file; when the file is missing/empty, print a single explicit line stating no overrides are set and global will be used.

The `list` action reads ~/.insrc/repos/<slug>/config.json. When the file exists and has at least one dimension, print one line per present dimension: `<dimension>: <value>` (aligned columns for readability). When the file is missing, empty, or parses to an empty object, print exactly one line: `no per-repo overrides on <repoPath>; using global config from ~/.insrc/config.json`.

Dimensions NOT in the file are omitted from the output. The output is tight: only what is actively overriding shows up.

**Rejected because:** Fully satisfies but its output length varies (0 rows for missing, 1-4 for partial) which is harder for a shell script to consume than a2's fixed four-row shape. The 'sparse' output is easier at a glance for humans with one override active, but a2's fixed shape is more consistent — and the four rows are not visual noise (~40 chars each).

### a2: Full-table list — all four dimensions with (global fallback) markers — **CHOSEN**

Print all four sc1 dimensions on every invocation; per-repo values inline, missing dimensions show `(global fallback)` verbatim.

The `list` action reads the override file and prints a four-row table: one row per sc1 dimension in the fixed order (embeddingModel, embeddingDim, coreModel, shaperModel). Each row is either `<dimension>: <per-repo value>` or `<dimension>: (global fallback)`. When the file is missing/empty, ALL four rows show `(global fallback)` — the ac2 requirement is satisfied without a separate banner because the output itself is unambiguous.

Optionally, the table gets a header line `# per-repo overrides on <repoPath>` for context.

### a3: JSON-only output — print the raw override file

cat-equivalent — print the JSON in the override file as-is (pretty-formatted); when file is missing, print `{}` with a stderr note that no overrides are set.

The `list` action reads the override file and writes its content to stdout as pretty-printed JSON. When the file exists, output is the file's JSON body. When the file is missing, output is `{}` on stdout with a note on stderr: `no per-repo overrides on <repoPath>; using global config`. This is the shape of `insrc workflow gh-config`-style commands where JSON is the primary output.

**Rejected because:** Two partials (ac2 + k2) both trace to the same root cause: the explanatory 'no overrides; using global' text lives on stderr while ac2/k2 want it in the primary output. Piping-friendliness is nice but does not offset the ac2 partial. A `--json` flag could layer a3 on top of a2 later without the ac2 downgrade.

## Citations

- **[[c1]]** `prior-artifact` `.insrc/artifacts/LLD-cd479e1361d35cfc-s2.json (register*Commands convention + writeAtomic + sc1 file path)` — "s2 LLD grounded register*Commands(program: Command): void pattern across daemon.ts:18-45, repo.ts:10-27, workflow.ts:52-293. writeAtomic at src/insrc/workflow/storage.ts:62-73 is the atomic write-then"
- **[[c2]]** `code` `src/insrc/db/repos.ts:213-222:listRepos` — "listRepos(_db: DbClient): Promise<RegisteredRepo[]> — returns the registered repo list; shared not-registered-repo check across `set` (s2) and `list` (s3)."
