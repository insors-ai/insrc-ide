/**
 * Artifact save pipeline — format conversion + gated save for agent outputs.
 *
 * Used by designer, planner, tester, and brainstorm agents to save their
 * final documents as Markdown, HTML, or PDF (if tools installed).
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { execSync } from 'node:child_process';
import { getLogger } from '../../../shared/logger.js';

const log = getLogger('artifact-save');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ArtifactFormat = 'markdown' | 'html' | 'pdf';

export interface ArtifactConfig {
  /** Agent producing the artifact. */
  agent: 'designer' | 'planner' | 'tester-plan' | 'tester-report' | 'brainstorm';
  /** Title for the artifact (used in filename). */
  title: string;
  /** Repo root path (for resolving relative paths). */
  repoPath: string;
  /** The raw content (markdown from LLM output). */
  markdownContent: string;
  /** The HTML-assembled content (if available from assembly step). */
  htmlContent?: string | undefined;
}

export interface SaveResult {
  format: ArtifactFormat;
  path: string;
  size: number;
}

// ---------------------------------------------------------------------------
// Default paths
// ---------------------------------------------------------------------------

const DEFAULT_DIRS: Record<ArtifactConfig['agent'], string> = {
  'designer':      'design',
  'planner':       'design',
  'tester-plan':   'test/plans',
  'tester-report': 'test/reports',
  'brainstorm':    'brainstorms',
};

const SUFFIXES: Record<ArtifactConfig['agent'], string> = {
  'designer':      '',
  'planner':       '-plan',
  'tester-plan':   '-test-plan',
  'tester-report': '-test-report',
  'brainstorm':    '',
};

/**
 * Generate the default save path for an artifact.
 */
export function defaultSavePath(config: ArtifactConfig, format: ArtifactFormat): string {
  const dir = DEFAULT_DIRS[config.agent];
  const suffix = SUFFIXES[config.agent];
  const slug = slugify(config.title);
  const ext = format === 'markdown' ? '.md' : format === 'html' ? '.html' : '.pdf';
  return join(config.repoPath, dir, `${slug}${suffix}${ext}`);
}

/**
 * Check which formats are available.
 * Markdown and HTML are always available. PDF requires wkhtmltopdf or weasyprint.
 */
export function availableFormats(): { format: ArtifactFormat; available: boolean; tool?: string }[] {
  return [
    { format: 'markdown', available: true },
    { format: 'html', available: true },
    { format: 'pdf' as const, available: hasPdfTool(), ...(detectPdfTool() ? { tool: detectPdfTool()! } : {}) },
  ];
}

/**
 * Build the gate payload for the save dialog.
 */
export function buildSaveGatePayload(config: ArtifactConfig): {
  gateId: string;
  stage: string;
  title: string;
  content: string;
  actions: Array<{ name: string; label: string; hint?: string; needsInput?: boolean }>;
  context: {
    defaultPaths: Record<ArtifactFormat, string>;
    formats: ReturnType<typeof availableFormats>;
    agent: string;
  };
} {
  const formats = availableFormats();
  const defaultPaths: Record<ArtifactFormat, string> = {
    markdown: defaultSavePath(config, 'markdown'),
    html: defaultSavePath(config, 'html'),
    pdf: defaultSavePath(config, 'pdf'),
  };

  const formatList = formats
    .map(f => `${f.format}${f.available ? '' : ' (unavailable)'}`)
    .join(', ');

  const defaultPath = defaultPaths.markdown;

  return {
    gateId: `save-artifact-${Date.now()}`,
    stage: 'save-artifact',
    title: 'Save document?',
    content: `Format: ${formatList}\nDefault: ${defaultPath}`,
    actions: [
      { name: 'save-md', label: 'Markdown' },
      { name: 'save-html', label: 'HTML' },
      ...(formats[2]!.available ? [{ name: 'save-pdf', label: 'PDF' }] : []),
      { name: 'save-custom', label: 'Change path...', needsInput: true },
      { name: 'skip', label: 'Skip' },
    ],
    context: {
      defaultPaths,
      formats,
      agent: config.agent,
    },
  };
}

/**
 * Save the artifact in the requested format.
 */
export function saveArtifact(
  config: ArtifactConfig,
  format: ArtifactFormat,
  customPath?: string | undefined,
): SaveResult {
  const savePath = customPath ?? defaultSavePath(config, format);

  // Ensure directory exists
  const dir = dirname(savePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    log.info({ dir }, 'created directory');
  }

  let content: string;
  let finalPath = savePath;

  switch (format) {
    case 'markdown':
      content = config.markdownContent;
      // Ensure .md extension
      if (extname(finalPath) !== '.md') finalPath += '.md';
      writeFileSync(finalPath, content, 'utf-8');
      break;

    case 'html':
      content = config.htmlContent ?? wrapInHtmlTemplate(config.markdownContent, config.title);
      // Ensure .html extension
      if (extname(finalPath) !== '.html') finalPath += '.html';
      writeFileSync(finalPath, content, 'utf-8');
      break;

    case 'pdf': {
      // First save as HTML, then convert
      const htmlPath = finalPath.replace(/\.pdf$/, '.html');
      const html = config.htmlContent ?? wrapInHtmlTemplate(config.markdownContent, config.title);
      writeFileSync(htmlPath, html, 'utf-8');

      const pdfPath = extname(finalPath) !== '.pdf' ? finalPath + '.pdf' : finalPath;
      convertToPdf(htmlPath, pdfPath);
      finalPath = pdfPath;

      // Clean up temp HTML
      try { require('node:fs').unlinkSync(htmlPath); } catch { /* keep if PDF failed */ }
      break;
    }
  }

  const size = require('node:fs').statSync(finalPath).size;
  log.info({ path: finalPath, format, size }, 'artifact saved');

  return { format, path: finalPath, size };
}

