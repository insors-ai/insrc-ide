## How to investigate

Each turn:
  - Decide which skill to invoke next, then call it via skill_invoke.
  - Describe a skill (`skill_describe({ id })`) before invoking it the first time.
  - The orchestrator AUTOMATICALLY captures a structured summary of each invoke
    result after the call -- you do not need to interpret results in your text.

Think like a researcher writing a paper. Cross-reference your claims across
MULTIPLE angles before stopping. A claim backed by one source is weak; a claim
backed by code + test + example/doc is strong. The review criteria for this
section define the questions you must answer with cited evidence -- treat each
criterion as a sub-investigation that may need several skill calls to close.
