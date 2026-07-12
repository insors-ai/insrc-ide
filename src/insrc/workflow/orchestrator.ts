/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Workflow orchestration hooks: per-workflow decomposer + synthesizer
 * plumbing. The MCP tool + CLI both go through this module — it's
 * the seam that maps a WorkflowIntent to (a) a decomposer prompt
 * for the outer LLM, and (b) a synthesizer prompt + artifact
 * validator for the wrap-up turn.
 *
 * Phase A only implements the `stub` workflow. Later phases plug
 * in `define`, `design.epic`, `design.story`, and the tracker
 * workflows via the same seam.
 */

import { getLogger } from '../shared/logger.js';
import type { WorkflowIntent, WorkflowName, WorkflowPlan } from './types.js';
import type { ValidationResult } from './synthesizer.js';
import { renderCitationBlock, validateBodyAndCitations } from './synthesizer.js';
import {
	isCitationArray,
	isStubArtifact,
	renderStubMarkdown,
	STUB_ARTIFACT_JSON_SCHEMA,
	STUB_SCHEMA_VERSION,
	type StubArtifact,
} from './artifacts/stub.js';
import {
	checkConstraintCoverage,
	checkStoryDependencyGraph,
	DEFINE_SCHEMA_VERSION,
	isCitationArray as isDefineCitationArray,
	isDefineBody,
	renderDefineMarkdown,
	type DefineArtifact,
	type DefineBody,
} from './artifacts/define.js';
import {
	checkInterfaceSketchTypeLevel,
	checkOwnershipConsistency,
	checkRolloutCoverage,
	checkStoryCoverage,
	HLD_SCHEMA_VERSION,
	isCitationArray as isHldCitationArray,
	isHldBody,
	renderHldMarkdown,
	type HldArtifact,
} from './artifacts/hld.js';
import { requireApprovedEpic } from './gates.js';

const log = getLogger('workflow:orchestrator');

// ---------------------------------------------------------------------------
// Decomposer
// ---------------------------------------------------------------------------

export interface DecomposerPrompt {
	readonly systemPrompt: string;
	readonly userTurn:     string;
	readonly schema:       Record<string, unknown>;
}

/** Build the decomposer prompt for a given intent. The outer LLM
 *  emits a WorkflowPlan matching `schema`, then the framework
 *  hands it to `executor.startRun`. */
export function prepareDecompose(intent: WorkflowIntent): DecomposerPrompt {
	switch (intent.workflow) {
		case 'stub':        return stubDecomposer(intent);
		case 'define':      return defineDecomposer(intent);
		case 'design.epic': return designEpicDecomposer(intent);
		default:
			throw new Error(`prepareDecompose: workflow '${intent.workflow}' not yet supported`);
	}
}

