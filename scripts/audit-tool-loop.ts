/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * scripts/audit-tool-loop.ts
 *
 * Aggregate tool-loop substrate events from a daemon log file into a
 * summary table.
 *
 * Usage:
 *   npx tsx scripts/audit-tool-loop.ts [<log-file>]
 *
 * Reads from stdin when no file is provided. Outputs a markdown-
 * formatted breakdown per consumer label (the `label` field on
 * `ToolLoopInput`):
 *
 *   - Run counts by terminal kind (terminated / dispatched /
 *     no-tools / exhausted / provider-error)
 *   - Exhausted breakdown by reason (turn-cap / degenerate-repeat /
 *     ...-terminated)
 *   - Average turn count per consumer
 *   - Provider error rate per consumer
 *
 * Pinned by log-shape test at
 * src/insrc/agent/__tests__/tool-loop-event-shape.test.ts.
 */

import { readFile } from 'node:fs/promises';
import { argv } from 'node:process';

// ---------------------------------------------------------------------------
// Parser -- pure, testable
// ---------------------------------------------------------------------------

export interface ConsumerStats {
	terminated:        number;
	dispatched:        number;
	noTools:           number;
	exhausted:         number;
	providerError:     number;
	exhaustionReasons: Record<string, number>;
	turnCountSum:      number;
	turnCountSamples:  number;
}

export interface ToolLoopSummary {
	totalRuns:        number;
	perConsumer:      Record<string, ConsumerStats>;
}

const TERMINATED_MSG    = 'tool-loop: complete (terminated)';
const DISPATCHED_MSG    = 'tool-loop: complete (dispatched -- stopOnFirstDispatch)';
const NO_TOOLS_MSG      = 'tool-loop: complete (no-tools)';
const EXHAUSTED_MSG     = 'tool-loop: complete (exhausted -- turn cap)';
const DEGENERATE_MSG    = 'tool-loop: degenerate-repeat -- exhausting';
const PROVIDER_ERR_MSG  = 'tool-loop: provider error -- bubbling up';

const TERMINAL_MSGS = new Set([
	TERMINATED_MSG, DISPATCHED_MSG, NO_TOOLS_MSG, EXHAUSTED_MSG, DEGENERATE_MSG, PROVIDER_ERR_MSG,
]);

export function summarizeToolLoopEvents(lines: readonly string[]): ToolLoopSummary {
	const summary: ToolLoopSummary = { totalRuns: 0, perConsumer: {} };

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
		if (typeof msg !== 'string' || !TERMINAL_MSGS.has(msg)) {
			continue;
		}
		const label = typeof entry['label'] === 'string' && (entry['label'] as string).length > 0
			? entry['label'] as string
			: '<unlabeled>';
		const stats = ensureConsumer(summary, label);
		summary.totalRuns++;

		const turnCount = typeof entry['turnCount'] === 'number' ? entry['turnCount'] : 0;
		if (turnCount > 0) {
			stats.turnCountSum += turnCount;
			stats.turnCountSamples++;
		}

		switch (msg) {
			case TERMINATED_MSG:
				stats.terminated++;
				break;
			case DISPATCHED_MSG:
				stats.dispatched++;
				break;
			case NO_TOOLS_MSG:
				stats.noTools++;
				break;
			case EXHAUSTED_MSG: {
				stats.exhausted++;
				// Exhausted-turn-cap is the default reason for this log
				// line; other exhaustion reasons (degenerate-repeat,
				// *-terminated) emit different log msgs and never reach
				// here. Use 'turn-cap' as the bucket.
				inc(stats.exhaustionReasons, 'turn-cap');
				break;
			}
			case DEGENERATE_MSG:
				stats.exhausted++;
				inc(stats.exhaustionReasons, 'degenerate-repeat');
				break;
			case PROVIDER_ERR_MSG:
				stats.providerError++;
				break;
		}
	}

	return summary;
}

function ensureConsumer(summary: ToolLoopSummary, label: string): ConsumerStats {
	let s = summary.perConsumer[label];
	if (s === undefined) {
		s = {
			terminated:        0,
			dispatched:        0,
			noTools:           0,
			exhausted:         0,
			providerError:     0,
			exhaustionReasons: {},
			turnCountSum:      0,
			turnCountSamples:  0,
		};
		summary.perConsumer[label] = s;
	}
	return s;
}

function inc(bucket: Record<string, number>, key: string): void {
	bucket[key] = (bucket[key] ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// Renderer -- markdown table
// ---------------------------------------------------------------------------

export function renderSummary(s: ToolLoopSummary): string {
	const lines: string[] = [];
	lines.push('# tool-loop event audit');
	lines.push('');
	lines.push(`Total runs across all consumers: **${s.totalRuns}**`);
	lines.push('');

	const labels = Object.keys(s.perConsumer).sort((a, b) => {
		const ta = totalForConsumer(s.perConsumer[a]!);
		const tb = totalForConsumer(s.perConsumer[b]!);
		return tb - ta;
	});

	if (labels.length === 0) {
		lines.push('_(no tool-loop events found in input)_');
		return lines.join('\n');
	}

	lines.push('## Per-consumer outcomes');
	lines.push('| Consumer | Runs | Terminated | Dispatched | No-tools | Exhausted | ProviderErr | Avg turns |');
	lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
	for (const label of labels) {
		const c = s.perConsumer[label]!;
		const runs = totalForConsumer(c);
		const avgTurns = c.turnCountSamples > 0
			? (c.turnCountSum / c.turnCountSamples).toFixed(2)
			: '-';
		lines.push(
			`| ${label} | ${runs} | ${c.terminated} | ${c.dispatched} | ${c.noTools} | ${c.exhausted} | ${c.providerError} | ${avgTurns} |`,
		);
	}
	lines.push('');

	// Per-consumer exhaustion reason breakdown (only emit when any
	// consumer had an exhausted run).
	const hasExhaustion = labels.some(l => s.perConsumer[l]!.exhausted > 0);
	if (hasExhaustion) {
		lines.push('## Exhaustion reasons (per consumer)');
		lines.push('| Consumer | Reason | Count |');
		lines.push('|---|---|---:|');
		for (const label of labels) {
			const c = s.perConsumer[label]!;
			if (c.exhausted === 0) {
				continue;
			}
			const reasons = Object.entries(c.exhaustionReasons).sort((a, b) => b[1] - a[1]);
			for (const [reason, count] of reasons) {
				lines.push(`| ${label} | ${reason} | ${count} |`);
			}
		}
	}

	return lines.join('\n');
}

function totalForConsumer(c: ConsumerStats): number {
	return c.terminated + c.dispatched + c.noTools + c.exhausted + c.providerError;
}

// ---------------------------------------------------------------------------
// CLI
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
	const summary = summarizeToolLoopEvents(lines);
	process.stdout.write(renderSummary(summary) + '\n');
}

const isMain = process.argv[1]?.endsWith('audit-tool-loop.ts')
	|| process.argv[1]?.endsWith('audit-tool-loop.js');
if (isMain) {
	main().catch(err => {
		process.stderr.write(`audit-tool-loop: ${(err as Error).message}\n`);
		process.exit(1);
	});
}
