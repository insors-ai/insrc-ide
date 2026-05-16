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
	readonly transitionPhraseNudgeFired: boolean;
	readonly firstTurnFramingDetected: boolean;
}

// Phase I.1: section-level summary emitted ONCE per section by the
// orchestrator after the 3-round patch loop ends. Has everything the
// SectionMetrics (per-round writer log) does NOT.
interface SectionRunSummary {
	readonly time: number;
	readonly pid: number;
	readonly actionId: string;
	readonly roundsRun: 1 | 2 | 3;
	readonly shippedRound: 1 | 2 | 3;
	readonly shipDecisionReason: string;
	readonly confidence: 'high' | 'medium' | 'low';
	readonly workItemsR1: number;
	readonly workItemsR2: number;
	readonly itemsAddressedR2: number;
	readonly itemsAddressedR3: number;
	readonly patchProtocolFollowedR2: boolean | undefined;
	readonly patchProtocolFollowedR3: boolean | undefined;
	readonly redraftFallbackFired: boolean;
	readonly fixItemsUnaddressedFinal: number;
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

function loadSections(logPath: string, pidFilter: number | undefined): { rounds: SectionMetrics[]; sections: SectionRunSummary[] } {
	const rounds: SectionMetrics[] = [];
	const sections: SectionRunSummary[] = [];
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
		if (pidFilter !== undefined && j['pid'] !== pidFilter) {
			continue;
		}

		if (j['msg'] === 'writeSectionWithTools: tool loop complete' || j['msg'] === 'patchSectionWithTools: patch loop complete') {
			rounds.push({
				time: j['time'] as number,
				pid: j['pid'] as number,
				actionId: j['actionId'] as string,
				toolCallCount: j['toolCallCount'] as number,
				hitLimit: j['hitLimit'] as boolean,
				skillsCalled: (j['skillsCalled'] as readonly string[]) ?? [],
				textLength: (j['textLength'] as number) ?? 0,
				paragraphCount: (j['paragraphCount'] as number) ?? 0,
				avgTextLengthPerTurn: (j['avgTextLengthPerTurn'] as number) ?? 0,
				citationCount: (j['citationCount'] as number) ?? 0,
				evictionsApplied: (j['evictionsApplied'] as number) ?? 0,
				inputTokensFinal: (j['inputTokensFinal'] as number) ?? 0,
				transitionPhraseNudgeFired: (j['transitionPhraseNudgeFired'] as boolean) ?? false,
				firstTurnFramingDetected:   (j['firstTurnFramingDetected'] as boolean) ?? false,
			});
			continue;
		}

		if (j['msg'] === 'section drafting complete') {
			sections.push({
				time: j['time'] as number,
				pid: j['pid'] as number,
				actionId: j['actionId'] as string,
				roundsRun:                (j['roundsRun'] as 1 | 2 | 3) ?? 1,
				shippedRound:             (j['shippedRound'] as 1 | 2 | 3) ?? 1,
				shipDecisionReason:       String(j['shipDecisionReason'] ?? ''),
				confidence:               (j['confidence'] as 'high' | 'medium' | 'low') ?? 'medium',
				workItemsR1:              (j['workItemsR1'] as number) ?? 0,
				workItemsR2:              (j['workItemsR2'] as number) ?? 0,
				itemsAddressedR2:         (j['itemsAddressedR2'] as number) ?? 0,
				itemsAddressedR3:         (j['itemsAddressedR3'] as number) ?? 0,
				patchProtocolFollowedR2:  j['patchProtocolFollowedR2'] as boolean | undefined,
				patchProtocolFollowedR3:  j['patchProtocolFollowedR3'] as boolean | undefined,
				redraftFallbackFired:     (j['redraftFallbackFired'] as boolean) ?? false,
				fixItemsUnaddressedFinal: (j['fixItemsUnaddressedFinal'] as number) ?? 0,
			});
			continue;
		}
	}
	return { rounds, sections };
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
		pad('flags', 7) + ' ' +
		'hit',
	);
	lines.push('-'.repeat(104));
	for (const r of rows) {
		// flags column: N = transition-phrase nudge fired, F = first-turn
		// process-narration framing detected (J.4).
		const flags = (r.transitionPhraseNudgeFired ? 'N' : '-')
			+ (r.firstTurnFramingDetected ? 'F' : '-');
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
			pad(flags, 7) + ' ' +
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
	const nudged  = rows.filter(r => r.transitionPhraseNudgeFired).length;
	const framing = rows.filter(r => r.firstTurnFramingDetected).length;
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
		`transition-nudge fired:    ${nudged} / ${rows.length} (${rows.length > 0 ? Math.round((nudged / rows.length) * 100) : 0}%)`,
		`process-narration framing: ${framing} / ${rows.length} (${rows.length > 0 ? Math.round((framing / rows.length) * 100) : 0}%)`,
	].join('\n');
}

