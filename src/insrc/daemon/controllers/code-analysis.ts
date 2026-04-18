/**
 * CodeAnalysisController -- chat intent for internal code quality /
 * consistency / impact analysis.
 *
 * Distinct from the research controller: no web search, no free-form
 * investigation. Two-pass pipeline:
 *   draft   (local LLM) -- produces an initial findings JSON
 *   review  (Claude, optional) -- refines against the same code context
 *
 * Both tasks share the assembled code context that the task orchestrator
 * gathers from the ContextManager. Finalize parses whichever pass ran
 * last and renders the markdown report.
 */

import type {
  TaskController, ControllerInput, GateReply,
  Task, TaskResult, TaskStateStore, FinalizeResult, TaskFormat,
} from '../task.js';
import {
  buildLocalDraftPrompt, buildClaudeReviewPrompt,
} from '../../agent/tasks/code-analysis/prompts.js';
import type {
  CodeAnalysisConcern, Finding, FindingSeverity,
} from '../../agent/tasks/code-analysis/types.js';

const DEFAULT_CONCERNS: CodeAnalysisConcern[] = [
  'duplicates', 'consistency', 'interface-mismatch', 'smells',
];

const VALID_CONCERNS = new Set<CodeAnalysisConcern>([
  'duplicates', 'consistency', 'interface-mismatch', 'impact', 'smells',
]);
const VALID_SEVERITIES = new Set<FindingSeverity>(['info', 'warn', 'error']);

const K_TARGET  = 'codeAnalysisTarget';
const K_DRAFT   = 'codeAnalysisDraft';
const K_FINAL   = 'codeAnalysisFinal';
const K_REVIEWED = 'codeAnalysisReviewed';

export class CodeAnalysisController implements TaskController {
  readonly id = 'code-analysis';

  buildInitialTasks(input: ControllerInput): Task[] {
    // Local draft task. The orchestrator pulls code context from the
    // ContextManager and prepends it to messages[0] (system) + user msg.
    // We override systemPrompt to the draft prompt.
    const concerns = DEFAULT_CONCERNS;
    return [{
      index: 0,
      description: 'Code analysis: drafting report...',
      kind: 'llm',
      intent: 'code-analysis',
      systemPrompt: buildLocalDraftPrompt(concerns),
      userMessage: `## Target\n${input.message}\n\n## Concerns to check\n${concerns.join(', ')}`,
      temperature: 0.2,
      maxTokens: 3000,
      searchHint: input.message,
      stateKey: K_TARGET,
    }];
  }

  next(
    completed: TaskResult,
    _gateReply: GateReply | undefined,
    state: TaskStateStore,
  ): Task[] | null {
    // After the local draft, stash it and queue Claude review if available.
    if (!state.get(K_DRAFT)) {
      const draft = parseReport(completed.output);
      state.set(K_DRAFT, draft);
      // Remember the original target for finalize()'s header.
      if (!state.get(K_TARGET)) {
        state.set(K_TARGET, completed.description);
      }

      // Always emit the Claude review task -- executeLLMTask falls back to
      // the local provider if claudeProvider is unavailable, which is fine
      // (the review prompt is still useful).
      // We track whether review actually ran by comparing outputs in the
      // next() call that follows.
      const concerns = DEFAULT_CONCERNS;
      const draftJson = JSON.stringify({ summary: draft.summary, findings: draft.findings }, null, 2);
      return [{
        index: 1,
        description: 'Code analysis: reviewing draft...',
        kind: 'llm',
        intent: 'code-analysis',
        systemPrompt: buildClaudeReviewPrompt(concerns),
        userMessage:
          `## Target\n<see prior context>\n\n## Concerns\n${concerns.join(', ')}\n\n` +
          `## Draft Report (from local model)\n\`\`\`json\n${draftJson}\n\`\`\``,
        providerHint: 'claude',
        temperature: 0,
        maxTokens: 4000,
        dependsOn: 0,
      }];
    }

    // Second pass completed -- store final report.
    const reviewed = parseReport(completed.output);
    if (reviewed.findings.length > 0 || reviewed.summary) {
      state.set(K_FINAL, reviewed);
      state.set(K_REVIEWED, true);
    } else {
      // Review produced nothing usable -- fall back to the local draft.
      const draft = state.get<ParsedReport>(K_DRAFT);
      state.set(K_FINAL, draft ?? { summary: '', findings: [] });
      state.set(K_REVIEWED, false);
    }
    return null;
  }

