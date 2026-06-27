/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Code-target runtime catalog.
 *
 * Each template registered in analyze/planner/templates/code/index.ts
 * gets a runtime here. Aggregator runtimes (kind='leaf' but isAggregator)
 * are LLM-driven; discovery / surface / structure runtimes are
 * deterministic tool calls against the LMDB graph layer + filesystem.
 *
 * Bootstrap order matches the template catalog. Currently only
 * code.discovery.modules has a runtime; the other four leaf
 * templates land in follow-up commits per the per-family rollout
 * plan.
 */

import { codeDiscoveryModulesRuntime } from './discovery-modules.js';

import type { TemplateRuntime } from '../../executor/types.js';

export { codeDiscoveryModulesRuntime } from './discovery-modules.js';

/**
 * Every code-target template runtime currently implemented. Bootstrap
 * passes this array to registerTemplateRuntime() in order.
 *
 * Templates without runtimes yet (the executor surfaces these as
 * 'runtime-missing' at task execution time):
 *   - code.discovery.entrypoints
 *   - code.surface.functional
 *   - code.structure.module-tree
 *   - code.aggregate.report          (LLM-driven; lands with the aggregator phase)
 *   - code.subrun.deep-dive          (planner-kind, dispatched by walker -- no runtime needed)
 */
export const CODE_RUNTIMES: readonly TemplateRuntime[] = [
	codeDiscoveryModulesRuntime,
];
