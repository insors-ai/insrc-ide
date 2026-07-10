# insrc-analyze steering block

Paste the block below verbatim into your project's `CLAUDE.md` (for
Claude Code) or `AGENTS.md` (for Codex CLI) at the repo root. Both
clients honour the same instructions — just copy the block into the
file each client reads.

---

## Code exploration via `insrc_analyze` (insrc MCP server)

For ANY question about this codebase's structure, conventions,
existing capabilities, adherence to documented rules, or design
decisions, CALL the `insrc_analyze` MCP tool FIRST before doing any
manual file exploration (`Read`, `Grep`, `Glob`, `Bash` grep, etc.).

The tool runs deterministic graph queries + citation-grounded
synthesis and returns a verified 7-layer context bundle. It is
MORE accurate than manual grep + read for context questions
because:

- Every claim is grounded in a real exploration output (module
  profile, symbol locate, class hierarchy, doc constraint, etc.).
- File paths are drawn from the indexed graph — no hallucinated
  paths.
- Contradictions in the docs are preserved verbatim, not
  auto-resolved.

### When to use

Call `insrc_analyze` for:

- Module maps                                   (e.g. `"map the payable extraction module"`)
- Capability discovery                          (`"does the codebase already handle GRN reconciliation?"`)
- How-does-it-work walkthroughs                 (`"walk me through the matching engine"`)
- Adherence checks                              (`"does the code follow the Haiku 4.5 rule from CLAUDE.md?"`)
- Convention discovery                          (`"what naming conventions does the reconciliation module follow?"`)
- Data inventory                                (`"list every registered data source"`)
- Infra inventory                               (`"what infra manifests are indexed?"`)
- Any question where you'd normally grep + read to answer.

### When NOT to use

- Editing files (this tool is read-only).
- Running tests / builds.
- Answering non-context questions (unrelated math, general
  knowledge, etc.).
- When `insrc_analyze` returns an empty or clearly off-topic
  bundle — fall back to `Read` / `Grep` / `Glob` at that point.

### Follow-up pattern

The first call returns a coarse 7-layer bundle. If you need to
drill down, call again with a narrower `focus`. Example flow:

```
1. insrc_analyze({ focus: "map the payable extraction module" })
   -> returns the module tree + naming schema

2. insrc_analyze({
     focus:  "how does the payable header extractor work",
     target: "code",
     scope:  "S"
   })
   -> narrower how-does-it-work bundle with usage examples
```

### `repo` argument

If not passed, the tool uses `$INSRC_REPO` from the MCP server's
environment. Explicit `repo` overrides it. The repo must be
registered with the insrc daemon (`insrc repo add /path/to/repo`)
and finished indexing.