  finalize(state: TaskStateStore): FinalizeResult {
    const final = state.get<ParsedReport>(K_FINAL)
      ?? state.get<ParsedReport>(K_DRAFT)
      ?? { summary: '', findings: [] };
    const reviewed = state.get<boolean>(K_REVIEWED) ?? false;
    const targetRaw = state.get<string>(K_TARGET) ?? '';
    const target = stripTargetHeader(targetRaw);
    const report = formatReport(target, final.summary, final.findings, reviewed);
    return { output: report, format: 'markdown' as TaskFormat };
  }
}

// ---------------------------------------------------------------------------
// Parsing + formatting (controller-local -- the delegate-shaped analyzer
// module keeps a richer pipeline for non-controller callers, but this
// controller owns its own lightweight path).
// ---------------------------------------------------------------------------

interface ParsedReport {
  summary: string;
  findings: Finding[];
}

function parseReport(text: string): ParsedReport {
  const empty: ParsedReport = { summary: '', findings: [] };
  try {
    let cleaned = text.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) { return empty; }

    const parsed = JSON.parse(jsonMatch[0]) as { summary?: unknown; findings?: unknown };
    const summary = typeof parsed.summary === 'string' ? parsed.summary : '';
    const findings: Finding[] = [];

    if (Array.isArray(parsed.findings)) {
      for (const raw of parsed.findings) {
        if (!raw || typeof raw !== 'object') { continue; }
        const r = raw as Record<string, unknown>;
        const concern = String(r['concern'] ?? '');
        const severity = String(r['severity'] ?? 'info');
        if (!VALID_CONCERNS.has(concern as CodeAnalysisConcern)) { continue; }
        if (!VALID_SEVERITIES.has(severity as FindingSeverity)) { continue; }
        const issue = typeof r['issue'] === 'string' ? r['issue'].trim() : '';
        if (!issue) { continue; }

        const finding: Finding = {
          file: typeof r['file'] === 'string' ? r['file'] : '',
          concern: concern as CodeAnalysisConcern,
          severity: severity as FindingSeverity,
          issue,
        };
        if (typeof r['line'] === 'number' && r['line'] > 0) {
          finding.line = r['line'];
        }
        if (typeof r['suggestion'] === 'string' && r['suggestion'].trim()) {
          finding.suggestion = r['suggestion'].trim();
        }
        findings.push(finding);
      }
    }

    return { summary, findings };
  } catch {
    return empty;
  }
}

function stripTargetHeader(raw: string): string {
  if (!raw) { return ''; }
  const match = raw.match(/^## Target\s*\n(.+?)(?:\n\n|$)/s);
  return match?.[1]?.trim() ?? raw.trim();
}

const SEVERITY_ORDER: Record<FindingSeverity, number> = { error: 0, warn: 1, info: 2 };
const SEVERITY_BADGE: Record<FindingSeverity, string> = {
  error: '[error]',
  warn: '[warn]',
  info: '[info]',
};

function formatReport(
  target: string,
  summary: string,
  findings: Finding[],
  reviewed: boolean,
): string {
  const title = target.length > 80 ? target.slice(0, 77) + '...' : (target || 'repository');
  const provenance = reviewed
    ? '_Local model drafted the report; Claude reviewed and refined it._'
    : '_Local model produced this report. Claude review was unavailable or produced nothing usable._';

  const lines: string[] = [];
  lines.push(`# Code Analysis -- ${title}`);
  lines.push('');
  lines.push(provenance);
  lines.push('');
  if (summary) {
    lines.push('## Summary');
    lines.push('');
    lines.push(summary);
    lines.push('');
  }

  if (findings.length === 0) {
    lines.push('## Findings');
    lines.push('');
    lines.push('_No findings produced. Either the code context was empty or no issues were detected._');
    return lines.join('\n');
  }

  const byConcern = new Map<CodeAnalysisConcern, Finding[]>();
  for (const f of findings) {
    if (!byConcern.has(f.concern)) { byConcern.set(f.concern, []); }
    byConcern.get(f.concern)!.push(f);
  }

  lines.push(`## Findings (${findings.length})`);
  lines.push('');
  for (const [concern, group] of byConcern) {
    group.sort((a, b) => {
      const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      if (sev !== 0) { return sev; }
      return a.file.localeCompare(b.file);
    });
    lines.push(`### ${concern}`);
    lines.push('');
    for (const f of group) {
      const loc = f.file ? (f.line ? `${f.file}:${f.line}` : f.file) : '(cross-file)';
      lines.push(`- ${SEVERITY_BADGE[f.severity]} **${loc}** -- ${f.issue}`);
      if (f.suggestion) {
        lines.push(`  - ${f.suggestion}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
