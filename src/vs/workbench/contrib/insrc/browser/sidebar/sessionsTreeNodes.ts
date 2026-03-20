/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ---------------------------------------------------------------------------
// Tree node types for the Sessions pane
// ---------------------------------------------------------------------------

export type SessionsTreeNode =
	| RepoTreeNode
	| DateGroupTreeNode
	| SessionTreeNode
	| TurnTreeNode;

export interface RepoTreeNode {
	readonly kind: 'repo';
	readonly repoPath: string;
	readonly repoName: string;
}

export interface DateGroupTreeNode {
	readonly kind: 'dateGroup';
	readonly label: string;        // 'Today', 'Yesterday', 'This week', 'Older'
	readonly repoPath: string;
	readonly sessions: SessionInfo[];
}

export interface SessionInfo {
	readonly id: string;
	readonly repo: string;
	readonly summary: string;
	readonly createdAt: string;
}

export interface SessionTreeNode {
	readonly kind: 'session';
	readonly session: SessionInfo;
}

export interface TurnInfo {
	readonly sessionId: string;
	readonly idx: number;
	readonly user: string;
	readonly assistant: string;
	readonly type?: string | undefined;       // 'turn' | 'directive' | 'summary' | 'merged'
	readonly tier?: string | undefined;       // 'hot' | 'warm' | 'cold' | 'archive'
	readonly createdAt?: string | undefined;
}

export interface TurnTreeNode {
	readonly kind: 'turn';
	readonly turn: TurnInfo;
}

// ---------------------------------------------------------------------------
// Date grouping helper
// ---------------------------------------------------------------------------

/** Group sessions by repo, then by date within each repo */
export function groupSessionsByRepo(sessions: SessionInfo[]): RepoTreeNode[] {
	const byRepo = new Map<string, SessionInfo[]>();
	for (const s of sessions) {
		const repo = s.repo || 'unknown';
		if (!byRepo.has(repo)) {
			byRepo.set(repo, []);
		}
		byRepo.get(repo)!.push(s);
	}

	return [...byRepo.entries()].map(([repoPath, repoSessions]) => ({
		kind: 'repo' as const,
		repoPath,
		repoName: repoPath.split('/').pop() || repoPath,
	}));
}

/** Group sessions by date for a specific repo */
export function groupSessionsByDate(sessions: SessionInfo[], repoPath: string): DateGroupTreeNode[] {
	const repoSessions = sessions.filter(s => s.repo === repoPath);

	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const yesterday = new Date(today.getTime() - 86_400_000);
	const thisWeek = new Date(today.getTime() - 7 * 86_400_000);

	const groups: Map<string, SessionInfo[]> = new Map();
	const order = ['Today', 'Yesterday', 'This week', 'Older'];
	for (const label of order) {
		groups.set(label, []);
	}

	for (const session of repoSessions) {
		const date = new Date(session.createdAt);
		let label: string;
		if (date >= today) {
			label = 'Today';
		} else if (date >= yesterday) {
			label = 'Yesterday';
		} else if (date >= thisWeek) {
			label = 'This week';
		} else {
			label = 'Older';
		}
		groups.get(label)!.push(session);
	}

	const result: DateGroupTreeNode[] = [];
	for (const label of order) {
		const dateSessions = groups.get(label)!;
		if (dateSessions.length > 0) {
			result.push({
				kind: 'dateGroup',
				label: `${label} (${dateSessions.length})`,
				repoPath,
				sessions: dateSessions,
			});
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// Node identity
// ---------------------------------------------------------------------------

export function getNodeId(node: SessionsTreeNode): string {
	switch (node.kind) {
		case 'repo': return `repo:${node.repoPath}`;
		case 'dateGroup': return `dateGroup:${node.repoPath}:${node.label}`;
		case 'session': return `session:${node.session.id}`;
		case 'turn': return `turn:${node.turn.sessionId}:${node.turn.idx}`;
	}
}
