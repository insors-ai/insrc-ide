/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { Event } from '../../../../base/common/event.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InsrcFileDiff {
	/** Absolute file path */
	filePath: string;
	/** Original content from disk */
	originalContent: string;
	/** Proposed content after applying diff */
	proposedContent: string;
	/** Raw unified diff text for this file */
	diffText: string;
	/** Whether this is a new file */
	isNew: boolean;
}

export interface DiffAction {
	type: 'accept' | 'reject' | 'edit';
	filePath: string;
	gateId: string;
	feedback?: string | undefined;
}

// ---------------------------------------------------------------------------
// Diff parsing types (mirrors daemon diff-utils.ts)
// ---------------------------------------------------------------------------

export interface DiffHunk {
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	lines: string[];
}

export interface ParsedFileDiff {
	oldPath: string;
	newPath: string;
	isNew: boolean;
	isDelete: boolean;
	hunks: DiffHunk[];
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export const IInsrcDiffService = createDecorator<IInsrcDiffService>('insrcDiffService');

export interface IInsrcDiffService {
	readonly _serviceBrand: undefined;

	/** Fires when user accepts, rejects, or edits a diff */
	readonly onDidAction: Event<DiffAction>;

	/** Number of active diff tabs open */
	readonly activeDiffCount: number;

	/** Show diffs in editor, linked to a gate */
	showDiffs(diffs: InsrcFileDiff[], gateId: string): Promise<void>;

	/** Accept a single file's proposed changes (writes to disk) */
	acceptFile(filePath: string): Promise<void>;

	/** Reject a single file's proposed changes */
	rejectFile(filePath: string): void;

	/** Edit: prompt user for feedback, return it */
	editFile(filePath: string): Promise<string | undefined>;

	/** Accept all pending diffs */
	acceptAll(): Promise<void>;

	/** Reject all pending diffs */
	rejectAll(): void;

	/** Close all diff tabs */
	closeAll(): void;

	/** Register CodeLens provider (called once during contribution setup) */
	registerCodeLens(languageFeaturesService: unknown): void;
}

// ---------------------------------------------------------------------------
// Diff parsing utilities (ported from daemon diff-utils.ts)
// ---------------------------------------------------------------------------

/** Parse a unified diff string into per-file diffs */
export function parseDiff(text: string): ParsedFileDiff[] {
	const files: ParsedFileDiff[] = [];
	const lines = text.split('\n');
	let i = 0;

	while (i < lines.length) {
		const line = lines[i]!;

		if (line.startsWith('--- ')) {
			const oldPath = stripPathPrefix(line.slice(4).trim());
			i++;

			if (i >= lines.length || !lines[i]!.startsWith('+++ ')) {
				continue;
			}
			const newPath = stripPathPrefix(lines[i]!.slice(4).trim());
			i++;

			const fileDiff: ParsedFileDiff = {
				oldPath,
				newPath,
				isNew: oldPath === '/dev/null',
				isDelete: newPath === '/dev/null',
				hunks: [],
			};

			while (i < lines.length && lines[i]!.startsWith('@@')) {
				const hunkHeader = lines[i]!;
				const match = hunkHeader.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
				if (!match) { i++; continue; }

				const hunk: DiffHunk = {
					oldStart: parseInt(match[1]!, 10),
					oldCount: match[2] !== undefined ? parseInt(match[2], 10) : 1,
					newStart: parseInt(match[3]!, 10),
					newCount: match[4] !== undefined ? parseInt(match[4], 10) : 1,
					lines: [],
				};
				i++;

				let oldConsumed = 0;
				let newConsumed = 0;
				while (i < lines.length && (oldConsumed < hunk.oldCount || newConsumed < hunk.newCount)) {
					const hunkLine = lines[i]!;
					if (hunkLine.startsWith('+')) {
						hunk.lines.push(hunkLine);
						newConsumed++;
						i++;
					} else if (hunkLine.startsWith('-')) {
						hunk.lines.push(hunkLine);
						oldConsumed++;
						i++;
					} else if (hunkLine.startsWith(' ')) {
						hunk.lines.push(hunkLine);
						oldConsumed++;
						newConsumed++;
						i++;
					} else if (hunkLine === '') {
						hunk.lines.push(' ');
						oldConsumed++;
						newConsumed++;
						i++;
					} else if (hunkLine === '\\ No newline at end of file') {
						i++;
					} else {
						break;
					}
				}

				fileDiff.hunks.push(hunk);
			}

			files.push(fileDiff);
		} else {
			i++;
		}
	}

	return files;
}

/** Apply hunks to original content to produce proposed content */
export function applyHunks(original: string, hunks: DiffHunk[]): string {
	const lines = original.split('\n');
	const sorted = [...hunks].sort((a, b) => b.oldStart - a.oldStart);

	for (const hunk of sorted) {
		const oldLines: string[] = [];
		const newLines: string[] = [];

		for (const line of hunk.lines) {
			if (line.startsWith('-')) {
				oldLines.push(line.slice(1));
			} else if (line.startsWith('+')) {
				newLines.push(line.slice(1));
			} else if (line.startsWith(' ')) {
				oldLines.push(line.slice(1));
				newLines.push(line.slice(1));
			}
		}

		const startIdx = hunk.oldStart - 1;
		lines.splice(startIdx, oldLines.length, ...newLines);
	}

	return lines.join('\n');
}

/** Extract a unified diff from LLM output (may be in markdown fences) */
export function extractDiffFromResponse(text: string): string {
	const fenceMatch = text.match(/```(?:diff)?\s*\n([\s\S]*?)\n```/);
	if (fenceMatch) {
		return fenceMatch[1]!.trim();
	}

	const diffStart = text.indexOf('--- ');
	if (diffStart >= 0) {
		return text.slice(diffStart).trim();
	}

	return text.trim();
}

/** Check if text contains a unified diff */
export function hasDiffContent(text: string): boolean {
	return text.includes('--- a/') || text.includes('+++ b/') || text.includes('@@ -');
}

function stripPathPrefix(path: string): string {
	if (path.startsWith('a/') || path.startsWith('b/')) {
		return path.slice(2);
	}
	return path;
}
