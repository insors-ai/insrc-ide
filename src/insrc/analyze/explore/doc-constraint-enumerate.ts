/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * doc.constraint.enumerate exploration runner.
 *
 * plans/exploration-based-context-build.md Phase 2. Enumerate
 * constraints stated in doc sections about a subject. Retriever +
 * narrow LLM call with tight output schema; preserves MUST /
 * SHALL / HARD RULE language verbatim.
 *
 * Same shared-runner pattern as doc.decision.trace: the existing
 * template runtime at `analyze/runtimes/docs/constraint-enumerate.ts`
 * becomes a thin wrapper on `runSharedDocConstraintEnumerate`.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OllamaProvider } from '../../agent/providers/ollama.js';
import { loadAnalyzeConfig } from '../../config/analyze.js';
import { loadLocalProviderConfig } from '../../config/local.js';
import { getDb } from '../../db/client.js';
import { getEntity } from '../../db/entities.js';
import { getLogger } from '../../shared/logger.js';
import type { DbClient } from '../../db/client.js';
import type {
	LLMMessage,
	LLMProvider,
	StructuredSchema,
} from '../../shared/types.js';

import { retrieveDocSections } from '../docs-retrieval.js';
import type {
	DocConstraintEnumerateOutput,
	DocConstraintRecord,
	Exploration,
	ExplorationRunnerContext,
} from './types.js';

const log = getLogger('analyze:explore:doc-constraint-enumerate');

const PROMPT_REL = 'prompts/analyze/docs.constraint-enumerate.system.md';

const CONSTRAINT_KIND_ENUM = [
	'must', 'should', 'may', 'hard-rule', 'forbidden', 'invariant',
] as const;

// ---------------------------------------------------------------------------
// Structured-output schema
// ---------------------------------------------------------------------------

const CONSTRAINTS_SCHEMA: StructuredSchema = {
	type:                 'object',
	additionalProperties: false,
	required:             ['subject', 'constraints', 'notFoundNote'],
	properties: {
		subject:      { type: 'string' },
		notFoundNote: { type: 'string' },
		constraints:  {
			type:  'array',
			items: {
				type:                 'object',
				additionalProperties: false,
				required:             ['constraint', 'kind', 'sourceEntityId', 'file', 'heading', 'rationale'],
				properties: {
					constraint:     { type: 'string' },
					kind:           { type: 'string', enum: [...CONSTRAINT_KIND_ENUM] },
					sourceEntityId: { type: 'string' },
					file:           { type: 'string' },
					heading:        { type: 'string' },
					rationale:      { type: 'string' },
				},
			},
		},
	},
};

// ---------------------------------------------------------------------------
// Shared runner
// ---------------------------------------------------------------------------

export interface RunDocConstraintEnumerateArgs {
	readonly subject:     string;
	readonly repoPath:    string;
	readonly db:          DbClient;
	readonly maxSources?: number;
	readonly runId?:      string;
	readonly logContext?: string;
}

export async function runSharedDocConstraintEnumerate(
	args: RunDocConstraintEnumerateArgs,
): Promise<DocConstraintEnumerateOutput> {
	const subject = args.subject.trim();
	if (subject.length === 0) {
		throw new Error('doc.constraint.enumerate: subject is required (non-empty string)');
	}
	const maxSources = args.maxSources !== undefined
		? Math.max(1, Math.min(30, args.maxSources))
		: 15;

	const sections = await retrieveDocSections({
		db:           args.db,
		query:        subject,
		closureRepos: [args.repoPath],
		maxResults:   maxSources,
		kinds:        ['document', 'section'],
		previewChars: 0,
	});

	if (sections.length === 0) {
		log.info(
			{ runId: args.runId, subject, ctx: args.logContext },
			'doc.constraint.enumerate: no matching sections',
		);
		return {
			type:                  'doc.constraint.enumerate',
			subject,
			constraints:           [],
			notFoundNote:          `No doc sections in the retrieved corpus mention "${subject}".`,
			retrievedSectionCount: 0,
		};
	}

	const hydrated: Array<{
		readonly entityId: string;
		readonly file:     string;
		readonly heading:  string;
		readonly body:     string;
	}> = [];
	for (const s of sections) {
		const entity = await getEntity(args.db, s.entityId);
		if (entity === null) continue;
		hydrated.push({
			entityId: s.entityId,
			file:     s.file,
			heading:  s.heading,
			body:     (entity.body ?? '').slice(0, 2_000),
		});
	}

	const cfg = loadAnalyzeConfig();
	const provider = buildProvider(cfg.shaperModel, cfg.shaper.ollamaNumCtx);
	const promptContent = loadPromptFile();
	const messages = buildMessages(promptContent, subject, hydrated);

	let raw: {
		subject: string;
		constraints: DocConstraintRecord[];
		notFoundNote: string;
	};
	try {
		raw = await provider.completeStructured(
			messages,
			CONSTRAINTS_SCHEMA,
			{
				maxAttempts:     cfg.shaper.structuredOutputRetries,
				disableThinking: true,
				maxTokens:       4_096,
			},
		);
	} catch (err) {
		log.warn(
			{ runId: args.runId, subject, ctx: args.logContext, err: (err as Error).message },
			'doc.constraint.enumerate: LLM extraction failed',
		);
		return {
			type:                  'doc.constraint.enumerate',
			subject,
			constraints:           [],
			notFoundNote:
				`LLM extraction failed for subject "${subject}": ${(err as Error).message}. ` +
				`Retrieved ${sections.length} sections but could not process them.`,
			retrievedSectionCount: sections.length,
		};
	}

	// Faithfulness check: drop any constraint whose sourceEntityId
	// isn't in the retrieved set.
	const validIds = new Set(hydrated.map(h => h.entityId));
	const filtered = raw.constraints.filter(c => validIds.has(c.sourceEntityId));

	log.info(
		{
			runId:     args.runId,
			ctx:       args.logContext,
			subject,
			retrieved: sections.length,
			extracted: raw.constraints.length,
			surviving: filtered.length,
		},
		'doc.constraint.enumerate: extraction complete',
	);

	return {
		type:                  'doc.constraint.enumerate',
		subject,
		constraints:           filtered,
		notFoundNote:          filtered.length === 0 ? (raw.notFoundNote || `No constraints on "${subject}" found in the retrieved sections.`) : '',
		retrievedSectionCount: sections.length,
	};
}

