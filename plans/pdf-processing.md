# PDF Processing Pipeline

## Overview

When a user attaches a PDF to chat, convert each page to an image, use Claude Haiku (vision) to extract text from each page, store extracted text in a temp session cache, and make it available to the agent for Q&A.

## Pipeline

```
User attaches PDF
  → daemon detects .pdf extension in file refs
  → pdfjs-dist renders each page to PNG (2x scale)
  → Claude Haiku (vision) extracts text from each PNG
  → Extracted text stored in session temp cache
  → Progress streamed to IDE ("Processing page 1/5...")
  → Text injected into context as file attachment
  → Agent can answer questions about the PDF content
```

## Architecture

### 1. PDF renderer (daemon/pdf-renderer.ts)

```typescript
interface PDFPage {
  pageNumber: number;
  imageBuffer: Buffer;   // PNG
  width: number;
  height: number;
}

async function renderPDF(pdfPath: string, scale?: number): Promise<PDFPage[]>
```

- Uses `pdfjs-dist` for PDF parsing
- Uses `@napi-rs/canvas` for image rendering (cross-platform prebuilt binaries)
- Default scale 2.0 (good quality for OCR without being too large)
- Returns PNG buffers per page

### 2. Text extractor (daemon/pdf-extractor.ts)

```typescript
interface ExtractedPage {
  pageNumber: number;
  text: string;
  tables?: string[];     // markdown tables if detected
  metadata?: string;     // page headers, footers
}

async function extractTextFromPages(
  pages: PDFPage[],
  claudeProvider: ClaudeProvider,
  onProgress?: (page: number, total: number) => void,
): Promise<ExtractedPage[]>
```

- Sends each page image to Claude Haiku with prompt:
  ```
  Extract all text from this PDF page image. Preserve:
  - Headings and structure
  - Tables as markdown tables
  - Lists and bullet points
  - Code blocks
  Return only the extracted text, no commentary.
  ```
- Uses `claude-haiku-4-5` (cheapest, fastest, supports vision)
- Streams progress per page
- Handles multi-column layouts, tables, diagrams

### 3. Session PDF cache (daemon/pdf-cache.ts)

```typescript
interface CachedPDF {
  path: string;
  hash: string;
  pages: ExtractedPage[];
  totalPages: number;
  extractedAt: string;
}

class SessionPDFCache {
  get(pdfPath: string): CachedPDF | undefined;
  set(pdfPath: string, data: CachedPDF): void;
  getFullText(pdfPath: string): string;  // all pages concatenated
  getPageText(pdfPath: string, page: number): string;
}
```

- Per-session cache (lives on ActiveSession alongside fileCache)
- Hash-based change detection (skip re-extraction if unchanged)
- Full text concatenation for context injection

### 4. Integration with file-refs (daemon/file-refs.ts)

When `resolveFileRefs` encounters a `.pdf` file:
1. Check PDF cache — if cached and unchanged, use cached text
2. If not cached: render → extract → cache → return text
3. Return `FileRefResult` with extracted text as content
4. Multi-page PDFs become chunks (one per page) for the context system

### 5. Chat handler integration (daemon/chat-handler.ts)

- Detect PDF in file refs
- Show progress: "Processing PDF: page 1/N..."
- After extraction, inject as context (same as large file chunks)
- Persist extracted text in session for follow-up questions

## Dependencies

- `pdfjs-dist` — PDF parsing + text layer extraction (pure JS, no native deps)
- `@napi-rs/canvas` — cross-platform canvas for image rendering (prebuilt binaries, no compilation)
  - linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64
  - Zero build tools needed, just `npm install @napi-rs/canvas`
- Claude Haiku API — for vision-based text extraction of scanned pages

## Hybrid approach (recommended)

1. **First try pdfjs-dist text layer** — extract text directly from PDF structure (no image needed, no API cost)
2. **If text layer is empty/poor** (scanned PDFs, image-heavy docs) — fall back to image + Haiku vision
3. **Always use Haiku for tables/diagrams** — even in text PDFs, images capture layout better

```typescript
import { getDocument } from 'pdfjs-dist';
import { createCanvas } from '@napi-rs/canvas';

async function processPDF(pdfPath: string, claude: ClaudeProvider): Promise<ExtractedPage[]> {
  const data = readFileSync(pdfPath);
  const doc = await getDocument({ data }).promise;
  const pages: ExtractedPage[] = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);

    // Try text layer first (free, fast)
    const textContent = await page.getTextContent();
    const text = textContent.items.map(item => item.str).join(' ');

    if (text.trim().length > 50) {
      // Good text layer -- use directly
      pages.push({ pageNumber: i, text });
    } else {
      // Scanned/image page -- render to PNG via @napi-rs/canvas
      const viewport = page.getViewport({ scale: 2.0 });
      const canvas = createCanvas(viewport.width, viewport.height);
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      const pngBuffer = canvas.toBuffer('image/png');

      // Send to Claude Haiku for text extraction
      const extracted = await extractWithHaiku(pngBuffer, claude);
      pages.push({ pageNumber: i, text: extracted });
    }
  }

  return pages;
}
```

## Files to create

| File | Purpose |
|------|---------|
| `src/insrc/daemon/pdf-processor.ts` | PDF rendering + text extraction pipeline |

## Files to modify

| File | Change |
|------|--------|
| `src/insrc/daemon/file-refs.ts` | Detect .pdf, call processor, return extracted text |
| `src/insrc/daemon/chat-handler.ts` | Progress feedback for PDF processing |
| `src/insrc/daemon/chat-sessions.ts` | Add pdfCache to ActiveSession |
| `package.json` (insrc) | Add pdfjs-dist + @napi-rs/canvas dependencies |

## Cost estimate

- Haiku vision: ~$0.001 per page (1 image input + text output)
- A 20-page PDF: ~$0.02
- Text layer extraction: free (no API call)

## Verification

1. Attach a text PDF to chat — should extract via text layer (no API cost)
2. Attach a scanned PDF — should render images and use Haiku
3. Ask "what does page 3 say?" — should retrieve cached page text
4. Attach same PDF again — should use cache (no re-extraction)
5. Check progress messages: "Processing PDF: page 1/5..."
