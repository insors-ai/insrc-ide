/**
 * Shared math + IO contract for `data.pii.detect-patterns.{rdbms,file}`
 * (Phase 5e.1 of plans/analyzers/data-analyzer-skills.md).
 *
 * Built-in PII regex catalog + per-pattern hit count / hit rate /
 * up-to-3 examples. Each pattern is anchored (`^...$`) so the column
 * value must be a single canonical PII token to match -- we tolerate
 * false negatives (a "loose" email regex would match "x@y" which
 * produces many false positives in source-data columns containing
 * usernames with `@` in them).
 */

export interface PiiDetection {
	readonly pattern: string;
	readonly hitCount: number;
	readonly hitRate: number;
	readonly examples: readonly string[];
}

export interface PiiDetectPatternsOutput {
	readonly target: string;
	readonly column: string;
	readonly sampleSize: number;
	readonly detections: readonly PiiDetection[];
	readonly topPattern: string | null;
}

export const PII_PATTERNS: ReadonlyArray<{ readonly name: string; readonly re: RegExp }> = [
	{ name: 'email',           re: /^[\w.+-]+@[\w-]+\.[\w.-]+$/ },
	{ name: 'ssn-us',          re: /^\d{3}-\d{2}-\d{4}$/ },
	{ name: 'phone-us',        re: /^(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}$/ },
	{ name: 'credit-card',     re: /^(?:\d{4}[- ]?){3}\d{4}$/ },
	{ name: 'jwt',             re: /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/ },
	{ name: 'ipv4',            re: /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/ },
	{ name: 'iban',            re: /^[A-Z]{2}\d{2}[A-Z0-9]{4,30}$/ },
	{ name: 'aws-access-key',  re: /^AKIA[0-9A-Z]{16}$/ },
	{ name: 'github-token',    re: /^(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}$/ },
	{ name: 'uuid',            re: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/ },
];

export function clampPiiSample(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return 50;
	return Math.min(Math.max(1, Math.floor(n)), 50);
}

export function buildPiiDetections(
	target: string,
	column: string,
	sample: { columns: readonly string[]; rows: readonly Readonly<Record<string, unknown>>[] },
): { output: PiiDetectPatternsOutput; missingColumn: boolean } {
	if (!sample.columns.includes(column)) {
		return { output: emptyPii(target, column, 0), missingColumn: true };
	}
	const values: string[] = [];
	for (const row of sample.rows) {
		const v = row[column];
		if (v === null || v === undefined) continue;
		values.push(typeof v === 'string' ? v : String(v));
	}
	const actualN = values.length;

	const detections: PiiDetection[] = [];
	for (const { name, re } of PII_PATTERNS) {
		let hits = 0;
		const examples: string[] = [];
		for (const v of values) {
			if (re.test(v)) {
				hits++;
				if (examples.length < 3) examples.push(v);
			}
		}
		if (hits === 0) continue;
		detections.push({
			pattern: name,
			hitCount: hits,
			hitRate: actualN > 0 ? hits / actualN : 0,
			examples,
		});
	}
	detections.sort((a, b) => b.hitRate - a.hitRate || a.pattern.localeCompare(b.pattern));
	const topPattern = detections.length > 0 ? detections[0]!.pattern : null;
	return {
		output: { target, column, sampleSize: actualN, detections, topPattern },
		missingColumn: false,
	};
}

export function emptyPii(target: string, column: string, sampleSize: number): PiiDetectPatternsOutput {
	return { target, column, sampleSize, detections: [], topPattern: null };
}

const DETECTION_SCHEMA = {
	type: 'object',
	properties: {
		pattern:  { type: 'string' },
		hitCount: { type: 'number' },
		hitRate:  { type: 'number' },
		examples: { type: 'array', items: { type: 'string' } },
	},
	required: ['pattern', 'hitCount', 'hitRate', 'examples'],
	additionalProperties: false,
} as const;

export const PII_OUTPUT_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		target:      { type: 'string' },
		column:      { type: 'string' },
		sampleSize:  { type: 'number' },
		detections:  { type: 'array', items: DETECTION_SCHEMA },
		topPattern:  { type: ['string', 'null'] },
	},
	required: ['target', 'column', 'sampleSize', 'detections', 'topPattern'],
	additionalProperties: false,
};