// ---------------------------------------------------------------------------
// Exploration wrapper
// ---------------------------------------------------------------------------

interface ExplorationParams {
	readonly subject:     string;
	readonly maxSources?: number;
}

function parseExplorationParams(exp: Exploration): ExplorationParams {
	const p = exp.params as Record<string, unknown>;
	const subject = typeof p['subject'] === 'string' ? (p['subject'] as string).trim() : '';
	if (subject.length === 0) {
		throw new Error('doc.constraint.enumerate: params.subject is required (non-empty string)');
	}
	return {
		subject,
		...(typeof p['maxSources'] === 'number' ? { maxSources: p['maxSources'] as number } : {}),
	};
}

export async function runDocConstraintEnumerate(
	exp: Exploration,
	ctx: ExplorationRunnerContext,
): Promise<DocConstraintEnumerateOutput> {
	const params = parseExplorationParams(exp);
	const db = await getDb();
	return runSharedDocConstraintEnumerate({
		subject:    params.subject,
		repoPath:   ctx.repoPath,
		db,
		...(params.maxSources !== undefined ? { maxSources: params.maxSources } : {}),
		...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
		logContext: 'exploration',
	});
}

// ---------------------------------------------------------------------------
// Message + prompt loading
// ---------------------------------------------------------------------------

function buildMessages(
	promptContent: string,
	subject:       string,
	sections:      ReadonlyArray<{ entityId: string; file: string; heading: string; body: string }>,
): LLMMessage[] {
	const sectionsBlock = sections
		.map(s =>
			`### ${s.entityId} :: ${s.file} :: ${s.heading}\n` +
			'```\n' +
			s.body +
			'\n```',
		)
		.join('\n\n');

	const userContent =
		`Subject: ${subject}\n` +
		`\n` +
		`Retrieved doc sections:\n\n` +
		sectionsBlock +
		`\n\n` +
		'Now emit the ConstraintList JSON object. First character `{`, ' +
		'no markdown fence, no prose intro. Preserve VERBATIM constraint ' +
		'wording; preserve MUST / SHALL / HARD RULE language.';

	return [
		{ role: 'system', content: promptContent.trimEnd() },
		{ role: 'user',   content: userContent },
	];
}

function loadPromptFile(): string {
	const abs = isAbsolute(PROMPT_REL)
		? PROMPT_REL
		: resolveRelativeToInsrcRoot(PROMPT_REL);
	return readFileSync(abs, 'utf8');
}

function resolveRelativeToInsrcRoot(relativePath: string): string {
	const thisFile = fileURLToPath(import.meta.url);
	const insrcRoot = resolve(thisFile, '..', '..', '..');
	return resolve(insrcRoot, relativePath);
}

function buildProvider(modelId: string, numCtx: number): LLMProvider {
	const local = loadLocalProviderConfig();
	return new OllamaProvider(modelId, local.host, numCtx);
}

export const DOC_CONSTRAINT_ENUMERATE_PROMPT_PATH = PROMPT_REL;
