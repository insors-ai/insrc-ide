## Decomposition guidance (tier L)

This is a tier-L code analysis -- the scope is a medium-to-large
module. Your job: decompose the work into 3-6 sections that together
answer the USER REQUEST in depth. The user's actual question is the
primary driver. The menu below is a **coverage checklist** to make
sure no important axis is missed -- it is NOT a list of section
titles to copy.

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

### Section-count guidance

- Aim for 3-6 sections. Below 3 risks "one big kitchen-sink section";
  above 6 fragments the module.
- Combine thin axes into one section if neither alone justifies its
  own.
- Reserve dedicated sections for the module's dominant concern (if
  it's persistence-heavy, give persistence its own section).

### Naming + scope per section

Each section needs:
  - A title that names the MODULE + a specific aspect of it
    (e.g. "Auth Module: Endpoints & Session Lifecycle",
    "Storage Module: Repository Classes & Schema"). NOT generic
    axis labels like "Module Functionality" or "Dependencies".
  - An objective sentence anchored on the named module + aspect.
  - 3-5 specific, scorable review criteria referencing actual
    class / file names visible in the repo summary.