/**
 * Parse a gate reply action into format + optional custom path.
 */
export function parseGateReply(
  action: string,
  feedback?: string | undefined,
  defaultPaths?: Record<ArtifactFormat, string>,
): { format: ArtifactFormat; customPath?: string } | null {
  switch (action) {
    case 'save-md':
      return { format: 'markdown' };
    case 'save-html':
      return { format: 'html' };
    case 'save-pdf':
      return { format: 'pdf' };
    case 'save-custom': {
      if (!feedback) return null;
      // Try to detect format from the path extension
      const ext = extname(feedback.trim()).toLowerCase();
      const format: ArtifactFormat =
        ext === '.html' ? 'html' :
        ext === '.pdf' ? 'pdf' :
        'markdown';
      return { format, customPath: feedback.trim() };
    }
    case 'skip':
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// HTML template
// ---------------------------------------------------------------------------

function wrapInHtmlTemplate(markdown: string, title: string): string {
  // Simple markdown → HTML conversion (headings, code blocks, bold, lists)
  let html = markdown
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/^\- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^(?!<[huplo])/gm, '');

  html = `<p>${html}</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg: #0f1117; --surface: #1a1d27; --border: #2a2d3a; --text: #e2e4ed;
      --muted: #8b8fa8; --accent: #7c6af7; --accent2: #4fc3f7;
      --green: #4caf7d; --yellow: #f5c842; --red: #f47c7c; --code-bg: #12151e;
      font-family: 'Segoe UI', system-ui, sans-serif; font-size: 15px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); line-height: 1.7; padding: 2rem; }
    main { max-width: 960px; margin: 0 auto; }
    h1 { font-size: 2rem; color: var(--accent); margin-bottom: 0.25rem; }
    h2 { font-size: 1.3rem; color: var(--accent2); margin: 2.5rem 0 0.75rem; border-bottom: 1px solid var(--border); padding-bottom: 0.4rem; }
    h3 { font-size: 1.05rem; color: var(--yellow); margin: 1.5rem 0 0.5rem; }
    p { margin: 0.6rem 0; }
    .muted { color: var(--muted); font-size: 0.9rem; }
    pre { background: var(--code-bg); border: 1px solid var(--border); border-radius: 6px; padding: 1rem; overflow-x: auto; font-size: 0.88rem; margin: 0.8rem 0; }
    code { font-family: 'Fira Code', 'Consolas', monospace; }
    ul, ol { margin: 0.5rem 0; padding-left: 1.5rem; }
    li { margin: 0.2rem 0; }
    table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
    th, td { border: 1px solid var(--border); padding: 0.5rem 0.8rem; text-align: left; }
    th { background: var(--surface); color: var(--accent2); font-size: 0.9rem; }
    strong { color: var(--accent2); }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p class="muted">Generated by insrc</p>
    ${html}
  </main>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// PDF conversion
// ---------------------------------------------------------------------------

function hasPdfTool(): boolean {
  return detectPdfTool() !== null;
}

function detectPdfTool(): string | null {
  try {
    execSync('which wkhtmltopdf', { stdio: 'pipe' });
    return 'wkhtmltopdf';
  } catch { /* not found */ }

  try {
    execSync('which weasyprint', { stdio: 'pipe' });
    return 'weasyprint';
  } catch { /* not found */ }

  try {
    execSync('python3 -c "import weasyprint"', { stdio: 'pipe' });
    return 'python3-weasyprint';
  } catch { /* not found */ }

  return null;
}

function convertToPdf(htmlPath: string, pdfPath: string): void {
  const tool = detectPdfTool();
  if (!tool) {
    throw new Error('No PDF conversion tool found. Install wkhtmltopdf or weasyprint.');
  }

  switch (tool) {
    case 'wkhtmltopdf':
      execSync(`wkhtmltopdf --quiet "${htmlPath}" "${pdfPath}"`, { timeout: 30_000 });
      break;
    case 'weasyprint':
      execSync(`weasyprint "${htmlPath}" "${pdfPath}"`, { timeout: 30_000 });
      break;
    case 'python3-weasyprint':
      execSync(`python3 -c "import weasyprint; weasyprint.HTML(filename='${htmlPath}').write_pdf('${pdfPath}')"`, { timeout: 30_000 });
      break;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
