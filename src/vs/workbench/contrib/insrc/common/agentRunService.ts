/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { Event } from '../../../../base/common/event.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentRunStatus = 'active' | 'paused' | 'crashed' | 'completed';

export interface AgentRunInfo {
	readonly id: string;
	readonly agent: string;        // 'pair' | 'delegate' | 'designer' | 'brainstorm' | 'planner' | 'tester'
	readonly status: AgentRunStatus;
	readonly step?: string | undefined;         // current step name
	readonly repo?: string | undefined;         // repo path this run belongs to
	readonly createdAt: string;
	readonly summary?: string | undefined;
}

// ---------------------------------------------------------------------------
// IInsrcAgentRunService
// ---------------------------------------------------------------------------
// Queries and manages agent runs via daemon RPCs.
// ---------------------------------------------------------------------------

export const IInsrcAgentRunService = createDecorator<IInsrcAgentRunService>('insrcAgentRunService');

export interface IInsrcAgentRunService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeRuns: Event<void>;

	/** Get all runs, optionally filtered by repo */
	getRuns(repoPath?: string | undefined): Promise<readonly AgentRunInfo[]>;

	/** Resume a paused or crashed run */
	resumeRun(runId: string): Promise<void>;

	/** Discard a run */
	discardRun(runId: string): Promise<void>;
}
