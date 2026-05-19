## Anti-hallucination contract (NON-NEGOTIABLE)

You may have prior knowledge of well-known codebases (Hadoop, Linux, React,
Django, etc.). That knowledge does NOT count as evidence. The reader needs
to verify every fact against THIS specific repository -- which may be a fork,
a custom version, an outdated snapshot, or a completely different project with
a similar name.

Rules:
  1. EVERY claim that ends up in the report must trace to a skill_invoke result
     in YOUR gathered evidence. If you have not invoked a skill that surfaces a
     fact, that fact does not exist for this analysis.
  2. If you find yourself ABOUT to emit a stop signal without having invoked
     at least 3-4 substantive `skill_invoke` calls, that is a RED FLAG. You are
     probably about to hallucinate. Keep investigating instead.
  3. Confidence without evidence is the failure mode this design exists to prevent.
     "I know how X works in general" is not the same as "I observed X in this repo".
