/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Meta-task on-disk layout + append helpers.
 *
 * Layout (design §8):
 *
 *   ~/.insrc/meta/<metaTaskId>/
 *     meta.json                            # MetaTaskMeta
 *     plan.json                            # latest Plan (revision N)
 *     plan.history.jsonl                   # one record per revision (append-only)
 *     scope.md                             # scope-step deliverable
 *     step-<n>-<slug>.deliverable.md       # each step's primary output
 *     step-<n>-<slug>.phase1.jsonl         # phase-1 ask + result + retries
 *     step-<n>-<slug>.phase2.jsonl         # phase-2 output + retries + abort
 *     step-<n>-<slug>.audit.json           # audit result (if the template audits)
 *     synthesis.md                         # composed final artifact (if multi-step)
 *     sub-<n>-<template>/                  # sub-meta-task persistRoot (M3)
 *
 * JSONL appenders are crash-safe: each write is one record + newline,
 * flushed before the call returns. Resume reads the file line-by-line.
 *
 * Design ref: [`design/meta-tasks.html`](../../../design/meta-tasks.html) §8.
 * Plan ref:   [`plans/meta-tasks.md`](../../../plans/meta-tasks.md) M2.3.
 */

import { promises as fs } from 'fs';
import * as path from 'path';

import { PATHS } from '../shared/paths.js';
import { getLogger } from '../shared/logger.js';

import type {
	MetaTaskMeta,
	Phase1Ask,
	Phase1Result,
	Phase2Out,
	Plan,
} from './types.js';

const log = getLogger('meta-task:persist');


// ---------------------------------------------------------------------------
// Log entries -- one wrapper per file kind so the JSONL records are
// self-describing on read.
// ---------------------------------------------------------------------------

export type Phase1LogEntry =
	| { readonly ts: number; readonly kind: 'ask';        readonly ask: Phase1Ask;            readonly retryAttempt?: number | undefined }
	| { readonly ts: number; readonly kind: 'result';     readonly result: Phase1Result;      readonly retryAttempt?: number | undefined }
	| { readonly ts: number; readonly kind: 'narrow-retry'; readonly chunkIndex: number;       readonly retryAttempt: number; readonly hintNote?: string | undefined };

export type Phase2LogEntry =
	| { readonly ts: number; readonly kind: 'output';      readonly output: Phase2Out;        readonly retryAttempt?: number | undefined }
	| { readonly ts: number; readonly kind: 'retry';       readonly reason: string;           readonly retryAttempt: number };

export interface PlanHistoryEntry {
	readonly ts:        number;
	readonly revision:  number;
	readonly plan:      Plan;
	readonly trigger:   'initial' | 'adjust' | 'new-plan';
	readonly reason?:   string | undefined;
}


// ---------------------------------------------------------------------------
// Store -- one instance per metaTaskId. Constructor is cheap (paths only);
// directory creation happens on first write.
// ---------------------------------------------------------------------------

export class MetaTaskStore {
	readonly root: string;

	constructor(public readonly metaTaskId: string) {
		this.root = path.join(PATHS.meta, metaTaskId);
	}

	private async ensureRoot(): Promise<void> {
		await fs.mkdir(this.root, { recursive: true });
	}

	// -- top-level files --

	async writeMeta(meta: MetaTaskMeta): Promise<void> {
		await this.ensureRoot();
		await fs.writeFile(path.join(this.root, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
	}

	async readMeta(): Promise<MetaTaskMeta | undefined> {
		try {
			const body = await fs.readFile(path.join(this.root, 'meta.json'), 'utf8');
			return JSON.parse(body) as MetaTaskMeta;
		} catch {
			return undefined;
		}
	}

	async writePlan(plan: Plan, trigger: PlanHistoryEntry['trigger'] = 'initial', reason?: string): Promise<void> {
		await this.ensureRoot();
		await fs.writeFile(path.join(this.root, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');
		const entry: PlanHistoryEntry = reason !== undefined
			? { ts: Date.now(), revision: plan.revision, plan, trigger, reason }
			: { ts: Date.now(), revision: plan.revision, plan, trigger };
		await this.appendJsonl(path.join(this.root, 'plan.history.jsonl'), entry);
	}

	async readPlan(): Promise<Plan | undefined> {
		try {
			const body = await fs.readFile(path.join(this.root, 'plan.json'), 'utf8');
			return JSON.parse(body) as Plan;
		} catch {
			return undefined;
		}
	}

	async writeScopeDeliverable(body: string): Promise<void> {
		await this.ensureRoot();
		await fs.writeFile(path.join(this.root, 'scope.md'), body, 'utf8');
	}

	async writeSynthesis(body: string): Promise<void> {
		await this.ensureRoot();
		await fs.writeFile(path.join(this.root, 'synthesis.md'), body, 'utf8');
	}

	// -- per-step files --

	stepFileBase(stepIndex: number, slug: string): string {
		// Step index is 1-based so that the on-disk names line up with the
		// numbering surfaced in the chat panel (M3 plan, M4 detail, ...).
		const idx = String(stepIndex).padStart(2, '0');
		return path.join(this.root, `step-${idx}-${slug}`);
	}

	async writeStepDeliverable(stepIndex: number, slug: string, body: string): Promise<void> {
		await this.ensureRoot();
		await fs.writeFile(`${this.stepFileBase(stepIndex, slug)}.deliverable.md`, body, 'utf8');
	}

	async readStepDeliverable(stepIndex: number, slug: string): Promise<string | undefined> {
		try { return await fs.readFile(`${this.stepFileBase(stepIndex, slug)}.deliverable.md`, 'utf8'); }
		catch { return undefined; }
	}

	async appendStepPhase1(stepIndex: number, slug: string, entry: Phase1LogEntry): Promise<void> {
		await this.ensureRoot();
		await this.appendJsonl(`${this.stepFileBase(stepIndex, slug)}.phase1.jsonl`, entry);
	}

	async appendStepPhase2(stepIndex: number, slug: string, entry: Phase2LogEntry): Promise<void> {
		await this.ensureRoot();
		await this.appendJsonl(`${this.stepFileBase(stepIndex, slug)}.phase2.jsonl`, entry);
	}

	async writeStepAudit(stepIndex: number, slug: string, audit: unknown): Promise<void> {
		await this.ensureRoot();
		await fs.writeFile(`${this.stepFileBase(stepIndex, slug)}.audit.json`, JSON.stringify(audit, null, 2), 'utf8');
	}

	// -- helpers --

	private async appendJsonl(filePath: string, entry: unknown): Promise<void> {
		let line: string;
		try { line = JSON.stringify(entry) + '\n'; }
		catch (err) {
			// Circular / unserializable payload. Persist a shape-only fallback so
			// the file is still well-formed JSONL; matches the handoff trace
			// recorder's behavior (see handoff/observability/trace.ts).
			log.warn({ err: (err as Error).message, file: filePath }, 'jsonl stringify failed; recording shape-only');
			line = JSON.stringify({ ts: Date.now(), kind: 'stringify-error', error: (err as Error).message }) + '\n';
		}
		await fs.appendFile(filePath, line, 'utf8');
	}
}


// ---------------------------------------------------------------------------
// Slugify -- step descriptors get a filesystem-safe slug derived from the
// step name. Same algorithm everywhere so resume can locate files by step
// (name, index).
// ---------------------------------------------------------------------------

export function stepSlug(name: string): string {
	// Lowercase, alnum/dash only, collapse runs, trim.
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40)
		|| 'step';
}
