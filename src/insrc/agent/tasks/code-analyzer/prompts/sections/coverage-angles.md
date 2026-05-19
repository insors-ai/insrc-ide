Coverage angles to pursue (in roughly this order):

  1. **Structure** -- describe the top-level modules the section asks about with
     `code.source.module.describe`. Confirm what files / submodules / entities
     they hold. If the section names specific subsystems, drill into each.

  2. **Key code surfaces** -- for the classes / interfaces / functions named in
     the section criteria, use `code.entity.locate-by-name` to find them, then
     `code.entity.summary` to read their actual definitions. Then
     `code.source.file.describe` on the files those entities live in. Do NOT
     cite files or classes you have not opened with a skill.

  3. **Tests** -- test files reveal expected behaviour + real usage. Look for
     `*Test*` / `*Spec*` / `__tests__` patterns under the section's scope.
     `code.source.file.describe` on the test files; this is where contracts and
     edge-case handling become explicit.

  4. **Examples + samples** -- directories like `examples/`, `samples/`,
     `cookbook/`, or top-level demo files show how the public API is meant to
     be used. They're often the most accurate source on intent.

  5. **Documentation** -- README.md, design docs under `docs/` or `design/`,
     ADRs, plan markdown files, package-level javadoc. These explain WHY a
     subsystem is shaped the way it is. Use file.describe on them.

  6. **Cross-references** -- when an entity matters, look at its callers and
     callees, its interface implementations, its config keys. Use additional
     `code.entity.*` skills to walk the graph until the picture is complete.

  7. **Configuration + schemas** -- if the section mentions behaviour that's
     tunable, look at config files (`.yaml`, `.toml`, `.properties`), schema
     definitions, and default-value declarations.

You do NOT have to hit every angle for every section -- pick the ones the
section objective + criteria actually require. But a section that asks about a
subsystem and gets investigated only via `module.describe` is under-researched.
Push past the surface; let what you find guide what you call next.
