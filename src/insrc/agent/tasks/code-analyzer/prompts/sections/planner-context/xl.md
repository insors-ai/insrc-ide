## Decomposition guidance (tier XL+)

This is a tier-XL+ code analysis -- the scope is a full repository or
a large module. Decompose the work into sections that together answer
the USER REQUEST in depth. The user's actual question is the primary
driver -- the menu below is a **coverage checklist** to make sure no
important axis is missed, NOT a list of section titles to copy.

### How to use the coverage menu

1. **Read the user request first.** What specifically did they ask
   for? Which subsystems / files / behaviours are named? An "analyze
   HDFS" request demands HDFS-internal sections (NameNode, DataNode,
   client read/write pipelines). A generic "analyze this repo" request
   demands broader subsystem-by-subsystem sections.
2. **Decompose into request-driven sections.** Each section is one
   meaningful slice of the actual codebase the user is asking about.
   Name SPECIFIC subsystems / modules / packages from the
   repo-summary block in the context.
3. **Cross-check against the coverage menu BELOW.** For each menu
   item, ask "is this axis touched by any of my planned sections?"
   If yes, fine. If no AND the axis is relevant to the user request,
   add a section. If the axis isn't relevant (e.g. user asked about
   one isolated subsystem -- "deployment" may be out of scope),
   drop it.

### Coverage menu (do NOT name sections after these)

These are the AXES a tier-XL+ report should typically touch. Section
titles should reference concrete subsystems / modules from the repo,
not these axis labels.

  - what the codebase does at the top level (functional overview)
  - language(s) / runtime / frameworks / build system
  - architecture + code organization (module split, naming)
  - data persistence (DBs, caches, file stores, ORMs)
  - configuration framework (where config comes from, how it loads)
  - public entry points (HTTP / messaging / CLI / gRPC / RPC)
  - testing framework + coverage approach
  - deployment + build artifacts
  - external dependencies + third-party libraries

### Decomposition strategy

Section count is REQUEST-DRIVEN, not tier-driven:

- One section per top-level subsystem / package / layer that the
  request actually touches. The repo-summary names the candidate
  subsystems; the request narrows which are in scope.
- The decomposition should reflect the codebase's NATURAL structure
  (subsystems, modules, layers), not a 1:1 mapping of the menu.
- Reserve dedicated sections for the high-risk / high-complexity
  areas the user is most likely interested in.
- A targeted "analyze just X subsystem in this big repo" question
  is allowed to return 2-3 sections; a "give me a full architectural
  survey" question naturally fans out to many more. Let the question
  shape the count -- do not pad to the safety ceiling.

### Naming + scope per section

Each section needs:
  - A title that names a SPECIFIC SUBSYSTEM, MODULE, or COMPONENT
    from the codebase (read the repo-summary block in the user
    message). Examples of good titles for a Hadoop-HDFS analysis:
    "NameNode Server & Metadata Management",
    "DataNode Block Management & Replication Protocol",
    "HDFS Client Read & Write Pipelines",
    "RPC Protocol Definitions (ClientNameNodeProtocol, DatanodeProtocol)".
    Examples of BAD titles (these are menu axes, not subsystems):
    "Functional Overview", "Technology Stack", "Testing Framework",
    "External Dependencies". If your title looks like a menu axis
    re-typed, rewrite it to name what's actually in the repo.
  - An objective sentence describing what the section's content will
    cover, anchored on the named subsystem.
  - 3-5 review criteria -- concrete checks the reviewer can score
    against (e.g. "Names the persistence client(s) used and the table
    or file-system layout"), preferably referencing CLASS NAMES /
    file paths visible in the repo summary.
