/**
 * Prior-context retriever
 * (conversation-flow-refinement.md Phase 3.2).
 *
 * Embeds the enhanced query, ANN-queries the artifact_vec table
 * scoped to the current session, scores hits with the relevance
 * scorer, filters by score floor + top-K, and mines structured
 * `PriorFacts` from the survivors' previews.
 *
 * Mining maps per-skill output shapes into the typed facts the
 * enhancer + downstream meta-skills care about (modules, entities,
 * tables, ORM models). Each miner is forgiving: if the preview
 * doesn't parse or doesn't carry the expected fields, the artifact
 * is still in `artifacts` (the LLM can still cite it via preview),
 * just not surfaced as a structured fact.
 */

import { getLogger } from '../../shared/logger.js';
import { embedQuery } from '../../indexer/embedder.js';
import { queryArtifactVec, type ArtifactVecHit } from '../../db/lance/artifact-vec.js';
import { scoreArtifacts, type ScoredArtifact } from './relevance.js';
import type { Session } from '../session.js';
import type { ResolvedIntent } from './resolver.js';

const log = getLogger('prior-context-retriever');

// ---------------------------------------------------------------------------
// Tag identifier
// ---------------------------------------------------------------------------

/**
 * ContextManager tag the chat-handler stamps with a JSON snapshot of
 * the current turn's PriorContext (`{ facts, artifactCount, currentIntent }`).
 * The orchestrator reads this back in `afterSkillsRoutingBootstrap`
 * and threads `priorFacts` into the SkillsPipelineInput so meta-skills
 * (notably `code.meta.select-scope`) can map friendly labels back to
 * concrete identifiers. Cross-process: the tag travels with the
 * Session; downstream paths that don't know about it just ignore it.
 */
export const PRIOR_CONTEXT_TAG_CURRENT = '[priorContext:current]';

// ---------------------------------------------------------------------------
// Public types (mirror the PriorContext shape declared in the plan)
// ---------------------------------------------------------------------------

export interface RetrievedArtifact {
	readonly id:        string;
	readonly skillId:   string;
	readonly intent:    string;
	readonly timestamp: number;     // epoch ms (number form for prompt embedding ease)
	readonly score:     number;
	readonly path:      string;
	readonly preview:   string;
}

export interface PriorFacts {
	readonly modules?:   readonly { path: string; label?: string; fileCount?: number }[];
	readonly entities?:  readonly { entityRef: string; name: string; kind: string; file?: string }[];
	readonly tables?:    readonly { connectionId: string; name: string; columns?: string[] }[];
	readonly ormModels?: readonly { name: string; table?: string; dialect: string }[];
}

export interface PriorContext {
	readonly currentIntent:  string;
	readonly intentChanged:  boolean;
	/**
	 * Intent the prior turn classified as. Populated only when
	 * `intentChanged === true` (resolver source was 'classified-shifted').
	 * The enhancer surfaces this as a "Note: intent shifted from X to Y"
	 * line so the LLM understands prior facts may need translation
	 * (Phase 5.2). Undefined for fresh / tag-reuse paths.
	 */
	readonly previousIntent?: string | undefined;
	readonly artifacts:      readonly RetrievedArtifact[];
	readonly facts:          PriorFacts;
}

