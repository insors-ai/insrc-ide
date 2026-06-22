/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Context Builder types -- bundle shape, invocation inputs, shaper
 * interface, mode + target dispatch keys.
 *
 * See: design/analyze-context-builder.md
 */

import type {
	AnalyzeTarget,
	AnalyzeScopeRef,
	ClassifiedIntent,
	PlannedTask,
	AnalyzeTaskTemplate,
} from '../../shared/analyze-types.js';

/** Invocation modes -- classification (pre-target) | run (post-classify) | task (per-task). */
export type ShaperMode = 'classification' | 'run' | 'task';

/** Shaper ids -- five total, dispatched by mode + target. */
export type ShaperId = 'classification' | 'generic' | 'code' | 'data' | 'infra';

/**
 * Layered bundle the shaper emits. Layer set is identical across
 * all three modes; mode-specific shapers leave irrelevant layers
 * empty and list them in `meta.emptyLayers`.
 *
 * Render order (in assembled Markdown): system -> focus -> summary
 * -> structure -> surface -> artefacts -> upstream. Structural
 * reference goes trailing per the project's prompt convention
 * (memory: feedback_prompt_structure).
 */
export interface AnalyzeContextBundle {
	/** Stable role + posture intro emitted by the shaper's prompt. */
	readonly system: string;

	/**
	 * Intent block: scope ref, scope bucket, focused question (if
	 * any), citation strictness reminder.
	 */
	readonly focus: string;

	/** Target-shape summary (1-2 paragraphs). */
	readonly summary: string;

	/** Layout / topology / hierarchy. */
	readonly structure: string;

	/**
	 * Discovered surface: APIs / endpoints / tables / manifests /
	 * cron jobs / resource kinds / etc.
	 */
	readonly surface: string;

	/**
	 * Concrete excerpts (code / schema / yaml) with explicit
	 * citations. Each excerpt block ends with a citations[] line.
	 */
	readonly artefacts: string;

	/**
	 * Outputs from prior tasks the current task consumes. Empty in
	 * classification + run modes.
	 */
	readonly upstream: string;

	/** Provenance + diagnostics. */
	readonly meta?: BundleMeta;
}

export interface BundleMeta {
	readonly mode:           ShaperMode;
	readonly shaper:         ShaperId;
	readonly toolCalls:      number;
	readonly modelId:        string;
	readonly emptyLayers:    readonly BundleLayerName[];
	readonly schemaVersion:  number;
	/** Indexer's lastIndexedAt at bundle-build time -- used for cache invalidation. */
	readonly repoLastIndexedAt?: number;
}

/** Named layers (matches AnalyzeContextBundle's readable string fields). */
export type BundleLayerName =
	| 'system'
	| 'focus'
	| 'summary'
	| 'structure'
	| 'surface'
	| 'artefacts'
	| 'upstream';

/** Options every shaper call accepts. */
export interface ShapeOpts {
	readonly runId: string;
	/** Force-rebuild even if cache hits. Tests only -- no CLI surface. */
	readonly bypassCache?: boolean;
}

/**
 * Pre-classification input. Target-agnostic; carries the raw user
 * request and the scope reference the user surfaced (path, repo,
 * connection, ...) so the classifier-shaper can inventory the
 * workspace and the classifier downstream can pick a target.
 */
export interface ClassificationShapeInput {
	readonly scopeRef:   AnalyzeScopeRef;
	readonly userPrompt: string;
}

/** Run-level input. Carries the classifier's output. */
export interface RunShapeInput {
	readonly intent: ClassifiedIntent;
}

/**
 * Task-level input. The shaper renders `upstreamTasks` (raw output
 * JSON per upstream task) into the bundle's `upstream` layer; a
 * `null` value means the upstream task failed and downstream claims
 * may be limited.
 */
export interface TaskShapeInput {
	readonly intent:        ClassifiedIntent;
	readonly task:          PlannedTask;
	readonly template:      AnalyzeTaskTemplate;
	readonly upstreamTasks: ReadonlyMap<string, unknown | null>;
}

/**
 * Per-shaper interface. Each concrete shaper implements only the
 * modes it supports:
 *   - classification-shaper -> buildClassificationBundle
 *   - generic-shaper        -> buildRunBundle
 *   - code/data/infra       -> buildRunBundle + buildTaskBundle
 *
 * Callers acquire a Shaper via `shaperFor(mode, target?)` (see
 * `./index.ts`) which returns a narrowed Shaper with the relevant
 * method guaranteed non-undefined.
 */
export interface Shaper {
	buildClassificationBundle?(
		input: ClassificationShapeInput,
		opts:  ShapeOpts,
	): Promise<AnalyzeContextBundle>;

	buildRunBundle?(
		input: RunShapeInput,
		opts:  ShapeOpts,
	): Promise<AnalyzeContextBundle>;

	buildTaskBundle?(
		input: TaskShapeInput,
		opts:  ShapeOpts,
	): Promise<AnalyzeContextBundle>;
}

/** Narrowed Shaper handles -- caller-facing return of `shaperFor`. */
export type ClassificationShaper =
	& Shaper
	& Required<Pick<Shaper, 'buildClassificationBundle'>>;

export type RunShaper = Shaper & Required<Pick<Shaper, 'buildRunBundle'>>;

export type TaskShaper = Shaper & Required<Pick<Shaper, 'buildTaskBundle'>>;

/**
 * Target set valid for `mode='run'`. Includes 'generic'.
 */
export type RunTarget = AnalyzeTarget;

/**
 * Target set valid for `mode='task'`. Excludes 'generic' -- task-level
 * dispatch routes by task family namespace and each task belongs to
 * exactly one of code/data/infra.
 */
export type TaskTarget = Exclude<AnalyzeTarget, 'generic'>;

/** Convenience re-exports so consumers don't need a second import. */
export type {
	AnalyzeTarget,
	AnalyzeScope,
	AnalyzeScopeRef,
	ClassifiedIntent,
	PlannedTask,
	AnalyzeTaskTemplate,
} from '../../shared/analyze-types.js';
