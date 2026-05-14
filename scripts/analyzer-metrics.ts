/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * scripts/analyzer-metrics.ts
 *
 * Mine the daemon log for `writeSectionWithTools: tool loop complete`
 * events and aggregate the per-section metrics emitted in Phase D.1
 * of `plans/code-analyzer-interleaved-investigation.md`.
 *
 * Use:
 *   npx tsx scripts/analyzer-metrics.ts                       # latest log
 *   npx tsx scripts/analyzer-metrics.ts /tmp/.insrc/agent.5.log
 *   npx tsx scripts/analyzer-metrics.ts /tmp/.insrc/agent.5.log --pid 86071
 *
 * Output: a per-section table + run-level aggregates (median, p90).
 * Compare two runs by capturing the output and diffing:
 *   npx tsx scripts/analyzer-metrics.ts > /tmp/run-A.txt
 *   (restart daemon with the new build, run /code-analyze, then:)
 *   npx tsx scripts/analyzer-metrics.ts > /tmp/run-B.txt
 *   diff /tmp/run-A.txt /tmp/run-B.txt
 *
 * Intentionally a log-miner not a live harness -- the analyzer's
 * IPC + session plumbing is too heavy to drive from a standalone
 * script. Live runs through the IDE produce the same log lines this
 * script reads.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

interface SectionMetrics {
	readonly time: number;
	readonly pid: number;
	readonly actionId: string;
	readonly toolCallCount: number;
	readonly hitLimit: boolean;
	readonly skillsCalled: readonly string[];
	readonly textLength: number;
	readonly paragraphCount: number;
	readonly avgTextLengthPerTurn: number;
	readonly citationCount: number;
	readonly evictionsApplied: number;
	readonly inputTokensFinal: number;
}

const LOG_DIR = '/tmp/.insrc';

function pickLatestLog(): string {
	const files = readdirSync(LOG_DIR)
		.filter(f => /^agent\.\d+\.log$/.test(f))
		.map(f => ({ file: join(LOG_DIR, f), mtime: statSync(join(LOG_DIR, f)).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime);
	if (files.length === 0) {
		throw new Error(`no agent.*.log files under ${LOG_DIR}`);
	}
	return files[0]!.file;
}

function parseArgs(argv: readonly string[]): { logPath: string; pidFilter: number | undefined } {
	let logPath = pickLatestLog();
	let pidFilter: number | undefined;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === '--pid' && argv[i + 1] !== undefined) {
			pidFilter = Number.parseInt(argv[++i]!, 10);
		} else if (!a.startsWith('-')) {
			logPath = a;
		}
	}
	return { logPath, pidFilter };
}

function loadSections(logPath: string, pidFilter: number | undefined): SectionMetrics[] {
	const out: SectionMetrics[] = [];
	for (const line of readFileSync(logPath, 'utf8').split('\n')) {
		if (line.length === 0) {
			continue;
		}
		let j: { [key: string]: unknown };
		try {
			j = JSON.parse(line) as { [key: string]: unknown };
		} catch {
			continue;
		}
		if (j['msg'] !== 'writeSectionWithTools: tool loop complete') {
			continue;
		}
		if (pidFilter !== undefined && j['pid'] !== pidFilter) {
			continue;
		}
		out.push({
			time: j['time'] as number,
			pid: j['pid'] as number,
			actionId: j['actionId'] as string,
			toolCallCount: j['toolCallCount'] as number,
			hitLimit: j['hitLimit'] as boolean,
			skillsCalled: (j['skillsCalled'] as readonly string[]) ?? [],
			textLength: j['textLength'] as number,
			paragraphCount: (j['paragraphCount'] as number) ?? 0,
			avgTextLengthPerTurn: (j['avgTextLengthPerTurn'] as number) ?? 0,
			citationCount: (j['citationCount'] as number) ?? 0,
			evictionsApplied: (j['evictionsApplied'] as number) ?? 0,
			inputTokensFinal: (j['inputTokensFinal'] as number) ?? 0,
		});
	}
	return out;
}

function median(arr: readonly number[]): number {
	if (arr.length === 0) {
		return 0;
	}
	const s = [...arr].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function p90(arr: readonly number[]): number {
	if (arr.length === 0) {
		return 0;
	}
	const s = [...arr].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))]!;
}

function pad(s: string | number, n: number): string {
	return String(s).padStart(n);
}

function formatTable(rows: SectionMetrics[]): string {
	const lines: string[] = [];
	lines.push(
		pad('actionId', 36) + ' ' +
		pad('iters', 5) + ' ' +
		pad('skillsK', 7) + ' ' +
		pad('text', 6) + ' ' +
		pad('paras', 5) + ' ' +
		pad('avg/p', 5) + ' ' +
		pad('cites', 5) + ' ' +
		pad('evict', 5) + ' ' +
		pad('tok', 6) + ' ' +
		'hit',
	);
	lines.push('-'.repeat(96));
	for (const r of rows) {
		lines.push(
			pad(r.actionId.slice(0, 36), 36) + ' ' +
			pad(r.toolCallCount, 5) + ' ' +
			pad(new Set(r.skillsCalled).size, 7) + ' ' +
			pad(r.textLength, 6) + ' ' +
			pad(r.paragraphCount, 5) + ' ' +
			pad(r.avgTextLengthPerTurn, 5) + ' ' +
			pad(r.citationCount, 5) + ' ' +
			pad(r.evictionsApplied, 5) + ' ' +
			pad(r.inputTokensFinal, 6) + ' ' +
			(r.hitLimit ? 'cap' : '-'),
		);
	}
	return lines.join('\n');
}

function formatAggregates(rows: SectionMetrics[]): string {
	if (rows.length === 0) {
		return '(no sections)';
	}
	const text = rows.map(r => r.textLength);
	const paras = rows.map(r => r.paragraphCount);
	const avgPara = rows.map(r => r.avgTextLengthPerTurn);
	const cites = rows.map(r => r.citationCount);
	const evicts = rows.map(r => r.evictionsApplied);
	const tokens = rows.map(r => r.inputTokensFinal);
	const iters = rows.map(r => r.toolCallCount);
	return [
		`sections:                  ${rows.length}`,
		`iterations  median / p90:  ${median(iters)} / ${p90(iters)}`,
		`textLength  median / p90:  ${median(text)} / ${p90(text)}`,
		`paragraphs  median / p90:  ${median(paras)} / ${p90(paras)}`,
		`avg/para    median / p90:  ${median(avgPara)} / ${p90(avgPara)}`,
		`citations   median / p90:  ${median(cites)} / ${p90(cites)}`,
		`evictions   median / p90:  ${median(evicts)} / ${p90(evicts)}`,
		`tokensFinal median / p90:  ${median(tokens)} / ${p90(tokens)}`,
		`hit-cap sections:          ${rows.filter(r => r.hitLimit).length}`,
		`empty sections (text=0):   ${rows.filter(r => r.textLength === 0).length}`,
	].join('\n');
}

const { logPath, pidFilter } = parseArgs(process.argv.slice(2));
const sections = loadSections(logPath, pidFilter);

console.log(`Log: ${logPath}${pidFilter !== undefined ? `  (pid ${pidFilter})` : ''}`);
console.log(`Sections: ${sections.length}`);
console.log('');
if (sections.length === 0) {
	console.log('No "writeSectionWithTools: tool loop complete" events found. Run /code-analyze first.');
	process.exit(0);
}
console.log(formatTable(sections));
console.log('');
console.log('Aggregates:');
console.log(formatAggregates(sections));
