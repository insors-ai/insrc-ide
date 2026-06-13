/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Spec assembler -- the pure composition layer that turns a scope
 * payload + memory refs + intent + template id into an
 * `AssembledSpec` and (optionally) writes it to disk.
 *
 * Phase 2a Day 2. The assembler is intentionally tiny: it picks a
 * template, calls `renderSpec`, builds `SpecMeta`, and persists.
 * No LLM call here -- the local LLM ran upstream (during the
 * section-flow / chat-handler turn) to produce the scope payload and
 * acceptance-criteria slate, and the template render is deterministic.
 *
 * Why we don't call the LLM inside the assembler: design §4.0 says
 * spec assembly is scope + criteria + memory pointers. The piece the
 * LLM contributes (intent classification, scope decisions, memory
 * recall, acceptance-criteria emission) happens BEFORE assembly. The
 * assembler's job is the deterministic last mile -- pick a template,
 * fill the slots, persist. Tests stub nothing.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { getTemplate } from './templates/registry.js';
import type { RenderSpecInput } from './templates/types.js';
import type {
	AcceptanceCriterion,
	AssembledSpec,
	MemoryRef,
	PermissionsBlock,
	RiskTag,
	ScopePayload,
	SpecMeta,
	TemplateId,
} from './types.js';
import { getLogger } from '../shared/logger.js';

const log = getLogger('handoff:spec-assembler');

/**
 * Optional permissions block. Phase 3 wires the rule emitter that
 * builds this from template defaults + project policy. Until then,
 * the assembler accepts a caller-supplied block (CLI / test) or
 * synthesises an "empty" one so the spec still has the section.
 */
const EMPTY_PERMISSIONS: PermissionsBlock = { allow: [], prompt: [], deny: [] };

export interface SpecAssemblerInput {
	readonly templateId:      TemplateId;
	readonly intent:          string;
	readonly scope:           ScopePayload;
	readonly memoryRefs:      readonly MemoryRef[];
	/**
	 * If undefined, the assembler uses the template's defaultAcceptance.
	 * Callers can extend or replace.
	 */
	readonly acceptance?:     readonly AcceptanceCriterion[] | undefined;
	readonly permissions?:    PermissionsBlock | undefined;
	readonly riskTag?:        RiskTag | undefined;
	/**
	 * Where the spec + meta files persist. If `sessionId` is set, the
	 * assembler creates `<persistRoot>/<sessionId>/<specId>.{md,meta.json}`.
	 * If `sessionId` is undefined, persistence is skipped (the caller
	 * can read the returned AssembledSpec without touching disk).
	 */
	readonly persistRoot?:    string | undefined;
	readonly sessionId?:      string | undefined;
	/**
	 * Template-specific extras forwarded into `renderSpec`. The
	 * template module's input type is its own; the assembler treats it
	 * as `Record<string, unknown>` and lets the template module
	 * validate / extract.
	 */
	readonly templateExtras?: Record<string, unknown> | undefined;
	/** Test seam: override the generated specId. */
	readonly specIdOverride?: string | undefined;
	/** Worktree path; in Phase 2a, callers (CLI) compute this; Day 3 owns. */
	readonly worktreePath:    string;
	readonly timeBudgetSec:   number;
}

export function assembleSpec(input: SpecAssemblerInput): AssembledSpec {
	const template = getTemplate(input.templateId);

	const specId = input.specIdOverride ?? `spec-${randomUUID().slice(0, 8)}`;

	const acceptance: readonly AcceptanceCriterion[] = (() => {
		if (input.acceptance !== undefined) return input.acceptance;
		// We need a render-input shape to call defaultAcceptance, but the
		// criteria don't reference acceptance themselves -- bootstrap with
		// an empty slate.
		const seed = buildRenderInput(input, [], template.defaultRisk);
		return template.defaultAcceptance(seed as never);
	})();

	const riskTag      = input.riskTag      ?? template.defaultRisk;
	const permissions  = input.permissions  ?? EMPTY_PERMISSIONS;

	const renderInput = buildRenderInput(input, acceptance, riskTag, permissions);
	const specMd      = template.renderSpec(renderInput as never);

	const meta: SpecMeta = {
		specId,
		templateId:        input.templateId,
		templateVersion:   template.version,
		intent:            input.intent,
		scope:             input.scope,
		memoryRefs:        input.memoryRefs,
		acceptanceCriteria: acceptance,
		permissions,
		riskTag,
		worktreePath:      input.worktreePath,
		timeBudgetSec:     input.timeBudgetSec,
	};

	if (input.persistRoot !== undefined && input.sessionId !== undefined) {
		persistSpec(specMd, meta, input.persistRoot, input.sessionId);
	}

	return { specId, templateId: input.templateId, specMd, meta };
}

function buildRenderInput(
	input:       SpecAssemblerInput,
	acceptance:  readonly AcceptanceCriterion[],
	riskTag:     RiskTag,
	permissions: PermissionsBlock = EMPTY_PERMISSIONS,
): RenderSpecInput & Record<string, unknown> {
	return {
		intent:        input.intent,
		scope:         input.scope,
		memoryRefs:    input.memoryRefs,
		acceptance,
		permissions,
		riskTag,
		worktreePath:  input.worktreePath,
		timeBudgetSec: input.timeBudgetSec,
		...(input.templateExtras ?? {}),
	};
}

function persistSpec(specMd: string, meta: SpecMeta, persistRoot: string, sessionId: string): void {
	const dir = join(persistRoot, sessionId);
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${meta.specId}.md`),        specMd);
		writeFileSync(join(dir, `${meta.specId}.meta.json`), JSON.stringify(meta, null, 2));
	} catch (err) {
		log.warn({ err: (err as Error).message, dir, specId: meta.specId },
			'spec persistence failed; returning AssembledSpec without on-disk copy');
	}
}
