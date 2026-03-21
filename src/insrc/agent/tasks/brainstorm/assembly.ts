/**
 * Final document assembly for the brainstorm agent.
 *
 * Transforms BrainstormState into a BrainstormResult with rendered HTML output.
 */

import type { BrainstormState } from './agent-state.js';
import type { BrainstormResult, SpecRequirement, Theme, Idea } from './types.js';
import { BRAINSTORM_HTML_TEMPLATE } from './templates.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assemble the final brainstorm output from agent state.
 */
export function assembleDocument(
  state: BrainstormState,
  customTemplate?: string,
): BrainstormResult {
  const stats = computeStats(state);
  const output = renderHTML(state, stats, customTemplate);
  const summary = compressForL2(state, stats);

  return {
    kind: 'brainstorm-spec',
    output,
    requirements: state.requirements,
    themes: state.themes,
    ideas: state.ideas,
    revisions: state.revisions,
    summary,
    stats,
  };
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function computeStats(state: BrainstormState): BrainstormResult['stats'] {
  return {
    rounds: state.round,
    totalIdeas: state.ideas.length,
    promoted: state.ideas.filter(i => i.status === 'promoted').length,
    merged: state.ideas.filter(i => i.status === 'merged').length,
    rejected: state.ideas.filter(i => i.status === 'rejected').length,
    parked: state.ideas.filter(i => i.status === 'parked').length,
  };
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

function renderHTML(
  state: BrainstormState,
  stats: BrainstormResult['stats'],
  customTemplate?: string,
): string {
  const title = deriveTitle(state.input.message);
  let html = customTemplate ?? BRAINSTORM_HTML_TEMPLATE;

  const docIdLabel = state.docId ? ` — ${escapeHtml(state.docId)}` : '';
  html = html.replace(/\{\{title\}\}/g, escapeHtml(title) + docIdLabel);
  html = html.replace('{{stats}}', renderStatsHTML(stats));
  html = html.replace('{{problem}}', `<p>${escapeHtml(state.input.message)}</p>`);
  html = html.replace('{{themes_section}}', renderThemesHTML(state.themes, state.ideas));
  // If polishedSpec exists (LLM-generated markdown from per-theme spec flow),
  // use it as the requirements section instead of the empty structured requirements.
  if (state.polishedSpec) {
    const trimmedSpec = state.polishedSpec.trim();
    const isFullHtml = trimmedSpec.startsWith('<!DOCTYPE') || trimmedSpec.startsWith('<html');
    let rendered: string;
    if (isFullHtml) {
      // LLM ignored markdown instruction and output full HTML — extract body content only
      const bodyMatch = trimmedSpec.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      rendered = bodyMatch ? bodyMatch[1]!.trim() : trimmedSpec;
    } else {
      rendered = markdownToHtml(trimmedSpec);
    }
    html = html.replace('{{requirements_section}}', `<h2>Requirements Specification</h2>\n${rendered}`);
    html = html.replace('{{traceability}}', '');
  } else {
    html = html.replace('{{requirements_section}}', renderRequirementsHTML(state.requirements, state.themes));
    html = html.replace('{{traceability}}', renderTraceabilityHTML(state.requirements, state.ideas));
  }
  html = html.replace('{{parked_ideas}}', renderParkedHTML(state.ideas));
  html = html.replace('{{revision_log}}', renderRevisionLogHTML(state));
  html = html.replace('{{session_stats}}', renderSessionStatsHTML(state, stats));

  // Changelog placeholders (used in spec assembly template)
  html = html.replace(/\{\{date\}\}/g, new Date().toISOString().split('T')[0]!);
  html = html.replace(/\{\{author\}\}/g, escapeHtml(state.author || 'unknown'));
  html = html.replace(/\{\{theme_count\}\}/g, String(state.themes.length));
  html = html.replace(/\{\{req_count\}\}/g, String(state.requirements.length));

  return html;
}

function renderStatsHTML(stats: BrainstormResult['stats']): string {
  return `<div class="stats">
    <div class="stat"><div class="stat-value">${stats.rounds}</div><div class="stat-label">Rounds</div></div>
    <div class="stat"><div class="stat-value">${stats.totalIdeas}</div><div class="stat-label">Ideas</div></div>
    <div class="stat"><div class="stat-value">${stats.promoted}</div><div class="stat-label">Promoted</div></div>
    <div class="stat"><div class="stat-value">${stats.merged}</div><div class="stat-label">Merged</div></div>
    <div class="stat"><div class="stat-value">${stats.parked}</div><div class="stat-label">Parked</div></div>
  </div>`;
}

function renderThemesHTML(themes: Theme[], ideas: Idea[]): string {
  if (themes.length === 0) return '';

  const parts = ['<h2>Themes</h2>'];
  for (const theme of themes) {
    parts.push(`<div class="theme-section">`);
    const themeLabel = theme.themeId ? `${escapeHtml(theme.themeId)} — ${escapeHtml(theme.name)}` : escapeHtml(theme.name);
    parts.push(`<h3>${themeLabel}</h3>`);
    parts.push(`<p>${escapeHtml(theme.description)}</p>`);

    const themeIdeas = theme.ideaIds
      .map(id => ideas.find(i => i.id === id))
      .filter((i): i is Idea => !!i);

    if (themeIdeas.length > 0) {
      for (const idea of themeIdeas) {
        const statusClass = idea.status;
        parts.push(`<div class="idea-item">[${idea.index}] ${escapeHtml(idea.title)} <span class="idea-status ${statusClass}">${idea.status}</span></div>`);
      }
    }
    parts.push('</div>');
  }
  return parts.join('\n');
}

function renderRequirementsHTML(requirements: SpecRequirement[], themes: Theme[]): string {
  if (requirements.length === 0) return '<h2>Requirements</h2>\n<p>No requirements generated.</p>';

  const parts = ['<h2>Requirements Specification</h2>'];

  // Group by theme
  const byTheme = new Map<string, SpecRequirement[]>();
  for (const req of requirements) {
    const list = byTheme.get(req.themeId) ?? [];
    list.push(req);
    byTheme.set(req.themeId, list);
  }

  for (const theme of themes) {
    const reqs = byTheme.get(theme.id);
    if (!reqs || reqs.length === 0) continue;

    const reqThemeLabel = theme.themeId ? `${escapeHtml(theme.themeId)} — ${escapeHtml(theme.name)}` : escapeHtml(theme.name);
    parts.push(`<h3>${reqThemeLabel}</h3>`);
    for (const req of reqs) {
      parts.push(renderReqCard(req));
    }
  }

  // Unthemed
  const unthemed = requirements.filter(r => !themes.some(t => t.id === r.themeId));
  if (unthemed.length > 0) {
    parts.push('<h3>Uncategorized</h3>');
    for (const req of unthemed) {
      parts.push(renderReqCard(req));
    }
  }

  return parts.join('\n');
}

function renderReqCard(req: SpecRequirement): string {
  const typeClass = req.type === 'non-functional' ? 'nonfunctional' : req.type;
  const priorityClass = req.priority;

  const criteria = req.acceptanceCriteria.length > 0
    ? `<ul class="criteria-list">${req.acceptanceCriteria.map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul>`
    : '';

  return `<div class="req-card">
    <div class="req-statement">${req.index}. ${escapeHtml(req.statement)}</div>
    <div class="req-meta">
      <span class="badge badge-${typeClass}">${req.type}</span>
      <span class="badge badge-${priorityClass}">${req.priority}</span>
      rev ${req.revision} | round ${req.addedInRound}
    </div>
    ${criteria}
  </div>`;
}

function renderTraceabilityHTML(requirements: SpecRequirement[], ideas: Idea[]): string {
  if (requirements.length === 0) return '';

  const rows = requirements.map(req => {
    const sourceIdeas = req.sourceIdeaIds
      .map(id => ideas.find(i => i.id === id))
      .filter((i): i is Idea => !!i)
      .map(i => `[${i.index}] ${i.title.slice(0, 40)}`)
      .join(', ');

    return `<tr>
      <td>${req.index}</td>
      <td>${escapeHtml(req.statement.slice(0, 60))}</td>
      <td>${escapeHtml(sourceIdeas) || '—'}</td>
    </tr>`;
  }).join('\n');

  return `<h2>Traceability Matrix</h2>
  <table class="trace-table">
    <thead><tr><th>#</th><th>Requirement</th><th>Source Ideas</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderParkedHTML(ideas: Idea[]): string {
  const parked = ideas.filter(i => i.status === 'parked');
  if (parked.length === 0) return '';

  const items = parked.map(i =>
    `<div class="idea-item">[${i.index}] ${escapeHtml(i.title)} <span class="idea-status parked">parked</span></div>`,
  ).join('\n');

  return `<h2>Parked Ideas</h2>\n${items}`;
}

function renderRevisionLogHTML(state: BrainstormState): string {
  if (state.revisions.length === 0) return '';

  const items = state.revisions.map(r =>
    `<li>Round ${r.round}: <strong>[${r.action}]</strong> ${escapeHtml(r.detail)}</li>`,
  ).join('\n');

  return `<h2>Revision Log</h2>\n<ul class="revision-log">${items}</ul>`;
}

function renderSessionStatsHTML(state: BrainstormState, stats: BrainstormResult['stats']): string {
  return `<h2>Session Summary</h2>
  <div class="req-card">
    <p><strong>Rounds:</strong> ${stats.rounds} | <strong>Ideas:</strong> ${stats.totalIdeas} | <strong>Requirements:</strong> ${state.requirementCount ?? state.requirements.length}</p>
    <p><strong>Promoted:</strong> ${stats.promoted} | <strong>Merged:</strong> ${stats.merged} | <strong>Rejected:</strong> ${stats.rejected} | <strong>Parked:</strong> ${stats.parked}</p>
  </div>`;
}

// ---------------------------------------------------------------------------
// L2 compression
// ---------------------------------------------------------------------------

function compressForL2(state: BrainstormState, stats: BrainstormResult['stats']): string {
  return [
    `Brainstorm: ${stats.rounds} rounds, ${stats.totalIdeas} ideas.`,
    `${state.requirements.length} requirements across ${state.themes.length} themes.`,
    `${stats.promoted} promoted, ${stats.merged} merged, ${stats.rejected} rejected, ${stats.parked} parked.`,
  ].join(' ');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveTitle(message: string): string {
  const firstSentence = message.match(/^[^.!?\n]+/);
  const raw = firstSentence ? firstSentence[0]! : message.slice(0, 80);
  const trimmed = raw.trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Simple markdown-to-HTML converter for polished spec content. */
function markdownToHtml(md: string): string {
  let html = escapeHtml(md);

  // Headers (h3 for ###, h4 for ####, avoid h1/h2 which are page-level)
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h3>$1</h3>');

  // Bold and italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Markdown tables → HTML tables, lists → <ul>/<li>
  const lines = html.split('\n');
  const result: string[] = [];
  let inTable = false;
  let headerDone = false;
  let inList = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const isCheckbox = /^\s*- \[[ x]\] /.test(line);
    const isBullet = /^\s*[-*] /.test(line);
    const isListItem = isCheckbox || isBullet;
    const cells = line.match(/^\|(.+)\|$/);

    if (cells) {
      if (inList) { result.push('</ul>'); inList = false; }

      // Check if next line is separator (|---|---|)
      const isSeparator = /^\|[\s-:|]+\|$/.test(line);

      if (isSeparator) {
        // Skip separator row
        continue;
      }

      if (!inTable) {
        result.push('<table class="trace-table">');
        inTable = true;
        headerDone = false;
      }

      const cellValues = cells[1]!.split('|').map(c => c.trim());
      const isHeader = !headerDone && /^\|[\s-:|]+\|$/.test(lines[i + 1] ?? '');

      if (isHeader) {
        result.push('<thead><tr>' + cellValues.map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>');
        headerDone = true;
        i++; // Skip separator line
      } else {
        result.push('<tr>' + cellValues.map(c => `<td>${c}</td>`).join('') + '</tr>');
      }
    } else if (isListItem) {
      if (inTable) { result.push('</tbody></table>'); inTable = false; headerDone = false; }
      if (!inList) { result.push('<ul class="criteria-list">'); inList = true; }

      if (isCheckbox) {
        const checked = /- \[x\] /i.test(line);
        const text = line.replace(/^\s*- \[[ x]\] /i, '');
        result.push(`<li style="list-style:none">${checked ? '☑' : '☐'} ${text}</li>`);
      } else {
        result.push(`<li>${line.replace(/^\s*[-*] /, '')}</li>`);
      }
    } else {
      if (inTable) { result.push('</tbody></table>'); inTable = false; headerDone = false; }
      if (inList) { result.push('</ul>'); inList = false; }

      // Horizontal rules
      if (/^---+$/.test(line.trim())) {
        result.push('<hr>');
      }
      // Paragraphs (non-empty, non-tag lines)
      else if (line.trim() && !line.startsWith('<')) {
        result.push(`<p>${line}</p>`);
      }
      // Empty lines
      else {
        result.push(line);
      }
    }
  }

  if (inTable) { result.push('</tbody></table>'); }
  if (inList) { result.push('</ul>'); }

  return result.join('\n');
}
