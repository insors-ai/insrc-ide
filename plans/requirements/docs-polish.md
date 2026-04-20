# Docs + polish (stage 8)

Small, focused commits that ship alongside / immediately after the
last feature commit. No functional surface area -- documentation,
shortcuts, release-notes.

## Files

| File | Change |
|---|---|
| `CLAUDE.md` | Add Requirements agent entry under "### Other agents" / "### Intent routing" |
| `README.md` | Mention Requirements agent alongside Brainstorm, Pair, Delegate in the "Agent System" section |
| `design/agent.html` | Add Requirements agent node to the overall agent architecture diagram (if it has one; otherwise add a section link) |
| `src/vs/workbench/contrib/insrc/browser/requirements/requirementsCommands.ts` | Default keybinding for `insrc.openRequirementsTree` (`Ctrl+Alt+R` on Linux/Win, `Cmd+Alt+R` on macOS) -- only if the key isn't already bound |
| `CHANGELOG.md` or release notes | A breaking-change entry for the `requirements` intent re-routing from Designer to the new agent |

## CLAUDE.md entries

Under `## Intent taxonomy -- Intent routing`:

```markdown
- `requirements`: Requirements agent (iterative scope decomposition + Epic / Story authoring, writes to <repo>/requirements/, optional push to GitHub). See design/requirements-agent.html.
```

Update the line that currently says `requirements` routes to Designer
(the existing line, if any, gets replaced).

Under `## Other agents` near the Designer / Planner entries:

```markdown
- **Requirements**: Iterative scope decomposition. Two-tier model
  (Epic -> Story). Writes HTML or MD to <repo>/requirements/.
  Optional GitHub push with schema reconciliation. Brainstorm agent
  hands off to this on finalize.
```

## README.md entries

Under `### Agent System`:

```markdown
- **Requirements agent** -- iterative scope decomposition into Epics
  + Stories, writes structured HTML/MD under
  <project>/requirements/, optional push to GitHub Issues + Projects
  v2 with schema reconciliation.
```

Under `### Chat Panel` in the provider-mention bullet list, no change
needed -- `@requirements` already works via the existing mention
grammar (provider != agent; intent override happens via `/intent
requirements ...`).

## Release notes -- breaking change

The only breaking change is: `requirements` intent no longer routes
to the Designer agent. Users who used `/intent requirements ...`
to get an architecture-first output now get a feature-spec Epic +
Story workflow.

Migration: `/intent design <same prompt>` for the old Designer
behavior. Include an example in the release notes.

## Keybinding

Add a default keybinding in
`src/vs/workbench/contrib/insrc/browser/requirements/requirementsCommands.ts`:

```typescript
KeybindingsRegistry.registerCommandAndKeybindingRule({
  id: 'insrc.openRequirementsTree',
  weight: KeybindingWeight.WorkbenchContrib,
  primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyR,
  // Confirm 'R' is free; if not, adjust. Check the existing
  // keybinding registry for conflicts.
  when: undefined,
  handler: openRequirementsTree,
});
```

If `Ctrl+Alt+R` collides with an existing binding, fall back to not
setting a default -- users can bind manually in keyboard shortcuts.

## Verification

- `CLAUDE.md` updated; no stale reference to Designer handling
  `requirements`.
- `README.md` lists Requirements agent in the Agent System section.
- Command palette shows `insrc: Open Requirements Tree` entry.
- Default keybinding bound (if a free key was found).
- Release-notes draft included in the commit for the eventual
  version tag.

## Commit boundary for stage 8

One commit total: `docs(requirements-agent): land docs + polish`.
Includes CLAUDE.md, README.md, keybinding, release-notes snippet.
