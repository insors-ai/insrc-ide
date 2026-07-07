/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared adherence-check runner used by
 * code.adherence.check / data.adherence.check /
 * infra.adherence.check.
 *
 * plans/docs-module.md Phase 4. Per-target runtimes contribute:
 *   - subjectKey     ('codeSubject' | 'dataSubject' | 'infraSubject')
 *   - subjectLabel   (rendered in the prompt: "Code" | "Data" | "Infra")
 *   - hydrateExcerpts(subject, repoPath, cap) -> AdherenceExcerpt[]
 *
 * Everything else -- constraint sourcing, LLM call, prompt, schema,
 * output shape -- is shared. Contradictions preserve BOTH sides
 * verbatim; no auto-adjudication.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OllamaProvider } from '../../../agent/providers/ollama.js';
import { loadAnalyzeConfig } from '../../../config/analyze.js';
import { loadLocalProviderConfig } from '../../../config/local.js';
import { getLogger } from '../../../shared/logger.js';
import type {
	LLMMessage,
	LLMProvider,
	StructuredSchema,
} from '../../../shared/types.js';

import type { TemplateExecuteArgs } from '../../executor/types.js';

const log = getLogger('analyze:runtimes:shared:adherence');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AdherenceExcerpt {
	readonly entityId?: string;
	readonly file:      string;
	readonly kind:      string;
	readonly name:      string;
	readonly body:      string;
	readonly lineStart: number;
	readonly lineEnd:   number;
}

export interface ConstraintInput {
	readonly constraint:      string;
	readonly sourceEntityId?: string;
	readonly file?:           string;
	readonly heading?:        string;
}

export interface AdherenceRunArgs {
	readonly executeArgs:  TemplateExecuteArgs;
	readonly subjectKey:   string;   // 'codeSubject' | 'dataSubject' | 'infraSubject'
	readonly subjectLabel: string;   // 'Code' | 'Data' | 'Infra'
	readonly templateId:   string;
	readonly promptRelPath: string;
	readonly hydrateExcerpts: (subject: string, repoPath: string, cap: number)
		=> Promise<readonly AdherenceExcerpt[]>;
}

export interface AdherenceResult {
	readonly subject:        string;
	readonly matches:        readonly unknown[];
	readonly drifts:         readonly unknown[];
	readonly missingImpl:    readonly unknown[];
	readonly contradictions: readonly unknown[];
	readonly diagnostics: {
		readonly constraintCount:   number;
		readonly excerptCount:      number;
	};
}

// ---------------------------------------------------------------------------
// LLM schema
// ---------------------------------------------------------------------------

const CITATION_SCHEMA = {
	type:                 'object',
	additionalProperties: true,
	required:             ['kind'],
	properties: {
		kind:      { type: 'string' },
		entityId:  { type: 'string' },
		file:      { type: 'string' },
		heading:   { type: 'string' },
		lineStart: { type: 'integer' },
		lineEnd:   { type: 'integer' },
	},
} as const;

