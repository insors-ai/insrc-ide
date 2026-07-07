/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Runtime: docs.constraint.enumerate
 *
 * Retrieves the top-K doc sections matching `params.subject`, then
 * asks the LLM to list constraints VERBATIM (preserving MUST /
 * SHALL / HARD RULE language). Uses `retrieveDocSections` for
 * retrieval + the shaper model for extraction.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OllamaProvider } from '../../../agent/providers/ollama.js';
import { loadAnalyzeConfig } from '../../../config/analyze.js';
import { loadLocalProviderConfig } from '../../../config/local.js';
import { getDb } from '../../../db/client.js';
import { getEntity } from '../../../db/entities.js';
import { getLogger } from '../../../shared/logger.js';
import type { LLMMessage, LLMProvider, StructuredSchema } from '../../../shared/types.js';

import { retrieveDocSections } from '../../docs-retrieval.js';
import type {
	TemplateExecuteArgs,
	TemplateExecuteResult,
	TemplateRuntime,
} from '../../executor/types.js';

const TEMPLATE_ID = 'docs.constraint.enumerate';
const PROMPT_REL  = 'prompts/analyze/docs.constraint-enumerate.system.md';
const log = getLogger('analyze:runtimes:docs:constraint-enumerate');

const CONSTRAINT_KIND_ENUM = [
	'must', 'should', 'may', 'hard-rule', 'forbidden', 'invariant',
] as const;

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

interface ConstraintOut {
	readonly constraint:     string;
	readonly kind:           typeof CONSTRAINT_KIND_ENUM[number];
	readonly sourceEntityId: string;
	readonly file:           string;
	readonly heading:        string;
	readonly rationale:      string;
}

interface ConstraintEnumerateOutput {
	readonly subject:              string;
	readonly constraints:          readonly ConstraintOut[];
	readonly notFoundNote:         string;
	readonly retrievedSectionCount: number;
}

export const docsConstraintEnumerateRuntime: TemplateRuntime = {
	templateId: TEMPLATE_ID,

	async execute(args: TemplateExecuteArgs): Promise<TemplateExecuteResult> {
		const params  = args.task.params as Record<string, unknown>;
		const subject = params['subject'];
		if (typeof subject !== 'string' || subject.trim().length === 0) {
			throw new Error(`${TEMPLATE_ID}: params.subject is required (non-empty string)`);
		}
		const maxSources = typeof params['maxSources'] === 'number'
			? Math.max(1, Math.min(30, params['maxSources'] as number))
			: 15;

		const scopeRef = args.intent.scopeRef;
		const repoPath = scopeRef.value;
		const db = await getDb();

		const sections = await retrieveDocSections({
			db,
			query:        subject,
			closureRepos: [repoPath],
			maxResults:   maxSources,
			kinds:        ['document', 'section'],
			previewChars: 0,
		});

		if (sections.length === 0) {
			log.info(
				{ runId: args.runId, taskId: args.task.taskId, subject },
				'docs.constraint.enumerate: no matching sections',
			);
			const empty: ConstraintEnumerateOutput = {
				subject,
				constraints: [],
				notFoundNote: `No doc sections in the retrieved corpus mention "${subject}".`,
				retrievedSectionCount: 0,
			};
			return { outputs: new Map<string, unknown>([['constraints', empty]]) };
		}

		const hydrated: Array<{
			readonly entityId: string;
			readonly file:     string;
			readonly heading:  string;
			readonly body:     string;
		}> = [];
		for (const s of sections) {
			const entity = await getEntity(db, s.entityId);
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
			constraints: ConstraintOut[];
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
				{ runId: args.runId, taskId: args.task.taskId, err: (err as Error).message },
				'docs.constraint.enumerate: LLM extraction failed',
			);
			const failed: ConstraintEnumerateOutput = {
				subject,
				constraints: [],
				notFoundNote:
					`LLM extraction failed for subject "${subject}": ${(err as Error).message}. ` +
					`Retrieved ${sections.length} sections but could not process them.`,
				retrievedSectionCount: sections.length,
			};
			return { outputs: new Map<string, unknown>([['constraints', failed]]) };
		}

		// Faithfulness check: drop any constraint whose sourceEntityId
		// isn't in the retrieved set.
		const validIds = new Set(hydrated.map(h => h.entityId));
		const filtered = raw.constraints.filter(c => validIds.has(c.sourceEntityId));

		const output: ConstraintEnumerateOutput = {
			subject,
			constraints:            filtered,
			notFoundNote:           filtered.length === 0 ? (raw.notFoundNote || `No constraints on "${subject}" found in the retrieved sections.`) : '',
			retrievedSectionCount:  sections.length,
		};

		log.info(
			{
				runId:       args.runId,
				taskId:      args.task.taskId,
				subject,
				retrieved:   sections.length,
				extracted:   raw.constraints.length,
				surviving:   filtered.length,
			},
			'docs.constraint.enumerate: extraction complete',
		);

		return {
			outputs: new Map<string, unknown>([['constraints', output]]),
		};
	},
};

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
	const insrcRoot = resolve(thisFile, '..', '..', '..', '..');
	return resolve(insrcRoot, relativePath);
}

function buildProvider(modelId: string, numCtx: number): LLMProvider {
	const local = loadLocalProviderConfig();
	return new OllamaProvider(modelId, local.host, numCtx);
}

export const DOCS_CONSTRAINT_ENUMERATE_PROMPT_PATH = PROMPT_REL;