export interface RetrieveOpts {
	readonly maxArtifacts?: number;     // default 8
	readonly scoreFloor?:   number;     // default 0.2
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ARTIFACTS = 8;
const DEFAULT_SCORE_FLOOR   = 0.2;

export async function retrievePriorContext(
	session: Session,
	enhancedQuery: string,
	resolvedIntent: ResolvedIntent,
	opts: RetrieveOpts = {},
): Promise<PriorContext> {
	const maxArtifacts = opts.maxArtifacts ?? DEFAULT_MAX_ARTIFACTS;
	const scoreFloor   = opts.scoreFloor   ?? DEFAULT_SCORE_FLOOR;
	const intentChanged = resolvedIntent.source === 'classified-shifted';
	const previousIntent = intentChanged ? resolvedIntent.previousIntent : undefined;

	// Empty query / empty session id -> no artefacts. Still return a
	// useful PriorContext so callers can rely on the shape.
	if (enhancedQuery.length === 0 || session.id.length === 0) {
		return emptyContext(resolvedIntent.id, intentChanged, previousIntent);
	}

	let queryVec: number[] = [];
	try {
		queryVec = await embedQuery(enhancedQuery);
	} catch (err) {
		log.warn({ err: errMessage(err) }, 'retriever: embed failed -- returning empty context');
		return emptyContext(resolvedIntent.id, intentChanged, previousIntent);
	}
	if (queryVec.length === 0) {
		log.info({ session: session.id }, 'retriever: empty query vector (Ollama down?) -- empty context');
		return emptyContext(resolvedIntent.id, intentChanged, previousIntent);
	}

	// Over-fetch by 2x so the score-floor filter has room to drop
	// false-positives without leaving the prompt under-populated.
	let raw: ArtifactVecHit[] = [];
	try {
		raw = await queryArtifactVec(queryVec, {
			sessionId: session.id,
			k:         maxArtifacts * 2,
		});
	} catch (err) {
		log.warn({ err: errMessage(err) }, 'retriever: lance query failed -- returning empty context');
		return emptyContext(resolvedIntent.id, intentChanged, previousIntent);
	}
	if (raw.length === 0) {
		return emptyContext(resolvedIntent.id, intentChanged, previousIntent);
	}

	const scored = scoreArtifacts(raw, resolvedIntent.id, Date.now())
		.filter(s => s.score >= scoreFloor)
		.slice(0, maxArtifacts);

	const artifacts = scored.map(toRetrieved);
	const facts     = mineFacts(scored);

	log.info({
		session:    session.id,
		intent:     resolvedIntent.id,
		retrieved:  artifacts.length,
		factCounts: factCounts(facts),
	}, 'retriever: prior context assembled');

	return {
		currentIntent: resolvedIntent.id,
		intentChanged,
		...(previousIntent !== undefined ? { previousIntent } : {}),
		artifacts,
		facts,
	};
}

// ---------------------------------------------------------------------------
// Mining: per-skill output shapes -> typed facts
// ---------------------------------------------------------------------------

interface RawValue {
	readonly value: unknown;
}

/**
 * Parse an artifact preview back into its nested `value` blob. The
 * preview was written by the spill-writer as the raw value blob
 * (not the envelope), so most parses succeed cleanly. Truncated
 * previews (~2 KB cap) may fail JSON.parse -- those are silently
 * skipped per the forgiving-mining contract.
 */
function safeParseValue(preview: string): RawValue | null {
	if (preview.length === 0) return null;
	try {
		const parsed = JSON.parse(preview);
		return { value: parsed };
	} catch {
		return null;
	}
}

interface MiningContext {
	modules:   { path: string; label?: string; fileCount?: number }[];
	entities:  { entityRef: string; name: string; kind: string; file?: string }[];
	tables:    { connectionId: string; name: string; columns?: string[] }[];
	ormModels: { name: string; table?: string; dialect: string }[];
}

function emptyMiningCtx(): MiningContext {
	return { modules: [], entities: [], tables: [], ormModels: [] };
}

/**
 * Per-skill miners. Keyed on skill id prefix (most-specific first).
 * Each miner is forgiving: missing fields just produce no facts.
 */
function mineFacts(scored: readonly ScoredArtifact[]): PriorFacts {
	const ctx = emptyMiningCtx();
	const seenModules  = new Set<string>();
	const seenEntities = new Set<string>();
	const seenTables   = new Set<string>();
	const seenOrm      = new Set<string>();

	for (const a of scored) {
		const parsed = safeParseValue(a.preview);
		if (parsed === null) continue;
		const v = parsed.value as Record<string, unknown> | null;
		if (v === null || typeof v !== 'object') continue;

		// code.source.repo.describe -> topModules
		if (a.skill_id === 'code.source.repo.describe' && Array.isArray(v['topModules'])) {
			for (const m of v['topModules'] as Array<Record<string, unknown>>) {
				const path = typeof m['path'] === 'string' ? m['path'] : '';
				if (path === '' || seenModules.has(path)) continue;
				seenModules.add(path);
				const fileCount = typeof m['fileCount'] === 'number' ? m['fileCount'] : undefined;
				ctx.modules.push({ path, ...(fileCount !== undefined ? { fileCount } : {}) });
			}
		}

		// code.source.module.describe -> { modulePath } (single)
		if (a.skill_id === 'code.source.module.describe' && typeof v['modulePath'] === 'string') {
			const path = v['modulePath'] as string;
			if (!seenModules.has(path)) {
				seenModules.add(path);
				ctx.modules.push({ path });
			}
		}

		// code.entity.{summary,locate-by-name,callers,callees} -> entities
		if (a.skill_id.startsWith('code.entity.') && v['found'] === true) {
			const entityRef = typeof v['entityId'] === 'string' ? v['entityId'] : '';
			const name      = typeof v['name']     === 'string' ? v['name']     : '';
			const kind      = typeof v['kind']     === 'string' ? v['kind']     : '';
			const file      = typeof v['file']     === 'string' ? v['file']     : undefined;
			if (entityRef.length > 0 && !seenEntities.has(entityRef)) {
				seenEntities.add(entityRef);
				ctx.entities.push({
					entityRef, name, kind,
					...(file !== undefined ? { file } : {}),
				});
			}
		}
		// code.entity.locate-by-name returns matches[]
		if (a.skill_id === 'code.entity.locate-by-name' && Array.isArray(v['matches'])) {
			for (const m of v['matches'] as Array<Record<string, unknown>>) {
				const entityRef = typeof m['id']   === 'string' ? m['id']   : '';
				const name      = typeof m['name'] === 'string' ? m['name'] : '';
				const kind      = typeof m['kind'] === 'string' ? m['kind'] : '';
				const file      = typeof m['file'] === 'string' ? m['file'] : undefined;
				if (entityRef.length === 0 || seenEntities.has(entityRef)) continue;
				seenEntities.add(entityRef);
				ctx.entities.push({
					entityRef, name, kind,
					...(file !== undefined ? { file } : {}),
				});
			}
		}

		// code.orm.resolve-model -> { found:true, model: { name, table?, dialect } }
		if (a.skill_id === 'code.orm.resolve-model' && v['found'] === true && v['model'] !== undefined) {
			const m = v['model'] as Record<string, unknown>;
			const name = typeof m['name'] === 'string' ? m['name'] : '';
			const dialect = typeof m['dialect'] === 'string' ? m['dialect'] : '';
			const table = typeof m['table'] === 'string' ? m['table'] : undefined;
			const key = `${dialect}:${name}`;
			if (name.length > 0 && !seenOrm.has(key)) {
				seenOrm.add(key);
				ctx.ormModels.push({
					name, dialect,
					...(table !== undefined ? { table } : {}),
				});
			}
		}

		// data.source.rdbms.describe-table -> { connectionId, target, columns?[] }
		if (a.skill_id === 'data.source.rdbms.describe-table') {
			const connectionId = typeof v['connectionId'] === 'string' ? v['connectionId'] : '';
			const targetName   = typeof v['target']       === 'string' ? v['target']       : '';
			if (connectionId.length > 0 && targetName.length > 0) {
				const key = `${connectionId}:${targetName}`;
				if (!seenTables.has(key)) {
					seenTables.add(key);
					const cols = Array.isArray(v['columns'])
						? (v['columns'] as Array<Record<string, unknown>>)
							.map(c => typeof c['name'] === 'string' ? c['name'] : '')
							.filter(s => s.length > 0)
						: undefined;
					ctx.tables.push({
						connectionId, name: targetName,
						...(cols !== undefined ? { columns: cols } : {}),
					});
				}
			}
		}
	}

	return toPriorFacts(ctx);
}

function toPriorFacts(ctx: MiningContext): PriorFacts {
	const out: { -readonly [K in keyof PriorFacts]?: PriorFacts[K] } = {};
	if (ctx.modules.length   > 0) out.modules   = ctx.modules;
	if (ctx.entities.length  > 0) out.entities  = ctx.entities;
	if (ctx.tables.length    > 0) out.tables    = ctx.tables;
	if (ctx.ormModels.length > 0) out.ormModels = ctx.ormModels;
	return out as PriorFacts;
}

function factCounts(facts: PriorFacts): Record<string, number> {
	return {
		modules:   facts.modules?.length   ?? 0,
		entities:  facts.entities?.length  ?? 0,
		tables:    facts.tables?.length    ?? 0,
		ormModels: facts.ormModels?.length ?? 0,
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toRetrieved(s: ScoredArtifact): RetrievedArtifact {
	return {
		id:        s.id,
		skillId:   s.skill_id,
		intent:    s.intent,
		timestamp: Number(s.timestamp),
		score:     s.score,
		path:      s.path,
		preview:   s.preview,
	};
}

function emptyContext(
	currentIntent: string,
	intentChanged: boolean,
	previousIntent?: string | undefined,
): PriorContext {
	return {
		currentIntent,
		intentChanged,
		...(previousIntent !== undefined ? { previousIntent } : {}),
		artifacts: [],
		facts:     {},
	};
}

function errMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

export const _mineFactsForTest = mineFacts;
