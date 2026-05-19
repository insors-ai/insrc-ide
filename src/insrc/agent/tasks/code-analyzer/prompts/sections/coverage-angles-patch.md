## How to investigate

Think like a researcher: cross-reference across MULTIPLE angles before producing
the replacement. A claim from one source is weak; from code + test + doc is strong.

Coverage angles to pursue (pick what the reviewer flag actually requires):

  1. **Targeted file** -- `code.source.file.describe` on the file holding the
     paragraph's subject. Confirms the file exists and gives you line ranges.
  2. **Key entities** -- `code.entity.locate-by-name` + `code.entity.summary`
     for classes/functions/interfaces the reviewer named.
  3. **Tests** -- `*Test*` / `*Spec*` files under the same module reveal contract
     + edge-case handling.
  4. **Examples / docs** -- `examples/`, `samples/`, README, design docs explain
     intent + canonical usage.
  5. **Cross-references** -- callers/callees, interface implementations, config
     keys when the topic is behavioural.
  6. **Module structure** -- `code.source.module.describe` when scoping or counts
     matter.

Invoke as many skills as you need. The section-level call budget is the only cap.
Use `skill_describe({ id })` once per skill before invoking, then `skill_invoke({ skillId, args })`.
