/**
 * Anti-fabrication rules block shared across writers.
 *
 * First shipped in commit `e4f8ca7e41b` as the SYSTEM_PROMPT
 * extension to shape-resolver after the 5th live run produced a
 * report that hallucinated INGRN's class structure. Promoted to a
 * composer here so build-context, sketch, decide-next-step and
 * future writers can reuse the exact same anti-fabrication contract
 * without copy-paste drift.
 *
 * Sections:
 *
 *   - The header (`## ANTI-FABRICATION RULES (CRITICAL)`).
 *   - The five rule bullets covering: never-invent identifiers;
 *     locate-first dependency; "omit" means key ABSENT; structured-
 *     array anti-pattern; retry behaviour; empty-args handling.
 *   - The three worked examples at the END (qwen3.6 recency-weighted
 *     attention catches them last).
 *
 * Returned as a single string ready to splice into a prompt array.
 */
export function renderAntiFabricationRules(): string {
	return ANTI_FABRICATION_RULES_BLOCK;
}

const ANTI_FABRICATION_RULES_BLOCK = [
	'## ANTI-FABRICATION RULES (CRITICAL)',
	'',
	'  - NEVER invent identifier values. `entityId`, content hashes, file',
	'    paths, repo roots, line numbers, and exact class / field names',
	'    MUST appear verbatim in the AVAILABLE PRIOR OUTPUTS section.',
	'    Do not synthesize plausible-looking hex strings. Do not use a',
	'    class name (e.g. "INGRN") where the schema asks for a 32-char',
	'    hex entityId. Do not invent placeholder ids like `000...001`',
	'    or fresh hex from nowhere.',
	'',
	'  - Locate-first dependency: when an arg requires an entityId or any',
	'    other lookup-derived value and no prior output supplied it, you',
	'    are looking at a missing prerequisite, NOT an opportunity to',
	'    guess. The right move is to OMIT the unfillable arg from your',
	'    `input` (yes, even if it is in `required`). The orchestrator',
	'    will detect the gap, surface a leaf failure, and re-plan to',
	'    insert the missing locate-by-name / extract step. A hallucinated',
	'    value contaminates the investigation more than a missing one.',
	'',
	'  - "Omit" means the key is ABSENT from the JSON object. Do NOT emit',
	'    an empty string `""`, an empty array `[]`, null, "unknown",',
	'    "TBD", or any placeholder value to satisfy the type. The',
	'    downstream schema validator distinguishes "key missing" from',
	'    "key present with empty value" and only the former triggers the',
	'    correct re-plan behaviour.',
	'',
	'  - Structured array args (e.g. `classFields`, `dataShape`, `columns`)',
	'    must be lifted whole from ONE prior output that ACTUALLY PRODUCED',
	'    THAT EXACT KIND OF DATA. Critical anti-pattern: when the only',
	'    available prior output is a JSON data shape (from',
	'    `data.source.file.sample-shape` / `.describe`), you CANNOT use',
	'    it as `classFields`. Class fields come from',
	'    `code.class.extract-fields` calls; data shape comes from data',
	'    source calls. They describe different objects. Copying a data',
	'    shape into `classFields` -- even with matching `{name, type,',
	'    nullable}` keys -- is the canonical fabrication bug. The JSON',
	'    keys `grn_number`, `vendor_details`, `sku_details` are NOT',
	'    Pydantic field names; if a `code.class.extract-fields` prior',
	'    output is absent, OMIT `classFields`.',
	'',
	'  - On a RETRY CORRECTION asking for missing keys, populate them ONLY',
	'    from literal prior-output values. The instruction to "populate',
	'    every required key" never overrides the anti-fabrication rules.',
	'',
	'  - Empty `args: {}` is almost always wrong, BUT it is correct when',
	'    every required key requires fabrication -- omission beats',
	'    invention every time.',
	'',
	'## WORKED EXAMPLES (read carefully)',
	'',
	'Example A -- entityId IS in a prior output:',
	'  Prior output `locate`: `{"entityId":"b2097ef0ba38110e005d437d6b0c8442","name":"INGRN"}`',
	'  Schema requires `entityId` (32-hex), `scope` (optional).',
	'  CORRECT input: `{"entityId":"b2097ef0ba38110e005d437d6b0c8442"}`',
	'',
	'Example B -- entityId is NOT in any prior output:',
	'  Prior outputs contain only the class NAME "INGRN" and a file path,',
	'  no 32-char hex entityId anywhere.',
	'  Schema requires `entityId` (32-hex), `scope` (optional).',
	'  CORRECT input: `{}` -- the entityId key is ABSENT.',
	'  WRONG: `{"entityId":""}`     (empty string is still a value)',
	'  WRONG: `{"entityId":"INGRN"}` (class name is not a hex id)',
	'  WRONG: `{"entityId":"00000000000000000000000000000042"}` (placeholder hex)',
	'  WRONG: `{"entityId":"deadbeefdeadbeefdeadbeefdeadbeef"}` (fresh-from-nowhere hex)',
	'  The orchestrator will detect the missing entityId, surface a leaf',
	'  failure, and insert a `code.entity.locate-by-name` step on re-plan.',
	'',
	'Example C -- classFields with no extract-fields prior output:',
	'  Prior output `sample-shape` (from data.source.file.sample-shape):',
	'  `[{"path":"grn_number","type":"string"}, {"path":"vendor_details","type":"object"}]`',
	'  Schema requires `className`, `classFields`, `dataShape`.',
	'  CORRECT input: `{"className":"INGRN","dataShape":[...lift verbatim...]}`',
	'    -- `classFields` key is ABSENT because no code.class.extract-fields',
	'    output exists.',
	'  WRONG: `{"className":"INGRN","classFields":[{"name":"grn_number",...}],...}`',
	'    -- those are JSON keys masquerading as Pydantic class fields.',
	'  WRONG: `{"className":"INGRN","classFields":[],...}`',
	'    -- empty array is not omission.',
].join('\n');
