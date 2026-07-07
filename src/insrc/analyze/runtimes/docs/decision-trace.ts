/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Runtime: docs.decision.trace
 *
 * Retrieves the top-K doc sections matching `params.topic`, then
 * asks the LLM to extract decisions VERBATIM from those sections
 * (with citations). Faithful-to-source: no paraphrasing.
 *
 * Uses `retrieveDocSections` for retrieval + the shaper model
 * (`qwen3.6:35b-a3b` by default) for the extraction call. Skips
 * gracefully when no sections match.
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

const TEMPLATE_ID = 'docs.decision.trace';
const PROMPT_REL  = 'prompts/analyze/docs.decision-trace.system.md';
const log = getLogger('analyze:runtimes:docs:decision-trace');

const DECISIONS_SCHEMA: StructuredSchema = {
	type:                 'object',
	additionalProperties: false,
	required:             ['topic', 'decisions', 'notFoundNote'],
	properties: {
		topic:        { type: 'string' },
		notFoundNote: { type: 'string' },
		decisions:    {
			type:  'array',
			items: {
				type:                 'object',
				additionalProperties: false,
				required:             ['decision', 'sourceEntityId', 'file', 'heading', 'rationale'],
				properties: {
					decision:       { type: 'string' },
					sourceEntityId: { type: 'string' },
					file:           { type: 'string' },
					heading:        { type: 'string' },
					rationale:      { type: 'string' },
				},
			},
		},
	},
};

interface DecisionOut {
	readonly decision:       string;
	readonly sourceEntityId: string;
	readonly file:           string;
	readonly heading:        string;
	readonly rationale:      string;
}

interface DecisionTraceOutput {
	readonly topic:        string;
	readonly decisions:    readonly DecisionOut[];
	readonly notFoundNote: string;
	/** Diagnostic: how many sections the retriever surfaced before the
	 *  LLM extraction pass. Useful for debugging "no decisions" -- if
	 *  retrieved=0 the retriever failed; if retrieved>0 but
	 *  decisions=[] the topic isn't actually covered. */
	readonly retrievedSectionCount: number;
}

export const docsDecisionTraceRuntime: TemplateRuntime = {
	templateId: TEMPLATE_ID,

	async execute(args: TemplateExecuteArgs): Promise<TemplateExecuteResult> {
		const params = args.task.params as Record<string, unknown>;
		const topic  = params['topic'];
		if (typeof topic !== 'string' || topic.trim().length === 0) {
			throw new Error(`${TEMPLATE_ID}: params.topic is required (non-empty string)`);
		}
		const maxSources = typeof params['maxSources'] === 'number'
			? Math.max(1, Math.min(30, params['maxSources'] as number))
			: 15;

		const scopeRef = args.intent.scopeRef;
		const repoPath = scopeRef.value;
		const db = await getDb();

		// (1) Retrieve. V1 = repo-scoped (single-repo closure).
		const sections = await retrieveDocSections({
			db,
			query:        topic,
			closureRepos: [repoPath],
			maxResults:   maxSources,
			// Prose-only for decision trace; skip config entities.
			kinds:        ['document', 'section'],
			previewChars: 0,
		});

		if (sections.length === 0) {
			log.info(
				{ runId: args.runId, taskId: args.task.taskId, topic },
				'docs.decision.trace: no matching sections',
			);
			const empty: DecisionTraceOutput = {
				topic,
				decisions: [],
				notFoundNote: `No doc sections in the retrieved corpus mention "${topic}".`,
				retrievedSectionCount: 0,
			};
			return { outputs: new Map<string, unknown>([['decision-trace', empty]]) };
		}

		// (2) Hydrate full bodies for the LLM extraction pass.
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

		// (3) LLM extraction.
		const cfg = loadAnalyzeConfig();
		const provider = buildProvider(cfg.shaperModel, cfg.shaper.ollamaNumCtx);
		const promptContent = loadPromptFile();
		const messages = buildMessages(promptContent, topic, hydrated);

		let raw: {
			topic: string;
			decisions: DecisionOut[];
			notFoundNote: string;
		};
		try {
			raw = await provider.completeStructured(
				messages,
				DECISIONS_SCHEMA,
				{
					maxAttempts:     cfg.shaper.structuredOutputRetries,
					disableThinking: true,
					maxTokens:       4_096,
				},
			);
		} catch (err) {
			log.warn(
				{ runId: args.runId, taskId: args.task.taskId, err: (err as Error).message },
				'docs.decision.trace: LLM extraction failed',
			);
			// Surface as an empty result with a diagnostic note rather
			// than throwing -- an unlucky LLM call shouldn't kill the
			// plan.
			const failed: DecisionTraceOutput = {
				topic,
				decisions: [],
				notFoundNote:
					`LLM extraction failed for topic "${topic}": ${(err as Error).message}. ` +
					`Retrieved ${sections.length} sections but could not process them.`,
				retrievedSectionCount: sections.length,
			};
			return { outputs: new Map<string, unknown>([['decision-trace', failed]]) };
		}

		// (4) Faithfulness check: drop any decision whose
		// sourceEntityId isn't in the retrieved set. Prevents the LLM
		// from inventing citations.
		const validIds = new Set(hydrated.map(h => h.entityId));
		const filtered = raw.decisions.filter(d => validIds.has(d.sourceEntityId));

		const output: DecisionTraceOutput = {
			topic,
			decisions:             filtered,
			notFoundNote:          filtered.length === 0 ? (raw.notFoundNote || `No decisions on "${topic}" found in the retrieved sections.`) : '',
			retrievedSectionCount: sections.length,
		};

		log.info(
			{
				runId:       args.runId,
				taskId:      args.task.taskId,
				topic,
				retrieved:   sections.length,
				extracted:   raw.decisions.length,
				surviving:   filtered.length,
			},
			'docs.decision.trace: extraction complete',
		);

		return {
			outputs: new Map<string, unknown>([['decision-trace', output]]),
		};
	},
};

// ---------------------------------------------------------------------------
// Message + prompt loading
// ---------------------------------------------------------------------------

function buildMessages(
	promptContent: string,
	topic:         string,
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
		`Topic: ${topic}\n` +
		`\n` +
		`Retrieved doc sections:\n\n` +
		sectionsBlock +
		`\n\n` +
		'Now emit the DecisionTrace JSON object. First character `{`, ' +
		'no markdown fence, no prose intro. Preserve VERBATIM decision ' +
		'wording; never paraphrase.';

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
	// .../analyze/runtimes/docs/decision-trace.js -> ... -> .../insrc
	const insrcRoot = resolve(thisFile, '..', '..', '..', '..');
	return resolve(insrcRoot, relativePath);
}

function buildProvider(modelId: string, numCtx: number): LLMProvider {
	const local = loadLocalProviderConfig();
	return new OllamaProvider(modelId, local.host, numCtx);
}

export const DOCS_DECISION_TRACE_PROMPT_PATH = PROMPT_REL;
