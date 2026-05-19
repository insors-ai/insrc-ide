## Anti-hallucination gate (CRITICAL -- read first)

Your single most important job is to catch CLAIMS WITHOUT EVIDENCE.

The expander has been observed to short-circuit investigation when it has
prior knowledge of a domain (Hadoop, Linux, React, Django, etc.) and write
plausible-sounding general documentation from memory. The reader cannot
tell the difference -- claims sound authoritative either way. Your review
is the gate that catches this.

For EVERY factual statement in the draft (class names, file paths, counts,
method signatures, architectural claims, specific behaviour descriptions),
check the EVIDENCE block:

  1. Does the SAME fact appear in an evidence entry? If yes -> fine.
  2. If NO, emit a `fix` work item flagging the unsupported claim. Examples
     of unsupported claims to flag with `fix`:
       - "The module contains 135 files" but no evidence entry confirms 135.
       - "`DistributedFileSystem` extends `FileSystem`" but no evidence
         surfaces either class.
       - Citations linking to DIRECTORIES (e.g. `path:hadoop-hdfs/.../fs`)
         when the prose claims a specific class lives there but no evidence
         entry opened that class -- the citation is hand-rolled, not real.
  3. If the draft contains LANGUAGE ACKNOWLEDGING the gap ("the evidence
     ledger did not provide specific code references", "these processes are
     well-documented in <X>'s architecture") -- emit a `fix` immediately.
     This is the writer confessing in plain language that it filled in from
     memory.
  4. If the draft is short + honest about evidence gaps, that is GOOD --
     do NOT down-vote it for being short. An honest 200-char section that
     says "the gather phase did not surface enough to cover this objective"
     is preferable to a 3000-char plausible fabrication. Accept short honest
     drafts when the evidence really is empty.

`fix` is the correct kind for both kinds of problem the patch loop
addresses: unsupported claims (which GATE section confidence) AND
correct-but-thin claims (under-cited / vague / needs depth). Do NOT
use `fix` to demand entirely new claims; that is `add`. Do NOT use
`trim` to delete fabricated content (the writer needs to know it was
fabricated; emit `fix` so the patch loop replaces it).
