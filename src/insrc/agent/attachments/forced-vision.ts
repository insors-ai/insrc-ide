import type { LLMProvider, LLMMessage, ContentBlock } from '../../shared/types.js';
import { getLogger, toLogFn } from '../../shared/logger.js';
import {
  parseDiff, applyDiff, extractDiffFromResponse,
} from '../tasks/diff-utils.js';
import { requestReindex } from '../tasks/reindex.js';

// ---------------------------------------------------------------------------
// Forced-Vision Implement/Test Path
//
// When image or PDF attachments are present, the turn routes through the
// caller-supplied vision provider (resolved from `cfg.models.visionDefault`).
// The normal two-stage local-then-cloud pipeline collapses into a single
// vision call; the local model does not participate.
// ---------------------------------------------------------------------------

export interface ForcedVisionResult {
  /** Whether the implementation was accepted and written to disk */
  accepted: boolean;
  /** The final unified diff text */
  diff: string;
  /** Files written to disk */
  filesWritten: string[];
  /** Response message from the vision model */
  message: string;
}

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

const FORCED_IMPLEMENT_SYSTEM = `You are a senior software engineer. You've been given a user request along with attached files (images, PDFs, or other binary content) that provide context. Produce a unified diff implementing the requested change.

Before outputting the diff, briefly validate your own implementation:
1. Check correctness, type safety, edge cases, and security
2. If you find issues, fix them in the diff before outputting

Rules:
- Output a brief analysis section (2-3 sentences) followed by the unified diff
- Use real file paths relative to the repository root
- Include enough context lines (3+) for each hunk to apply cleanly
- For new files, use --- /dev/null
- Wrap the diff in a \`\`\`diff code fence`;

const FORCED_TEST_SYSTEM = `You are a senior software engineer writing tests. You've been given a user request along with attached files that provide additional context. Produce a unified diff that adds comprehensive tests.

Before outputting the diff, briefly validate your tests:
1. Check coverage (happy path, boundary, error cases)
2. Check assertion correctness and independence

Rules:
- Output a brief analysis section (2-3 sentences) followed by the unified diff
- Cover: happy path, boundary values, error/exception paths, null/undefined inputs
- Each test must be independent (no shared mutable state)
- Use real file paths relative to the repository root
- Wrap the diff in a \`\`\`diff code fence`;

// ---------------------------------------------------------------------------
// Pipeline entry point
// ---------------------------------------------------------------------------

/**
 * Run the forced-vision pipeline when attachments require a vision model.
 *
 * Collapses the two-stage local-then-cloud pipeline into a single call
 * against the supplied vision provider. Receives attachment content blocks
 * alongside code context.
 *
 * @param intent - 'implement' or 'test'
 * @param userMessage - The user's request
 * @param repoPath - Absolute path to the repo root
 * @param codeContext - Assembled code context (entities, types, etc.)
 * @param planStepContext - Active plan step description (or empty)
 * @param contentBlocks - Multimodal content blocks from attachments
 * @param visionProvider - Vision-capable LLM provider (resolved from
 *   `cfg.models.visionDefault`; caller must build this)
 * @param log - Logger function
 */
export async function runForcedVisionPipeline(
  intent: 'implement' | 'test',
  userMessage: string,
  repoPath: string,
  codeContext: string,
  planStepContext: string,
  contentBlocks: ContentBlock[],
  visionProvider: LLMProvider,
  log: (msg: string) => void = toLogFn(getLogger('forced-vision')),
): Promise<ForcedVisionResult> {
  const systemPrompt = intent === 'implement'
    ? FORCED_IMPLEMENT_SYSTEM
    : FORCED_TEST_SYSTEM;

  log(`  [${intent}] Forced-vision mode (attachment requires a vision model)...`);

  // Build user content: text context + attachment content blocks
  const userBlocks: ContentBlock[] = [];

  // Code context as text
  const contextParts: string[] = [];
  if (codeContext) contextParts.push(`Code context:\n${codeContext}`);
  if (planStepContext) contextParts.push(`Active plan step:\n${planStepContext}`);
  contextParts.push(`User request:\n${userMessage}`);
  userBlocks.push({ type: 'text', text: contextParts.join('\n\n') });

  // Attachment content blocks (images, PDFs)
  userBlocks.push(...contentBlocks);

  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userBlocks },
  ];

  const response = await visionProvider.complete(messages, {
    maxTokens: 6000,
    temperature: 0.2,
  });

  // Extract diff from the vision model's response
  const diff = extractDiffFromResponse(response.text);

  if (!diff || !diff.includes('---')) {
    return {
      accepted: false,
      diff: '',
      filesWritten: [],
      message: response.text || 'Vision model did not produce a valid diff.',
    };
  }

  // Parse and apply the diff
  const parsed = parseDiff(diff);
  if (parsed.length === 0) {
    return {
      accepted: false,
      diff,
      filesWritten: [],
      message: 'Could not parse the diff produced by the vision model.',
    };
  }

  // Dry run first
  const dryResult = await applyDiff(parsed, repoPath, true);
  if (!dryResult.success) {
    return {
      accepted: false,
      diff,
      filesWritten: [],
      message: `Diff dry-run failed: ${[...dryResult.errors.values()].join(', ')}`,
    };
  }

  // Apply for real
  const applyResult = await applyDiff(parsed, repoPath, false);
  if (!applyResult.success) {
    return {
      accepted: false,
      diff,
      filesWritten: [],
      message: `Diff apply failed: ${[...applyResult.errors.values()].join(', ')}`,
    };
  }

  // Enqueue re-index for written files
  const filesWritten = applyResult.filesWritten;
  void requestReindex(filesWritten);

  // Extract the analysis/message part (everything before the diff)
  const analysisEnd = response.text.indexOf('```diff');
  const analysis = analysisEnd > 0
    ? response.text.slice(0, analysisEnd).trim()
    : 'Implementation applied.';

  return {
    accepted: true,
    diff,
    filesWritten,
    message: analysis,
  };
}
