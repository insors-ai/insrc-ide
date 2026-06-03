/**
 * Walk a skill's `outputs` JSON Schema and emit the set of dotted
 * paths the tree-planner's wiring DSL may reference (P2 of
 * plans/planner-skill-tree.md).
 *
 * Path grammar (kept deliberately small):
 *   - `prop`            -- object property
 *   - `prop.sub`        -- nested object
 *   - `prop[*]`         -- array elements (the whole array, or "each item")
 *   - `prop[*].sub`     -- field on every element of an array of objects
 *
 * NOT supported:
 *   - `prop[N]` (indexed array access)   -- too brittle for planner output
 *   - JSONPath operators (`$`, `..`, filters)
 *   - `additionalProperties` wildcard paths
 *
 * The walker handles `oneOf` / `anyOf` by emitting the union of paths
 * from every variant (a path is admissible if any variant exposes it).
 * It caps recursion depth to bound the output set on pathological
 * schemas; in practice every real skill is well under the cap.
 */

const MAX_DEPTH = 6;
const MAX_PATHS = 256;

/**
 * Extract every wire-addressable dotted path from a JSON Schema. Returns
 * a deduped sorted list; never throws. Caller is expected to pass the
 * skill's full `outputs` schema (an object schema in nearly every case;
 * scalars yield the empty set).
 */
export function extractOutputPaths(schema: unknown): readonly string[] {
	const out = new Set<string>();
	walk(schema, '', 0, out);
	return [...out].sort();
}

function walk(node: unknown, prefix: string, depth: number, out: Set<string>): void {
	if (out.size >= MAX_PATHS) return;
	if (depth > MAX_DEPTH)     return;
	if (node === null || typeof node !== 'object' || Array.isArray(node)) return;

	const s = node as Record<string, unknown>;

	// Union branches: walk every variant. Each variant is a full schema
	// rooted at the same prefix.
	if (Array.isArray(s['oneOf']))   for (const v of s['oneOf']   as unknown[]) walk(v, prefix, depth, out);
	if (Array.isArray(s['anyOf']))   for (const v of s['anyOf']   as unknown[]) walk(v, prefix, depth, out);
	if (Array.isArray(s['allOf']))   for (const v of s['allOf']   as unknown[]) walk(v, prefix, depth, out);

	const type = s['type'];

	// Object: enumerate properties.
	if (type === 'object' || (type === undefined && typeof s['properties'] === 'object')) {
		const props = s['properties'];
		if (props !== null && typeof props === 'object' && !Array.isArray(props)) {
			for (const [key, subSchema] of Object.entries(props as Record<string, unknown>)) {
				const path = prefix === '' ? key : `${prefix}.${key}`;
				out.add(path);
				walk(subSchema, path, depth + 1, out);
			}
		}
	}

	// Array: emit `prefix[*]` then walk the item schema.
	if (type === 'array' || (type === undefined && s['items'] !== undefined)) {
		const items = s['items'];
		if (items !== undefined) {
			const path = `${prefix}[*]`;
			// Don't emit the bare `[*]` at the root (prefix=''); only emit
			// the iteration marker when there's a parent property.
			if (prefix !== '') out.add(path);
			walk(items, path === '' ? '[*]' : path, depth + 1, out);
		}
	}

	// Scalars (string/number/boolean/integer/null) need no further walk
	// -- the path that already names the field is sufficient.
}
