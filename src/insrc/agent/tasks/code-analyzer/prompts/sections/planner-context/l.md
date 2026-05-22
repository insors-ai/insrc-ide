## Decomposition guidance (tier L)

This is a tier-L code analysis -- the scope is a medium-to-large
module. Decompose the work into sections that together answer the
USER REQUEST in depth. The user's actual question is the primary
driver -- the menu below is a **coverage checklist** to make sure no
important axis is missed, NOT a list of section titles to copy.

### How to use the coverage menu

1. **Read the user request first.** What specific module / behaviour
   did they ask about? Which classes / endpoints / data flows are
   named?
2. **Decompose into request-driven sections.** Each section is one
   meaningful slice of the module the user is asking about. Name
   SPECIFIC public entries / submodules / classes from the
   repo-summary block.
3. **Cross-check against the coverage menu BELOW.** For each axis,
   ask "is it touched by any of my planned sections?" If yes,
   fine. If no AND the axis is relevant, add a section.

### Coverage menu (do NOT name sections after these)

  - module functionality + public entry points
  - exposed endpoints (HTTP / message receivers / internal callers)
  - data persistence touches (DB / cache / file stores)
  - dependencies (internal modules + external packages)
  - test coverage of the module's surface
  - deployment artifacts + configuration that affect this module

### Decomposition strategy

Section count is REQUEST-DRIVEN, not tier-driven:

- One section per major submodule / public-entry cluster / dominant
  concern that the request actually touches. The repo-summary names
  the candidate submodules; the request narrows which are in scope.
- Combine thin axes into one section if neither alone justifies its
  own (e.g. "Tests & Configuration" if both are light).
- Reserve dedicated sections for the module's dominant concern (if
  it's persistence-heavy, give persistence its own section).
- A single-question L-tier ask may be fine with 2-3 sections; a
  broad module review may want 5-6. Let the request drive the count,
  not the tier.

### Naming + scope per section

Each section needs:
  - A title that names the MODULE + a specific aspect of it
    (e.g. "Auth Module: Endpoints & Session Lifecycle",
    "Storage Module: Repository Classes & Schema"). NOT generic
    axis labels like "Module Functionality" or "Dependencies".
  - An objective sentence anchored on the named module + aspect.
  - 3-5 specific, scorable review criteria referencing actual
    class / file names visible in the repo summary.
