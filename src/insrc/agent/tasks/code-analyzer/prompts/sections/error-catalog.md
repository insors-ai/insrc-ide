## Common failure patterns (read before drafting)

These are the patterns that cause sections to fail review. Writers MUST
avoid them; reviewers MUST flag them. Each pair shows the bad shape on
the left and the corrected grounded shape on the right.

### Paragraph-level failures

❌ FABRICATED PARAGRAPH (do NOT write this)
   "The `DistributedFileSystem` class extends `FileSystem` and provides
    block-level read/write with strong consistency guarantees, with the
    namenode coordinating block allocation across datanodes."
   Why this is wrong: the evidence ledger contains NO entry for
   `DistributedFileSystem`, `FileSystem`, `namenode`, or `datanode`. The
   writer pulled the class names + architectural behaviour from prior
   Hadoop knowledge.

✅ GROUNDED PARAGRAPH (write this shape instead)
   "The `fs` submodule contains 12 Python classes ([`fs/__init__.py:1-40`](path:insors/extraction/fs/__init__.py#L1-L40))
    anchored by `LocalFileSystem`, which the ledger surfaces at
    [`fs/local.py:18-220`](path:insors/extraction/fs/local.py#L18-L220).
    No evidence entry covers distributed-mode classes, so this section
    does not discuss them."
   Why this is right: every named class + count + behaviour traces to
   an evidence citation; the absent topic is acknowledged explicitly
   rather than filled in.

### Citation-level failures

❌ HAND-ROLLED CITATION (do NOT write this)
   "`<SomeClass>` orchestrates the journal ([<module>/.../<subdir>](path:<module>/src/main/java))"
   Why this is wrong: the path points at a DIRECTORY, with no `#L`
   line-range suffix. The writer composed the URL from prior knowledge
   -- the ledger never surfaced this class.

✅ EVIDENCE-BACKED CITATION (write this shape instead)
   "Lookup happens in `<funcName>` ([`<file>:<startLine>-<endLine>`](path:<rel-path>#L<startLine>-L<endLine>))."
   Why this is right: the link points to a file + a specific line range
   that appears verbatim in an evidence entry. Substitute concrete
   `<...>` tokens with names + paths surfaced by your evidence.

❌ FAKE LINE RANGE (do NOT write this)
   "The entire `db` module ([`db/__init__.py:1-500`](path:insors/extraction/db/__init__.py#L1-L500)) ..."
   Why this is wrong: the writer chose `#L1-L500` to suggest "whole
   file" coverage, but no evidence entry contains that line range.

✅ NARROW LINE RANGE FROM EVIDENCE (write this shape instead)
   "The `ManagedCursor` class ([`db/__init__.py:20-80`](path:insors/extraction/db/__init__.py#L20-L80)) ..."
   Why this is right: the line range comes from an actual evidence fact.

### Gap-narration failures (writer)

Both shapes below are WRONG. The right move when evidence is thin
is to OMIT the paragraph entirely -- not to narrate the omission.

❌ LANGUAGE THAT CONFESSES THE GAP (do NOT do this)
   "While the evidence ledger did not provide specific code references
    for this subsystem, these processes are well-documented in Hadoop's
    architecture as follows: ..."
   Why this is wrong: this is the writer telling the reader, in plain
   language, that the paragraph that follows is from prior knowledge,
   not from the evidence. Reviewers MUST flag this immediately -- it
   is a self-incriminating fabrication.

❌ META-NARRATION ABOUT THE GATHER PROCESS (do NOT do this either)
   "The available evidence does not surface the request-routing
    subsystem. The gather phase opened the top-level module entries
    but did not reach the routing layer. This is a gap in the section,
    not a claim about the codebase."
   Why this is wrong: it's still meta-narration about the analysis
   tooling instead of prose about the subject. Reviewers will flag
   it; the Phase 10 tripwire (meta-narrative detector) will force a
   redraft. A short section ending with a concrete evidence-anchored
   sentence is GOOD; a short section ending with a paragraph that
   apologises for what wasn't analysed is NOT.

✅ OMIT THE PARAGRAPH (write this shape instead)
   _(no text -- if the evidence ledger doesn't cover an aspect, drop
   the paragraph; stop the section after the last concrete sentence
   you can ground.)_
   Why this is right: the reader's value comes from concrete
   evidence-anchored claims. A shorter section that ends cleanly is
   better than a padded one with gap-apology paragraphs.