function stubDecomposer(intent: WorkflowIntent): DecomposerPrompt {
	const systemPrompt = [
		'You are the workflow decomposer for the `stub` workflow.',
		'The stub workflow demonstrates the framework skeleton with three deterministic steps.',
		'',
		'Emit a plan with EXACTLY three steps, all of runner type `echo.a`, `echo.b`, `echo.c` in order.',
		'Each step has an id `s1`, `s2`, `s3`. Params are freeform objects; use `$s1.echoed` in s2 and `$s1.echoed` / `$s2.marker` in s3 to demonstrate placeholder substitution.',
		'',
		'The plan must satisfy the schema below. Do not deviate.',
	].join('\n');
	const userTurn = `Focus: ${intent.focus}\nRepo: ${intent.repoPath}\nEmit the plan JSON now.`;
	const schema = {
		type: 'object',
		required: ['workflow', 'steps'],
		properties: {
			workflow: { const: 'stub' },
			rationale: { type: 'string' },
			steps: {
				type:     'array',
				minItems: 3,
				maxItems: 3,
				items: {
					type: 'object',
					required: ['id', 'runner', 'params'],
					properties: {
						id:     { type: 'string', pattern: '^s[1-3]$' },
						runner: { enum: ['echo.a', 'echo.b', 'echo.c'] },
						params: { type: 'object' },
						note:   { type: 'string' },
					},
					additionalProperties: false,
				},
			},
		},
		additionalProperties: false,
	} as const;
	return { systemPrompt, userTurn, schema: schema as unknown as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Synthesizer
// ---------------------------------------------------------------------------

export interface SynthesizerPrompt {
	readonly systemPrompt: string;
	readonly userTurn:     string;
	readonly schema:       Record<string, unknown>;
}

/** Build the synthesizer prompt. The outer LLM reads the executor's
 *  stepOutputs (rendered into the userTurn) and emits an artifact
 *  JSON matching `schema`. */
export function prepareSynthesize(
	intent:      WorkflowIntent,
	stepOutputs: Readonly<Record<string, unknown>>,
): SynthesizerPrompt {
	switch (intent.workflow) {
		case 'stub':        return stubSynthesizer(intent, stepOutputs);
		case 'define':      return defineSynthesizer(intent, stepOutputs);
		case 'design.epic': return designEpicSynthesizer(intent, stepOutputs);
		default:
			throw new Error(`prepareSynthesize: workflow '${intent.workflow}' not yet supported`);
	}
}

function stubSynthesizer(
	intent:      WorkflowIntent,
	stepOutputs: Readonly<Record<string, unknown>>,
): SynthesizerPrompt {
	const systemPrompt = [
		'You are the synthesizer for the `stub` workflow.',
		'Emit a StubArtifact JSON matching the schema below.',
		'',
		'Every claim in `body.summary` or `body.bulletList` MUST cite at least one entry from `citations[]` using the `[[cN]]` marker.',
		'Every citation MUST reference one of the three step outputs (s1, s2, s3) — cite them as { kind: "step-output", ref: "s1" | "s2" | "s3" }.',
		'',
		'Do NOT include code fences, do NOT invent facts that are not in the step outputs.',
	].join('\n');
	const userTurn = [
		`Focus: ${intent.focus}`,
		'',
		'Step outputs:',
		'```json',
		JSON.stringify(stepOutputs, null, 2),
		'```',
		'',
		'Emit the artifact JSON now.',
	].join('\n');
	const schema = {
		type: 'object',
		required: ['body', 'citations'],
		properties: {
			body: {
				type: 'object',
				required: ['title', 'summary', 'bulletList'],
				properties: {
					title:      { type: 'string', minLength: 1 },
					summary:    { type: 'string', minLength: 1 },
					bulletList: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
				},
				additionalProperties: false,
			},
			citations: {
				type:     'array',
				minItems: 1,
				items: {
					type: 'object',
					required: ['id', 'kind', 'ref'],
					properties: {
						id:   { type: 'string', pattern: '^c\\d+$' },
						kind: { enum: ['step-output', 'analyze-bundle', 'doc', 'code', 'stakeholder', 'convention', 'prior-artifact'] },
						ref:  { type: 'string', minLength: 1 },
						quotedText: { type: 'string' },
					},
					additionalProperties: false,
				},
			},
		},
		additionalProperties: false,
	} as const;
	return { systemPrompt, userTurn, schema: schema as unknown as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Artifact validation + render
// ---------------------------------------------------------------------------

/** Finalize the artifact JSON emitted by the synthesizer. Fills in
 *  meta, renders markdown, runs all three validation checks, and
 *  returns the rendered strings ready for `storage.writeAtomic`. */
export interface FinalizedArtifact {
	readonly workflow:     WorkflowName;
	readonly renderedMd:   string;
	readonly renderedJson: string;
	readonly artifact:     unknown;
}

/** Validation-aware finalizer. Returns `ValidationResult` on failure
 *  so the caller can prompt the LLM to retry. */
export type FinalizeResult =
	| { readonly ok: true;  readonly finalized: FinalizedArtifact }
	| { readonly ok: false; readonly failure:   ValidationResult };

export function finalizeArtifact(
	intent:       WorkflowIntent,
	stepOutputs:  Readonly<Record<string, unknown>>,
	runId:        string,
	elapsedMs:    number,
	llmResponse:  Record<string, unknown>,
): FinalizeResult {
	switch (intent.workflow) {
		case 'stub':        return finalizeStub(intent, stepOutputs, runId, elapsedMs, llmResponse);
		case 'define':      return finalizeDefine(intent, stepOutputs, runId, elapsedMs, llmResponse);
		case 'design.epic': return finalizeDesignEpic(intent, stepOutputs, runId, elapsedMs, llmResponse);
		default:
			throw new Error(`finalizeArtifact: workflow '${intent.workflow}' not yet supported`);
	}
}

function finalizeStub(
	intent:      WorkflowIntent,
	_stepOutputs: Readonly<Record<string, unknown>>,
	runId:       string,
	elapsedMs:   number,
	llmResponse: Record<string, unknown>,
): FinalizeResult {
	// Basic JSON shape check via runtime guards.
	if (typeof llmResponse !== 'object' || llmResponse === null) {
		return { ok: false, failure: schemaFailure(`synthesizer response is not an object`) };
	}
	const body = (llmResponse as { body?: unknown }).body;
	const citations = (llmResponse as { citations?: unknown }).citations;
	if (!isCitationArray(citations)) {
		return { ok: false, failure: schemaFailure(`citations must be an array of { id, kind, ref }`) };
	}
	const artifact: StubArtifact = {
		meta: {
			workflow:      'stub',
			runId,
			repoPath:      intent.repoPath,
			createdAt:     new Date().toISOString(),
			model:         'client',
			elapsedMs,
			repoIndexedAt: intent.repoIndexedAt,
			schemaVersion: STUB_SCHEMA_VERSION,
		},
		body:      body as StubArtifact['body'],
		citations,
	};
	if (!isStubArtifact(artifact)) {
		return { ok: false, failure: schemaFailure(`artifact does not match StubArtifact shape`) };
	}
	const renderedBody = renderStubMarkdown(artifact);
	const check = validateBodyAndCitations(artifact, renderedBody);
	if (!check.ok) return { ok: false, failure: check };
	const renderedMd = renderedBody + renderCitationBlock(citations);
	const renderedJson = JSON.stringify(artifact, null, 2) + '\n';
	log.info(
		{ workflow: 'stub', runId, size: renderedMd.length, citations: citations.length },
		'finalizeStub: artifact ready',
	);
	return {
		ok: true,
		finalized: {
			workflow:   'stub',
			renderedMd,
			renderedJson,
			artifact,
		},
	};
}

function schemaFailure(message: string): ValidationResult {
	return { ok: false, kind: 'schema', message };
}

// Kept as an unused import guard: STUB_ARTIFACT_JSON_SCHEMA is
// referenced by the MCP tool descriptions in Phase B; export it
// through this module so consumers only pull from `orchestrator`.
export { STUB_ARTIFACT_JSON_SCHEMA };

// ---------------------------------------------------------------------------
// define workflow
// ---------------------------------------------------------------------------

function defineDecomposer(intent: WorkflowIntent): DecomposerPrompt {
	const systemPrompt = [
		'You are the workflow decomposer for the `define` workflow.',
		'',
		'The `define` workflow always runs the SAME four steps in the SAME order:',
		'  s1: `context.assemble`  — discovery via insrc_analyze_step + flavor detection',
		'  s2: `epic.frame`        — problem + non-goals + assumptions + constraints',
		'  s3: `stories.compose`   — Stories with Given/When/Then acceptance criteria',
		'  s4: `checklist.verify`  — audit against the fixed §9 checklist',
		'',
		'Emit the plan JSON verbatim. Params are `{}` for every step; the runners read prior step outputs via the executor. Do not deviate.',
	].join('\n');
	const userTurn = `Focus: ${intent.focus}\nRepo: ${intent.repoPath}\nEmit the plan JSON now.`;
	const schema = {
		type: 'object',
		required: ['workflow', 'steps'],
		properties: {
			workflow:  { const: 'define' },
			rationale: { type: 'string' },
			steps: {
				type:     'array',
				minItems: 4,
				maxItems: 4,
				items: {
					type: 'object',
					required: ['id', 'runner', 'params'],
					properties: {
						id:     { type: 'string', pattern: '^s[1-4]$' },
						runner: { enum: ['context.assemble', 'epic.frame', 'stories.compose', 'checklist.verify'] },
						params: { type: 'object' },
						note:   { type: 'string' },
					},
					additionalProperties: false,
				},
			},
		},
		additionalProperties: false,
	} as const;
	return { systemPrompt, userTurn, schema: schema as unknown as Record<string, unknown> };
}

function defineSynthesizer(
	intent:      WorkflowIntent,
	stepOutputs: Readonly<Record<string, unknown>>,
): SynthesizerPrompt {
	const systemPrompt = [
		'You are the synthesizer for the `define` workflow.',
		'',
		'Read s1 (context) + s2 (Epic) + s3 (Stories) + s4 (checklist verdict) and emit a DefineArtifact JSON matching the schema below.',
		'',
		'HARD RULES:',
		'- `body.problem` MUST be verbatim from s2.problem.',
		'- `body.constraints` MUST be verbatim from s2.constraints (same ids, same sources).',
		'- `body.stories` MUST preserve s3 Stories verbatim.',
		'- `citations[]` MUST be the UNION of s2.citations + s3.citations, de-duplicated by id. No new citation ids invented at this step.',
		'- `openQuestions` is populated from s4 verdict: every `missed`/`ambiguous` result (except the sb1/sb2/sb3 hard-fail items — those fail the whole synthesize) becomes an open question phrased as "Item <itemId>: <notes|verdict>".',
		'- `body.flavor` matches s1.flavor exactly.',
	].join('\n');
	const userTurn = [
		`Focus: ${intent.focus}`,
		'',
		'Step outputs:',
		'```json',
		JSON.stringify(stepOutputs, null, 2),
		'```',
		'',
		'Emit the DefineArtifact JSON now.',
	].join('\n');
	const schema = {
		type: 'object',
		required: ['body', 'citations'],
		properties: {
			body: {
				type: 'object',
				required: ['flavor', 'problem', 'nonGoals', 'assumptions', 'constraints', 'stories', 'openQuestions'],
				properties: {
					flavor:       { enum: ['enhancement', 'new-capability'] },
					problem:      { type: 'string', minLength: 20 },
					nonGoals:     { type: 'array' },
					assumptions:  { type: 'array' },
					constraints:  { type: 'array' },
					stories:      { type: 'array', minItems: 1 },
					openQuestions: { type: 'array', items: { type: 'string' } },
				},
				additionalProperties: false,
			},
			citations: {
				type: 'array',
				minItems: 1,
				items: {
					type: 'object',
					required: ['id', 'kind', 'ref'],
					properties: {
						id:         { type: 'string', pattern: '^c\\d+$' },
						kind:       { enum: ['step-output', 'analyze-bundle', 'doc', 'code', 'stakeholder', 'convention', 'prior-artifact'] },
						ref:        { type: 'string', minLength: 1 },
						quotedText: { type: 'string' },
					},
					additionalProperties: false,
				},
			},
		},
		additionalProperties: false,
	} as const;
	return { systemPrompt, userTurn, schema: schema as unknown as Record<string, unknown> };
}

function finalizeDefine(
	intent:      WorkflowIntent,
	stepOutputs: Readonly<Record<string, unknown>>,
	runId:       string,
	elapsedMs:   number,
	llmResponse: Record<string, unknown>,
): FinalizeResult {
	if (typeof llmResponse !== 'object' || llmResponse === null) {
		return { ok: false, failure: schemaFailure(`synthesizer response is not an object`) };
	}
	const body      = (llmResponse as { body?: unknown }).body;
	const citations = (llmResponse as { citations?: unknown }).citations;
	if (!isDefineBody(body)) {
		return { ok: false, failure: schemaFailure(`body does not match DefineBody shape`) };
	}
	if (!isDefineCitationArray(citations)) {
		return { ok: false, failure: schemaFailure(`citations must be an array of { id, kind, ref }`) };
	}
	// scope-boundary hard-fail from s4
	const s4 = stepOutputs['s4'] as { results?: Array<{ itemId?: string; verdict?: string }> } | undefined;
	if (s4 !== undefined && Array.isArray(s4.results)) {
		const boundaryIds = new Set(['sb1', 'sb2', 'sb3']);
		const failed = s4.results.filter(r =>
			r.itemId !== undefined && boundaryIds.has(r.itemId) &&
			(r.verdict === 'missed' || r.verdict === 'ambiguous'),
		);
		if (failed.length > 0) {
			const items = failed.map(f => f.itemId).join(', ');
			return { ok: false, failure: schemaFailure(`s4 scope-boundary hard-fail on: ${items}`) };
		}
	}
	// Cross-artifact invariants: dependency DAG + constraint coverage.
	const dagIssues = checkStoryDependencyGraph(body.stories);
	if (dagIssues.length > 0) {
		return { ok: false, failure: { ok: false, kind: 'schema', message: 'Story dependency graph invalid', details: dagIssues } };
	}
	const coverageIssues = checkConstraintCoverage(body);
	if (coverageIssues.length > 0) {
		return { ok: false, failure: { ok: false, kind: 'schema', message: 'Constraint coverage broken', details: coverageIssues } };
	}
	const artifact: DefineArtifact = {
		meta: {
			workflow:      'define',
			runId,
			repoPath:      intent.repoPath,
			createdAt:     new Date().toISOString(),
			model:         'client',
			elapsedMs,
			repoIndexedAt: intent.repoIndexedAt,
			schemaVersion: DEFINE_SCHEMA_VERSION,
		},
		body,
		citations,
	};
	const renderedBody = renderDefineMarkdown(artifact);
	const check = validateBodyAndCitations(artifact, renderedBody);
	if (!check.ok) return { ok: false, failure: check };
	const renderedMd = renderedBody + renderCitationBlock(citations);
	const renderedJson = JSON.stringify(artifact, null, 2) + '\n';
	log.info(
		{ workflow: 'define', runId, size: renderedMd.length, citations: citations.length, stories: body.stories.length },
		'finalizeDefine: artifact ready',
	);
	return {
		ok: true,
		finalized: {
			workflow:   'define',
			renderedMd,
			renderedJson,
			artifact,
		},
	};
}

// ---------------------------------------------------------------------------
// design.epic (HLD) workflow
// ---------------------------------------------------------------------------

function designEpicDecomposer(intent: WorkflowIntent): DecomposerPrompt {
	const epicSlug = requireEpicSlug(intent);
	const systemPrompt = [
		'You are the workflow decomposer for the `design.epic` (HLD) workflow.',
		'',
		'The HLD workflow always runs the SAME six steps in the SAME order:',
		'  s1: `context.assemble`       — analyze bundles at whole-Epic scope',
		'  s2: `alternatives.enumerate` — 2-4 framework alternatives',
		'  s3: `alternatives.judge`     — score against Epic constraints',
		'  s4: `framework.write`        — chosen framework + shared contracts + Story boundaries',
		'  s5: `rollout.overview`       — phases + risky bits',
		'  s6: `checklist.verify`       — audit against HLD checklist',
		'',
		'Params are `{}` on every step; the runners read prior step outputs via the executor.',
	].join('\n');
	const userTurn = `Focus: ${intent.focus}\nEpic slug: ${epicSlug}\nEmit the plan JSON now.`;
	const schema = {
		type: 'object',
		required: ['workflow', 'steps'],
		properties: {
			workflow:  { const: 'design.epic' },
			rationale: { type: 'string' },
			steps: {
				type:     'array',
				minItems: 6,
				maxItems: 6,
				items: {
					type: 'object',
					required: ['id', 'runner', 'params'],
					properties: {
						id:     { type: 'string', pattern: '^s[1-6]$' },
						runner: { enum: ['context.assemble', 'alternatives.enumerate', 'alternatives.judge', 'framework.write', 'rollout.overview', 'checklist.verify'] },
						params: { type: 'object' },
						note:   { type: 'string' },
					},
					additionalProperties: false,
				},
			},
		},
		additionalProperties: false,
	} as const;
	return { systemPrompt, userTurn, schema: schema as unknown as Record<string, unknown> };
}

function designEpicSynthesizer(
	intent:      WorkflowIntent,
	stepOutputs: Readonly<Record<string, unknown>>,
): SynthesizerPrompt {
	const systemPrompt = [
		'You are the synthesizer for the `design.epic` (HLD) workflow.',
		'',
		'Read s1..s6 outputs and emit an HldArtifact JSON matching the schema below.',
		'',
		'HARD RULES:',
		'- `body.frameworkSummary`, `architectureShape`, `sharedContracts`, `storyBoundaries`, `nonFunctional` MUST be verbatim from s4.',
		'- `body.rolloutOverview` MUST be verbatim from s5.',
		'- `body.alternativesConsidered` MUST include EVERY alternative from s2, with each loser carrying a `reasonRejected` line pulled from s3.',
		'- `body.chosenAlternative` MUST equal s3.winnerId.',
		'- `body.openQuestions` collects every `missed`/`ambiguous` verdict from s6 that is NOT a scope-boundary item (sbdry1..sbdry4 hard-fail those instead).',
		'- `citations[]` MUST reference analyze bundles from s1 for every module/api name that appears in the framework body.',
	].join('\n');
	const userTurn = [
		`Focus: ${intent.focus}`,
		'',
		'Step outputs:',
		'```json',
		JSON.stringify(stepOutputs, null, 2),
		'```',
		'',
		'Emit the HldArtifact JSON now.',
	].join('\n');
	const schema = {
		type: 'object',
		required: ['body', 'citations'],
		properties: {
			body: {
				type: 'object',
				required: ['frameworkSummary', 'architectureShape', 'sharedContracts', 'storyBoundaries', 'nonFunctional', 'rolloutOverview', 'alternativesConsidered', 'chosenAlternative', 'openQuestions'],
				additionalProperties: false,
				properties: {
					frameworkSummary:  { type: 'string', minLength: 20 },
					architectureShape: { type: 'string', minLength: 20 },
					sharedContracts:   { type: 'array' },
					storyBoundaries:   { type: 'array', minItems: 1 },
					nonFunctional:     { type: 'object' },
					rolloutOverview:   { type: 'object' },
					alternativesConsidered: { type: 'array', minItems: 2 },
					chosenAlternative: { type: 'string', pattern: '^a\\d+$' },
					openQuestions:     { type: 'array', items: { type: 'string' } },
				},
			},
			citations: {
				type: 'array',
				minItems: 1,
				items: {
					type: 'object',
					required: ['id', 'kind', 'ref'],
					properties: {
						id:         { type: 'string', pattern: '^c\\d+$' },
						kind:       { enum: ['step-output', 'analyze-bundle', 'doc', 'code', 'stakeholder', 'convention', 'prior-artifact'] },
						ref:        { type: 'string', minLength: 1 },
						quotedText: { type: 'string' },
					},
					additionalProperties: false,
				},
			},
		},
		additionalProperties: false,
	} as const;
	return { systemPrompt, userTurn, schema: schema as unknown as Record<string, unknown> };
}

function finalizeDesignEpic(
	intent:      WorkflowIntent,
	stepOutputs: Readonly<Record<string, unknown>>,
	runId:       string,
	elapsedMs:   number,
	llmResponse: Record<string, unknown>,
): FinalizeResult {
	if (typeof llmResponse !== 'object' || llmResponse === null) {
		return { ok: false, failure: schemaFailure(`synthesizer response is not an object`) };
	}
	const body      = (llmResponse as { body?: unknown }).body;
	const citations = (llmResponse as { citations?: unknown }).citations;
	if (!isHldBody(body)) {
		return { ok: false, failure: schemaFailure(`body does not match HldBody shape`) };
	}
	if (!isHldCitationArray(citations)) {
		return { ok: false, failure: schemaFailure(`citations must be an array of { id, kind, ref }`) };
	}

	// s6 hard-fail scope-boundary items.
	const s6 = stepOutputs['s6'] as { results?: Array<{ itemId?: string; verdict?: string }> } | undefined;
	if (s6 !== undefined && Array.isArray(s6.results)) {
		const boundaryIds = new Set(['sbdry1', 'sbdry2', 'sbdry3', 'sbdry4']);
		const failed = s6.results.filter(r =>
			r.itemId !== undefined && boundaryIds.has(r.itemId) &&
			(r.verdict === 'missed' || r.verdict === 'ambiguous'),
		);
		if (failed.length > 0) {
			const items = failed.map(f => f.itemId).join(', ');
			return { ok: false, failure: schemaFailure(`s6 scope-boundary hard-fail on: ${items}`) };
		}
	}

	// Cross-artifact invariants — HLD must fit the approved Epic.
	const epicSlug = requireEpicSlug(intent);
	const epic = requireApprovedEpic(intent.repoPath, epicSlug);
	const epicStoryIds = epic.body.stories.map(s => s.id);

	const coverIssues = checkStoryCoverage(body, epicStoryIds);
	if (coverIssues.length > 0) {
		return { ok: false, failure: { ok: false, kind: 'schema', message: 'HLD Story coverage broken', details: coverIssues } };
	}
	const ownIssues = checkOwnershipConsistency(body);
	if (ownIssues.length > 0) {
		return { ok: false, failure: { ok: false, kind: 'schema', message: 'HLD ownership inconsistent', details: ownIssues } };
	}
	const rolloutIssues = checkRolloutCoverage(body, epicStoryIds);
	if (rolloutIssues.length > 0) {
		return { ok: false, failure: { ok: false, kind: 'schema', message: 'Rollout coverage broken', details: rolloutIssues } };
	}
	const sketchIssues = checkInterfaceSketchTypeLevel(body);
	if (sketchIssues.length > 0) {
		return { ok: false, failure: { ok: false, kind: 'schema', message: 'InterfaceSketch leaks implementation', details: sketchIssues } };
	}
	// chosenAlternative must actually appear in alternativesConsidered.
	const alt = body.alternativesConsidered.find(a => a.id === body.chosenAlternative);
	if (alt === undefined) {
		return { ok: false, failure: schemaFailure(`chosenAlternative '${body.chosenAlternative}' not in alternativesConsidered`) };
	}

	const artifact: HldArtifact = {
		meta: {
			workflow:      'design.epic',
			runId,
			repoPath:      intent.repoPath,
			createdAt:     new Date().toISOString(),
			model:         'client',
			elapsedMs,
			repoIndexedAt: intent.repoIndexedAt,
			schemaVersion: HLD_SCHEMA_VERSION,
		},
		body,
		citations,
	};
	const renderedBody = renderHldMarkdown(artifact);
	const check = validateBodyAndCitations(artifact, renderedBody);
	if (!check.ok) return { ok: false, failure: check };
	const renderedMd = renderedBody + renderCitationBlock(citations);
	const renderedJson = JSON.stringify(artifact, null, 2) + '\n';
	log.info(
		{ workflow: 'design.epic', runId, size: renderedMd.length, citations: citations.length, contracts: body.sharedContracts.length },
		'finalizeDesignEpic: artifact ready',
	);
	return {
		ok: true,
		finalized: {
			workflow:   'design.epic',
			renderedMd,
			renderedJson,
			artifact,
		},
	};
}

function requireEpicSlug(intent: WorkflowIntent): string {
	const slug = intent.params['epicSlug'];
	if (typeof slug !== 'string' || slug.length === 0) {
		throw new Error(`design.epic requires intent.params.epicSlug`);
	}
	return slug;
}