function formatSectionsTable(rows: SectionRunSummary[]): string {
	const lines: string[] = [];
	lines.push(
		pad('actionId', 36) + ' ' +
		pad('rnds', 4) + ' ' +
		pad('ship', 4) + ' ' +
		pad('wi1', 4) + ' ' +
		pad('wi2', 4) + ' ' +
		pad('addR2', 5) + ' ' +
		pad('addR3', 5) + ' ' +
		pad('fixUn', 5) + ' ' +
		pad('p2', 3) + ' ' +
		pad('p3', 3) + ' ' +
		pad('rdft', 4) + ' ' +
		pad('conf', 6) + ' ' +
		'reason',
	);
	lines.push('-'.repeat(110));
	for (const r of rows) {
		const p2 = r.patchProtocolFollowedR2 === undefined ? '-' : (r.patchProtocolFollowedR2 ? 'Y' : 'N');
		const p3 = r.patchProtocolFollowedR3 === undefined ? '-' : (r.patchProtocolFollowedR3 ? 'Y' : 'N');
		lines.push(
			pad(r.actionId.slice(0, 36), 36) + ' ' +
			pad(r.roundsRun, 4) + ' ' +
			pad(`r${r.shippedRound}`, 4) + ' ' +
			pad(r.workItemsR1, 4) + ' ' +
			pad(r.workItemsR2, 4) + ' ' +
			pad(r.itemsAddressedR2, 5) + ' ' +
			pad(r.itemsAddressedR3, 5) + ' ' +
			pad(r.fixItemsUnaddressedFinal, 5) + ' ' +
			pad(p2, 3) + ' ' +
			pad(p3, 3) + ' ' +
			pad(r.redraftFallbackFired ? 'Y' : '-', 4) + ' ' +
			pad(r.confidence, 6) + ' ' +
			r.shipDecisionReason.slice(0, 32),
		);
	}
	return lines.join('\n');
}

function formatSectionsAggregates(rows: SectionRunSummary[]): string {
	if (rows.length === 0) {
		return '(no section summaries)';
	}
	const n = rows.length;
	const pct = (k: number): string => `${k} / ${n} (${Math.round((k / n) * 100)}%)`;
	const r1 = rows.filter(r => r.roundsRun === 1).length;
	const r2 = rows.filter(r => r.roundsRun === 2).length;
	const r3 = rows.filter(r => r.roundsRun === 3).length;
	const fromR1 = rows.filter(r => r.shippedRound === 1).length;
	const fromR2 = rows.filter(r => r.shippedRound === 2).length;
	const fromR3 = rows.filter(r => r.shippedRound === 3).length;
	const fixOK = rows.filter(r => r.fixItemsUnaddressedFinal === 0).length;
	const fallback = rows.filter(r => r.redraftFallbackFired).length;
	// Patch-protocol compliance over the patch rounds that ran (R2 + R3).
	let patchRoundsRun = 0;
	let patchRoundsFollowed = 0;
	for (const r of rows) {
		if (r.patchProtocolFollowedR2 !== undefined) {
			patchRoundsRun++;
			if (r.patchProtocolFollowedR2) {
				patchRoundsFollowed++;
			}
		}
		if (r.patchProtocolFollowedR3 !== undefined) {
			patchRoundsRun++;
			if (r.patchProtocolFollowedR3) {
				patchRoundsFollowed++;
			}
		}
	}
	const protocolPct = patchRoundsRun === 0 ? '(no patch rounds)'
		: `${patchRoundsFollowed} / ${patchRoundsRun} (${Math.round((patchRoundsFollowed / patchRoundsRun) * 100)}%)`;

	const high = rows.filter(r => r.confidence === 'high').length;
	const med  = rows.filter(r => r.confidence === 'medium').length;
	const low  = rows.filter(r => r.confidence === 'low').length;

	return [
		`sections:                  ${n}`,
		`rounds  R1 / R2 / R3:      ${r1} / ${r2} / ${r3}`,
		`shipped R1 / R2 / R3:      ${fromR1} / ${fromR2} / ${fromR3}`,
		`patch-protocol compliance: ${protocolPct}`,
		`redraft fallback fired:    ${pct(fallback)}`,
		`all fix items addressed:   ${pct(fixOK)}`,
		`confidence H / M / L:      ${high} / ${med} / ${low}`,
	].join('\n');
}

const { logPath, pidFilter } = parseArgs(process.argv.slice(2));
const { rounds, sections } = loadSections(logPath, pidFilter);

console.log(`Log: ${logPath}${pidFilter !== undefined ? `  (pid ${pidFilter})` : ''}`);
console.log(`Per-round events: ${rounds.length}  |  Section summaries: ${sections.length}`);
console.log('');
if (rounds.length === 0 && sections.length === 0) {
	console.log('No analyzer events found. Run /code-analyze first.');
	process.exit(0);
}

if (sections.length > 0) {
	console.log('== Per-section summaries (Phase G/I) ==');
	console.log(formatSectionsTable(sections));
	console.log('');
	console.log('Section aggregates:');
	console.log(formatSectionsAggregates(sections));
	console.log('');
}

if (rounds.length > 0) {
	console.log('== Per-round writer events (Phase D/J) ==');
	console.log(formatTable(rounds));
	console.log('');
	console.log('Round aggregates:');
	console.log(formatAggregates(rounds));
}
