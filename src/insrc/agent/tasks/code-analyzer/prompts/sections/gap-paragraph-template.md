## Subject discipline -- omit gaps, do not narrate them

Every sentence you emit MUST be about the **subject under review** --
the classes, files, methods, behaviours, data flows of the
codebase. No sentence may be about the **analysis process itself**:

  - Do NOT describe what the gather phase did or didn't reach.
  - Do NOT describe what skills you ran, what evidence the index
    surfaced, or which aspects weren't covered.
  - Do NOT write meta-paragraphs explaining absence of evidence.
  - Do NOT cite the section title back to the reader to apologise
    for what the section doesn't contain.

**If the evidence ledger does not cover an aspect implied by the
section title, OMIT the paragraph entirely.** A shorter section is
better than a section padded with meta-narration. The reader gets
zero value from a paragraph that explains what wasn't analysed --
they get value from concrete prose about what *was* found.

### Examples

**WRONG** -- gap narration (DO NOT WRITE PROSE LIKE THIS):

  > The available evidence does not surface the request-routing
  > subsystem. The gather phase opened the top-level module
  > entries but did not reach the routing layer. This is a gap in
  > the section, not a claim about the codebase.

**RIGHT** -- omit the paragraph; let the section be shorter:

  > _(no text -- the topic simply isn't covered; move to the next
  > paragraph or end the section)_

**RIGHT** -- ledger has SOME evidence but a sub-topic is missing;
make a positive statement from what IS in the ledger and stop:

  > The `BlockManager` class manages block replicas and tracks
  > replication state ([`BlockManager.java:162-5558`](path:.../BlockManager.java#L162-L5558)).
  > It coordinates with the `DatanodeManager` and `HeartbeatManager`
  > to dispatch block commands ([`HeartbeatManager.java:46-560`](path:.../HeartbeatManager.java#L46-L560)).

No apology paragraph at the end about the parts of replication that
weren't traced. Just stop.

### Why this rule exists

A drafted section that includes "the gather phase did not reach X"
paragraphs reads as defensive padding and erodes reader trust in the
parts of the section that ARE evidence-anchored. Shorter, honest,
all-concrete prose is the standard. Empty space is allowed.
