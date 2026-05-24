/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * scripts/audit-guard-events.ts
 *
 * Aggregate tool-call-guard events from a daemon log file into a
 * summary table.
 *
 * Usage:
 *   npx tsx scripts/audit-guard-events.ts [<log-file>]
 *
 * Reads from stdin when no file is provided. Outputs a markdown-
 * formatted breakdown:
 *
 *   - Total guard events seen
 *   - Coerce counts by category (separator-normalization, fuzzy
 *     match, arg rename, scalar -> array)
 *   - Reject counts by category (unknown tool, missing required,
 *     unexpected property, type mismatch)
 *   - Top skills by guard activity
 *   - Estimated round-trips saved (1 per non-pass outcome)
 */

import { readFile } from 'node:fs/promises';
import { argv } from 'node:process';

// ---------------------------------------------------------------------------
// Parser -- pure, testable
// ---------------------------------------------------------------------------

export interface GuardSummary {
	totalEvents:        number;
	coerced:            number;
	rejected:           number;
	coerceCategories:   Record<string, number>;
	rejectCategories:   Record<string, number>;
	skillsTouched:      Record<string, number>;
	estimatedRoundTripsSaved: number;
}

const COERCE_MSG = 'tool-call-guard: coerced before dispatch';
const REJECT_MSG = 'tool-call-guard: pre-dispatch schema check rejected the call';

export function summarizeGuardEvents(lines: readonly string[]): GuardSummary {
	const summary: GuardSummary = {
		totalEvents:        0,
		coerced:            0,
		rejected:           0,
		coerceCategories:   {},
		rejectCategories:   {},
		skillsTouched:      {},
		estimatedRoundTripsSaved: 0,
	};

	for (const line of lines) {
		if (line.trim().length === 0) {
			continue;
		}
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}

		const msg = entry['msg'];
		if (typeof msg !== 'string') {
			continue;
		}

		if (msg === COERCE_MSG) {
			summary.totalEvents++;
			summary.coerced++;
			summary.estimatedRoundTripsSaved++;
			countCoerceCategories(entry, summary);
			incSkill(entry['resolvedName'], summary);
		} else if (msg === REJECT_MSG) {
			summary.totalEvents++;
			summary.rejected++;
			summary.estimatedRoundTripsSaved++;
			countRejectCategories(entry, summary);
			incSkill(entry['resolvedName'], summary);
		}
	}

	return summary;
}

function countCoerceCategories(entry: Record<string, unknown>, summary: GuardSummary): void {
	const notes = Array.isArray(entry['notes']) ? entry['notes'] as unknown[] : [];
	for (const n of notes) {
		if (typeof n !== 'string') {
			continue;
		}
		if (n.includes('separator normalization')) {
			inc(summary.coerceCategories, 'name-separator');
		} else if (n.includes('fuzzy match')) {
			inc(summary.coerceCategories, 'name-fuzzy');
		} else if (n.startsWith('renamed arg')) {
			inc(summary.coerceCategories, 'arg-rename');
		} else if (n.startsWith('skipped rename')) {
			inc(summary.coerceCategories, 'arg-rename-skip');
		} else if (n.includes('scalar to single-element array')) {
			inc(summary.coerceCategories, 'type-array');
		}
	}
}

function countRejectCategories(entry: Record<string, unknown>, summary: GuardSummary): void {
	if (Array.isArray(entry['missing']) && (entry['missing'] as unknown[]).length > 0) {
		inc(summary.rejectCategories, 'missing-required');
	}
	if (Array.isArray(entry['unexpected']) && (entry['unexpected'] as unknown[]).length > 0) {
		inc(summary.rejectCategories, 'unexpected-property');
	}
	if (Array.isArray(entry['typeMismatch']) && (entry['typeMismatch'] as unknown[]).length > 0) {
		inc(summary.rejectCategories, 'type-mismatch');
	}
}

function incSkill(name: unknown, summary: GuardSummary): void {
	if (typeof name !== 'string' || name.length === 0) {
		return;
	}
	inc(summary.skillsTouched, name);
}

function inc(bucket: Record<string, number>, key: string): void {
	bucket[key] = (bucket[key] ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// Renderer -- markdown table
// ---------------------------------------------------------------------------

export function renderSummary(s: GuardSummary): string {
	const lines: string[] = [];
	lines.push('# tool-call-guard event audit');
	lines.push('');
	lines.push(`Total events: **${s.totalEvents}**`);
	lines.push(`  - Coerced (rewritten + dispatched): ${s.coerced}`);
	lines.push(`  - Rejected (skipped dispatch): ${s.rejected}`);
	lines.push(`Estimated round-trips saved: **${s.estimatedRoundTripsSaved}**`);
	lines.push('');

	if (s.coerced > 0) {
		lines.push('## Coercion categories');
		lines.push('| Category | Count |');
		lines.push('|---|---:|');
		for (const [k, v] of sortByCount(s.coerceCategories)) {
			lines.push(`| ${k} | ${v} |`);
		}
		lines.push('');
	}
	if (s.rejected > 0) {
		lines.push('## Rejection categories');
		lines.push('| Category | Count |');
		lines.push('|---|---:|');
		for (const [k, v] of sortByCount(s.rejectCategories)) {
			lines.push(`| ${k} | ${v} |`);
		}
		lines.push('');
	}
	if (Object.keys(s.skillsTouched).length > 0) {
		lines.push('## Top skills by guard activity');
		lines.push('| Skill | Events |');
		lines.push('|---|---:|');
		for (const [k, v] of sortByCount(s.skillsTouched).slice(0, 15)) {
			lines.push(`| ${k} | ${v} |`);
		}
		lines.push('');
	}
	return lines.join('\n');
}

function sortByCount(rec: Record<string, number>): readonly (readonly [string, number])[] {
	return Object.entries(rec).sort((a, b) => b[1] - a[1]);
}

// ---------------------------------------------------------------------------
// CLI -- read stdin or file, write to stdout
// ---------------------------------------------------------------------------

async function readSourceLines(): Promise<readonly string[]> {
	const arg = argv[2];
	if (arg !== undefined && arg.length > 0) {
		const text = await readFile(arg, 'utf8');
		return text.split('\n');
	}
	const chunks: string[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
	}
	return chunks.join('').split('\n');
}

async function main(): Promise<void> {
	const lines = await readSourceLines();
	const summary = summarizeGuardEvents(lines);
	process.stdout.write(renderSummary(summary) + '\n');
}

const isMain = process.argv[1]?.endsWith('audit-guard-events.ts')
	|| process.argv[1]?.endsWith('audit-guard-events.js');
if (isMain) {
	main().catch(err => {
		process.stderr.write(`audit-guard-events: ${(err as Error).message}\n`);
		process.exit(1);
	});
}