/** Build the schema on-demand with the right subjectKey field. */
function buildAdherenceSchema(subjectKey: string): StructuredSchema {
	return {
		type:                 'object',
		additionalProperties: false,
		required:             [subjectKey, 'matches', 'drifts', 'missingImpl', 'contradictions'],
		properties: {
			[subjectKey]: { type: 'string' },
			matches: {
				type: 'array',
				items: {
					type:                 'object',
					additionalProperties: false,
					required:             ['constraint', 'docCitation', 'codeCitation', 'codeEvidence', 'rationale'],
					properties: {
						constraint:      { type: 'string' },
						docCitation:     CITATION_SCHEMA,
						codeCitation:    CITATION_SCHEMA,
						codeEvidence:    { type: 'string' },
						rationale:       { type: 'string' },
					},
				},
			},
			drifts: {
				type: 'array',
				items: {
					type:                 'object',
					additionalProperties: false,
					required:             ['constraint', 'docCitation', 'codeCitation', 'drift', 'codeSnippet'],
					properties: {
						constraint:   { type: 'string' },
						docCitation:  CITATION_SCHEMA,
						codeCitation: CITATION_SCHEMA,
						drift:        { type: 'string' },
						codeSnippet:  { type: 'string' },
					},
				},
			},
			missingImpl: {
				type: 'array',
				items: {
					type:                 'object',
					additionalProperties: false,
					required:             ['constraint', 'docCitation', 'whereExpected', 'rationale'],
					properties: {
						constraint:    { type: 'string' },
						docCitation:   CITATION_SCHEMA,
						whereExpected: { type: 'string' },
						rationale:     { type: 'string' },
					},
				},
			},
			contradictions: {
				type: 'array',
				items: {
					type:                 'object',
					additionalProperties: false,
					required:             ['constraint', 'docPosition', 'docCitation', 'codePosition', 'codeCitation', 'codeSnippet', 'reader_note'],
					properties: {
						constraint:   { type: 'string' },
						docPosition:  { type: 'string' },
						docCitation:  CITATION_SCHEMA,
						codePosition: { type: 'string' },
						codeCitation: CITATION_SCHEMA,
						codeSnippet:  { type: 'string' },
						reader_note:  { type: 'string' },
					},
				},
			},
		},
	};
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function runAdherenceCheck(args: AdherenceRunArgs): Promise<AdherenceResult> {
	const { executeArgs, subjectKey, subjectLabel, templateId, promptRelPath, hydrateExcerpts } = args;
	const params = executeArgs.task.params as Record<string, unknown>;

	const subject = params[subjectKey];
	if (typeof subject !== 'string' || subject.trim().length === 0) {
		throw new Error(`${templateId}: params.${subjectKey} is required (non-empty string)`);
	}
	const maxExcerpts = typeof params['maxSourceExcerpts'] === 'number'
		? Math.max(1, Math.min(30, params['maxSourceExcerpts'] as number))
		: 12;

	const constraints = resolveConstraints(executeArgs, params);
	if (constraints.length === 0) {
		throw new Error(
			`${templateId}: no constraints available. Provide params.constraintsSource ` +
			`(upstream taskId of a docs.constraint.enumerate task) OR ` +
			`params.constraints inline.`,
		);
	}

	const repoPath = executeArgs.intent.scopeRef.value;
	const excerpts = await hydrateExcerpts(subject, repoPath, maxExcerpts);

	if (excerpts.length === 0) {
		log.warn(
			{ runId: executeArgs.runId, taskId: executeArgs.task.taskId, subject },
			`${templateId}: no ${subjectLabel.toLowerCase()} excerpts hydrated`,
		);
	}

	const cfg = loadAnalyzeConfig();
	const provider = buildProvider(cfg.shaperModel, cfg.shaper.ollamaNumCtx);
	const promptContent = loadPromptFile(promptRelPath);
	const messages = buildMessages(promptContent, subjectLabel, subject, constraints, excerpts);
	const schema = buildAdherenceSchema(subjectKey);

	let raw: Record<string, unknown>;
	try {
		raw = await provider.completeStructured<Record<string, unknown>>(
			messages,
			schema,
			{
				maxAttempts:     cfg.shaper.structuredOutputRetries,
				disableThinking: true,
				maxTokens:       6_144,
			},
		);
	} catch (err) {
		log.warn(
			{ runId: executeArgs.runId, taskId: executeArgs.task.taskId, err: (err as Error).message },
			`${templateId}: LLM call failed`,
		);
		return {
			subject,
			matches: [],
			drifts:  [],
			// Failure -> every constraint goes into missingImpl with an
			// explicit failure note so the aggregator can render it.
			missingImpl: constraints.map(c => ({
				constraint:    c.constraint,
				docCitation:   {
					kind: 'section',
					...(c.sourceEntityId ? { entityId: c.sourceEntityId } : {}),
					...(c.file          ? { file:      c.file          } : {}),
					...(c.heading       ? { heading:   c.heading       } : {}),
				},
				whereExpected: `(LLM adjudication failed; ${subjectLabel.toLowerCase()} adherence unknown)`,
				rationale:     `Adherence check failed: ${(err as Error).message}`,
			})),
			contradictions: [],
			diagnostics: {
				constraintCount: constraints.length,
				excerptCount:    excerpts.length,
			},
		};
	}

	const matches        = Array.isArray(raw['matches'])        ? raw['matches']        as unknown[] : [];
	const drifts         = Array.isArray(raw['drifts'])         ? raw['drifts']         as unknown[] : [];
	const missingImpl    = Array.isArray(raw['missingImpl'])    ? raw['missingImpl']    as unknown[] : [];
	const contradictions = Array.isArray(raw['contradictions']) ? raw['contradictions'] as unknown[] : [];

	log.info(
		{
			runId:          executeArgs.runId,
			taskId:         executeArgs.task.taskId,
			[subjectKey]:   subject,
			constraints:    constraints.length,
			matches:        matches.length,
			drifts:         drifts.length,
			missingImpl:    missingImpl.length,
			contradictions: contradictions.length,
		},
		`${templateId}: complete`,
	);

	return {
		subject,
		matches,
		drifts,
		missingImpl,
		contradictions,
		diagnostics: {
			constraintCount: constraints.length,
			excerptCount:    excerpts.length,
		},
	};
}

// ---------------------------------------------------------------------------
// Constraint sourcing
// ---------------------------------------------------------------------------

function resolveConstraints(
	args:   TemplateExecuteArgs,
	params: Record<string, unknown>,
): ConstraintInput[] {
	const source = params['constraintsSource'];
	if (typeof source === 'string' && source.length > 0) {
		const upstream = args.upstreamOutputs.get(source);
		if (upstream !== undefined && typeof upstream === 'object' && upstream !== null) {
			const constraintsField = (upstream as Record<string, unknown>)['constraints'];
			if (Array.isArray(constraintsField)) {
				return normaliseConstraints(constraintsField);
			}
		}
	}
	const inline = params['constraints'];
	if (Array.isArray(inline)) {
		return normaliseConstraints(inline);
	}
	return [];
}

function normaliseConstraints(raw: readonly unknown[]): ConstraintInput[] {
	const out: ConstraintInput[] = [];
	for (const item of raw) {
		if (typeof item !== 'object' || item === null) continue;
		const o = item as Record<string, unknown>;
		const constraint = typeof o['constraint'] === 'string' ? o['constraint'] as string : undefined;
		if (constraint === undefined || constraint.length === 0) continue;
		out.push({
			constraint,
			...(typeof o['sourceEntityId'] === 'string' ? { sourceEntityId: o['sourceEntityId'] as string } : {}),
			...(typeof o['file']           === 'string' ? { file:           o['file']           as string } : {}),
			...(typeof o['heading']        === 'string' ? { heading:        o['heading']        as string } : {}),
		});
	}
	return out;
}

// ---------------------------------------------------------------------------
// Message + prompt
// ---------------------------------------------------------------------------

function buildMessages(
	promptContent: string,
	subjectLabel:  string,
	subject:       string,
	constraints:   readonly ConstraintInput[],
	excerpts:      readonly AdherenceExcerpt[],
): LLMMessage[] {
	const constraintsBlock = constraints
		.map((c, i) => {
			const citationBits: string[] = ["kind: 'section'"];
			if (c.sourceEntityId !== undefined) citationBits.push(`entityId: '${c.sourceEntityId}'`);
			if (c.file           !== undefined) citationBits.push(`file: '${c.file}'`);
			if (c.heading        !== undefined) citationBits.push(`heading: '${c.heading}'`);
			return `${i + 1}. ${c.constraint}\n   docCitation: { ${citationBits.join(', ')} }`;
		})
		.join('\n\n');

	const excerptsBlock = excerpts.length > 0
		? excerpts
			.map(e => {
				const header = e.entityId !== undefined
					? `### ${e.entityId} :: ${e.file} (${e.kind} ${e.name}, lines ${e.lineStart}-${e.lineEnd})`
					: `### ${e.file} (${e.kind} ${e.name}, lines ${e.lineStart}-${e.lineEnd})`;
				return `${header}\n\`\`\`\n${e.body}\n\`\`\``;
			})
			.join('\n\n')
		: `(no ${subjectLabel.toLowerCase()} excerpts hydrated -- the subject did not resolve)`;

	const userContent =
		`${subjectLabel} subject: ${subject}\n` +
		`\n` +
		`${subjectLabel} excerpts:\n\n` +
		excerptsBlock +
		`\n\n` +
		`Constraints to check:\n\n` +
		constraintsBlock +
		`\n\n` +
		'Now emit the AdherenceReport JSON object. First character `{`, ' +
		'no markdown fence, no prose intro. On contradictions, preserve ' +
		'BOTH doc position (verbatim) and code/data/infra position (concrete). ' +
		'Do NOT adjudicate.';

	return [
		{ role: 'system', content: promptContent.trimEnd() },
		{ role: 'user',   content: userContent },
	];
}

function loadPromptFile(relPath: string): string {
	const abs = isAbsolute(relPath)
		? relPath
		: resolveRelativeToInsrcRoot(relPath);
	return readFileSync(abs, 'utf8');
}

function resolveRelativeToInsrcRoot(relativePath: string): string {
	const thisFile = fileURLToPath(import.meta.url);
	// .../analyze/runtimes/shared/adherence.js -> ... -> .../insrc
	const insrcRoot = resolve(thisFile, '..', '..', '..', '..');
	return resolve(insrcRoot, relativePath);
}

function buildProvider(modelId: string, numCtx: number): LLMProvider {
	const local = loadLocalProviderConfig();
	return new OllamaProvider(modelId, local.host, numCtx);
}
