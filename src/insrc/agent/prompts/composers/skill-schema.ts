/**
 * Render a skill's input schema as a compact JSON block embedded in
 * a prompt. Used by shape-resolver to surface the authoritative
 * arg-shape contract.
 *
 * Pretty-printed (2-space indent) so the model sees `required`
 * arrays + property descriptions clearly. Stable key ordering --
 * `type`, `required`, `properties` appear in that order even if the
 * source object had a different insertion order.
 */
export function renderSkillSchema(schema: Record<string, unknown>): string {
	const reordered = reorderSchemaKeys(schema);
	return JSON.stringify(reordered, null, 2);
}

const KEY_ORDER = ['type', 'required', 'additionalProperties', 'properties', 'items', 'enum', 'minLength', 'maxLength', 'minimum', 'maximum', 'description'] as const;

function reorderSchemaKeys(obj: unknown): unknown {
	if (obj === null || typeof obj !== 'object') {
		return obj;
	}
	if (Array.isArray(obj)) {
		return obj.map(reorderSchemaKeys);
	}
	const o = obj as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	// Known keys first, in canonical order.
	for (const k of KEY_ORDER) {
		if (k in o) {
			out[k] = reorderSchemaKeys(o[k]);
		}
	}
	// Then everything else, in original order.
	for (const k of Object.keys(o)) {
		if (!(k in out)) {
			out[k] = reorderSchemaKeys(o[k]);
		}
	}
	return out;
}
