/**
 * PDF processing pipeline.
 *
 * Hybrid approach:
 *   1. Try pdfjs-dist text layer extraction (free, fast)
 *   2. If text layer is poor (scanned PDF), render to image via @napi-rs/canvas
 *   3. Send images to Claude Haiku (vision) for text extraction
 *
 * Results are cached per-session by file hash.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getLogger } from '../shared/logger.js';

const log = getLogger('pdf');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractedPage {
  pageNumber: number;
  text: string;
  /** Whether this page was extracted via vision (scanned) or text layer */
  method: 'text-layer' | 'vision';
}

export interface ProcessedPDF {
  path: string;
  hash: string;
  totalPages: number;
  pages: ExtractedPage[];
  extractedAt: string;
}

export interface PDFProgressCallback {
  (page: number, total: number, method: string): void;
}

// ---------------------------------------------------------------------------
// PDF Cache
// ---------------------------------------------------------------------------

export class SessionPDFCache {
  private readonly cache = new Map<string, ProcessedPDF>();

  get(pdfPath: string): ProcessedPDF | undefined {
    return this.cache.get(pdfPath);
  }

  set(pdfPath: string, data: ProcessedPDF): void {
    this.cache.set(pdfPath, data);
  }

  getFullText(pdfPath: string): string | undefined {
    const cached = this.cache.get(pdfPath);
    if (!cached) { return undefined; }
    return cached.pages.map(p => `--- Page ${p.pageNumber} ---\n${p.text}`).join('\n\n');
  }

  getPageText(pdfPath: string, page: number): string | undefined {
    const cached = this.cache.get(pdfPath);
    return cached?.pages.find(p => p.pageNumber === page)?.text;
  }

  clear(): void {
    this.cache.clear();
  }
}

// ---------------------------------------------------------------------------
// Main processor
// ---------------------------------------------------------------------------

/**
 * Process a PDF file: extract text from all pages.
 * Uses text layer when available, falls back to Claude Haiku vision for scanned pages.
 *
 * @param pdfPath Absolute path to the PDF file
 * @param claudeApiKey Anthropic API key (needed for scanned page extraction)
 * @param onProgress Callback for per-page progress
 * @param cache Optional session cache to check/store results
 */
export async function processPDF(
  pdfPath: string,
  claudeApiKey: string | null,
  onProgress?: PDFProgressCallback,
  cache?: SessionPDFCache,
): Promise<ProcessedPDF> {
  // Check cache
  const fileData = readFileSync(pdfPath);
  const hash = createHash('sha256').update(fileData).digest('hex').substring(0, 16);

  if (cache) {
    const cached = cache.get(pdfPath);
    if (cached && cached.hash === hash) {
      log.info({ path: pdfPath, pages: cached.totalPages }, 'PDF cache hit');
      return cached;
    }
  }

  // Load PDF
  const pdfjs = await import('pdfjs-dist');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fileData.buffer) }).promise;
  const totalPages = doc.numPages;

  log.info({ path: pdfPath, totalPages }, 'processing PDF');

  const pages: ExtractedPage[] = [];

  for (let i = 1; i <= totalPages; i++) {
    const page = await doc.getPage(i);

    // Try text layer first
    const textContent = await page.getTextContent();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const textItems = (textContent.items as any[]).filter(item => 'str' in item);
    const text = textItems.map(item => item.str as string).join(' ').trim();

    if (text.length > 50) {
      // Good text layer
      onProgress?.(i, totalPages, 'text-layer');
      pages.push({ pageNumber: i, text, method: 'text-layer' });
      log.debug({ page: i, chars: text.length }, 'text layer extraction');
    } else if (claudeApiKey) {
      // Scanned page -- render to image and use Haiku
      onProgress?.(i, totalPages, 'vision');
      try {
        const imageBuffer = await renderPageToImage(page, 2.0);
        const extracted = await extractWithHaiku(imageBuffer, claudeApiKey);
        pages.push({ pageNumber: i, text: extracted, method: 'vision' });
        log.debug({ page: i, chars: extracted.length }, 'vision extraction');
      } catch (err) {
        log.warn({ page: i, error: String(err) }, 'vision extraction failed');
        pages.push({ pageNumber: i, text: `[Page ${i}: extraction failed]`, method: 'vision' });
      }
    } else {
      // No API key, no text layer
      onProgress?.(i, totalPages, 'skipped');
      pages.push({ pageNumber: i, text: `[Page ${i}: scanned image, no API key for extraction]`, method: 'text-layer' });
    }
  }

  const result: ProcessedPDF = {
    path: pdfPath,
    hash,
    totalPages,
    pages,
    extractedAt: new Date().toISOString(),
  };

  cache?.set(pdfPath, result);

  const visionPages = pages.filter(p => p.method === 'vision').length;
  log.info({ path: pdfPath, totalPages, textLayer: totalPages - visionPages, vision: visionPages }, 'PDF processing complete');

  return result;
}

// ---------------------------------------------------------------------------
// Render page to PNG image
// ---------------------------------------------------------------------------

async function renderPageToImage(page: unknown, scale: number): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = page as any;
  const viewport = p.getViewport({ scale });

  const { createCanvas } = await import('@napi-rs/canvas');
  const canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
  const ctx = canvas.getContext('2d');

  await p.render({ canvasContext: ctx, viewport }).promise;

  // Save to temp file and read as buffer
  const tempDir = join(tmpdir(), '.insrc-pdf');
  mkdirSync(tempDir, { recursive: true });
  const tempPath = join(tempDir, `page-${Date.now()}.png`);
  const pngData = await canvas.encode('png');
  writeFileSync(tempPath, pngData);

  return Buffer.from(pngData);
}

// ---------------------------------------------------------------------------
// Extract text from image using Claude Haiku (vision)
// ---------------------------------------------------------------------------

async function extractWithHaiku(imageBuffer: Buffer, apiKey: string): Promise<string> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey });

  const base64 = imageBuffer.toString('base64');

  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: base64,
          },
        },
        {
          type: 'text',
          text: 'Extract all text from this PDF page image. Preserve:\n- Headings and structure\n- Tables as markdown tables\n- Lists and bullet points\n- Code blocks\nReturn only the extracted text, no commentary.',
        },
      ],
    }],
  });

  // Extract text from response
  const textBlock = response.content.find(b => b.type === 'text');
  return textBlock ? textBlock.text : '';
}
