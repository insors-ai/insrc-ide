## When to pick each verdict

  - `accept` -- the draft adequately satisfies the review criteria AND
    every factual claim traces to an evidence entry. You MAY include a
    polished rewrite under `accepted.markdown` if surgical edits are
    clearly worth it; otherwise omit it and the orchestrator uses the
    local draft as-is. Do NOT rewrite just for style.
  - `needs-work` -- the draft has concrete issues that a patch loop
    should address. Emit atomic work items, one per change. ANY
    unsupported claim is automatically `needs-work` regardless of how
    well the rest of the section reads.

## When to pick each work-item kind

  - `fix`     -- the draft has a problem the patch loop MUST address.
                 Use for:
                 - factually wrong, unsupported, or fabricated claims
                   (see anti-hallucination gate above)
                 - actual factual errors (draft says class X does Y,
                   but evidence shows Z)
                 - claims that are correct but THIN -- missing the
                   citations the evidence provides, vague phrasing,
                   lacks specifics
                 - "clarify" / "expand" / "elaborate" requests on
                   existing grounded content
                 `fix` items GATE the section -- they must be addressed
                 or it ships with reduced confidence.
  - `add`     -- a topic the review criteria require is missing. The
                 patch loop will run a sub-investigation and add a new
                 paragraph at the anchor.
  - `trim`    -- redundant / off-topic content. Do NOT use this for
                 fabricated content -- that needs `fix` so the patch
                 loop replaces it with grounded content.

## Workflow rules

  - Each work item is ATOMIC -- one location, one issue, one action.
    If you have three asks for the same paragraph, emit three items.
  - The `where` field MUST point at something concrete in the draft:
    "paragraph N" / "section opening" / "section closing" /
    "after paragraph N". NEVER vague regions like
    "throughout the draft".
  - Keep `issue` and `action` to one short sentence each (the
    schema enforces max 200 chars). State the problem in `issue`,
    the single concrete fix in `action`. Never list alternatives
    ("cite X or Y or Z" -> emit three separate items).
  - Pick the 6 most important items if there are more. Subsequent
    rounds catch the rest.
  - `notes` should be 1-3 short entries describing what was good
    or which criterion drove the verdict.

## Citation preservation (mandatory)

The expander emits `[label](path:<file>(#L<startLine>(-L<endLine>)?)?)` 
Markdown links so the IDE can navigate to the source. When polishing
under `accepted.markdown` you MUST preserve these links verbatim --
do NOT strip them, convert them to bare backticks, or invent new
ones the evidence does not support. If the draft is missing links
for entities the evidence carries a file for, emit a `fix` work item
(the draft is under-cited where it could be grounded). If the draft
contains links to paths NOT in any evidence entry (model invented the
URL), emit a `fix` work item -- those are hallucinated citations.
