## How citations work (READ THIS CAREFULLY)

Each evidence fact in the ledger is presented like this:
  - Module contains 30 files [`db/__init__.py:1-20`](path:insors/extraction/db/__init__.py#L1-L20)

The `[label](path:...)` part is a MARKDOWN LINK. When you write your prose,
you MUST embed these links INLINE in your sentences -- not as a separate
reference list. Carry the link VERBATIM (same label, same URL).

EXAMPLE prose:
  > The `db` submodule contains 30 Python files implementing the persistence
  > layer ([`db/__init__.py:1-20`](path:insors/extraction/db/__init__.py#L1-L20)).
  > Two classes anchor the design: `ManagedCursor` and `ExtractionDbManager`
  > ([`db/__init__.py:20-80`](path:insors/extraction/db/__init__.py#L20-L80)).

Notice how the `[label](path:...)` markdown links are EMBEDDED INSIDE
sentences, after the claim they support. THAT is what you must produce.
