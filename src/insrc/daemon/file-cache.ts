/**
 * Per-session file cache — tracks referenced files across turns.
 *
 * Benefits:
 *   - Skip re-reading unchanged files (hash + mtime check)
 *   - Detect when a referenced file changes mid-session
 *   - Reuse chunks across turns for the same file
 *   - Select only query-relevant chunks per turn
 */

import { readFileSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getLogger } from '../shared/logger.js';
import { splitDocument, type DocChunk } from './doc-splitter.js';

const log = getLogger('file-cache');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CachedFile {
  /** Absolute file path */
  path: string;
  /** SHA-256 hash of file content */
  hash: string;
  /** File modification time (ms) */
  mtime: number;
  /** File size in bytes */
  size: number;
  /** Full file content (for small files) or undefined (for chunked files) */
  content?: string | undefined;
  /** Document chunks (for large files) */
  chunks: DocChunk[];
  /** How many turns this file has been referenced in */
  accessCount: number;
  /** Last turn index that accessed this file */
  lastAccessTurn: number;
}

export interface ChunkSelection {
  /** Selected chunks relevant to the current query */
  chunks: DocChunk[];
  /** Whether the file was re-read (changed since last access) */
  changed: boolean;
  /** Whether the file content was cached (not re-read) */
  fromCache: boolean;
  /** Total chunks available */
  totalChunks: number;
}

// ---------------------------------------------------------------------------
// Session file cache
// ---------------------------------------------------------------------------

const SMALL_FILE_THRESHOLD = 12_000; // chars (~4K tokens)
const MAX_CACHED_FILES = 50;

export class SessionFileCache {
  private readonly cache = new Map<string, CachedFile>();
  private currentTurn = 0;

  /** Set the current turn index (call before each turn's file resolution) */
  setTurn(turn: number): void {
    this.currentTurn = turn;
  }

  /**
   * Get file content from cache or read from disk.
   * Returns cached chunks if file hasn't changed.
   */
  getOrRead(filePath: string, maxTokensPerChunk = 4000): CachedFile {
    const existing = this.cache.get(filePath);

    // Check if file still exists
    if (!existsSync(filePath)) {
      if (existing) {
        this.cache.delete(filePath);
      }
      throw new Error(`File not found: ${filePath}`);
    }

    const stat = statSync(filePath);
    const mtime = stat.mtimeMs;

    // Cache hit: file unchanged
    if (existing && existing.mtime === mtime) {
      existing.accessCount++;
      existing.lastAccessTurn = this.currentTurn;
      log.debug({ path: filePath, accessCount: existing.accessCount }, 'file cache hit');
      return existing;
    }

    // Cache miss or file changed: read and process
    const raw = readFileSync(filePath, 'utf-8');
    const hash = createHash('sha256').update(raw).digest('hex').substring(0, 16);

    let content: string | undefined;
    let chunks: DocChunk[] = [];

    if (raw.length <= SMALL_FILE_THRESHOLD) {
      // Small file: store full content
      content = raw;
    } else {
      // Large file: split into chunks
      const split = splitDocument(raw, filePath, { maxTokensPerChunk });
      chunks = split.chunks;
      // Store header as content for reference
      content = split.header;
    }

    const cached: CachedFile = {
      path: filePath,
      hash,
      mtime,
      size: stat.size,
      content,
      chunks,
      accessCount: existing ? existing.accessCount + 1 : 1,
      lastAccessTurn: this.currentTurn,
    };

    this.cache.set(filePath, cached);

    // Evict least-recently-used if cache is full
    if (this.cache.size > MAX_CACHED_FILES) {
      this._evictLRU();
    }

    const changed = existing !== undefined && existing.hash !== hash;
    if (changed) {
      log.info({ path: filePath, oldHash: existing!.hash, newHash: hash }, 'file changed since last access');
    } else {
      log.debug({ path: filePath, chunks: chunks.length }, 'file cached');
    }

    return cached;
  }

  /**
   * Select chunks relevant to a query embedding or keywords.
   * Returns the most relevant chunks up to a budget.
   */
  selectRelevantChunks(
    cached: CachedFile,
    queryKeywords: string[],
    maxChunks = 5,
  ): DocChunk[] {
    if (cached.chunks.length === 0) {
      return [];
    }

    if (cached.chunks.length <= maxChunks) {
      return cached.chunks;
    }

    // Score chunks by keyword overlap
    const scored = cached.chunks.map((chunk, idx) => {
      const lower = chunk.content.toLowerCase();
      let score = 0;
      for (const kw of queryKeywords) {
        if (lower.includes(kw.toLowerCase())) {
          score += 1;
        }
      }
      // Boost first and last chunks (often contain imports and exports)
      if (idx === 0 || idx === cached.chunks.length - 1) {
        score += 0.5;
      }
      return { chunk, score };
    });

    // Sort by score descending, take top N
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxChunks).map(s => s.chunk);
  }

  /** Invalidate a cached file (e.g., when file watcher detects a change) */
  invalidate(filePath: string): void {
    this.cache.delete(filePath);
  }

  /** Get cache stats */
  stats(): { files: number; totalSize: number } {
    let totalSize = 0;
    for (const cached of this.cache.values()) {
      totalSize += cached.size;
    }
    return { files: this.cache.size, totalSize };
  }

  /** Clear all cached files */
  clear(): void {
    this.cache.clear();
  }

  private _evictLRU(): void {
    let oldest: string | undefined;
    let oldestTurn = Infinity;

    for (const [path, cached] of this.cache) {
      if (cached.lastAccessTurn < oldestTurn) {
        oldestTurn = cached.lastAccessTurn;
        oldest = path;
      }
    }

    if (oldest) {
      this.cache.delete(oldest);
      log.debug({ path: oldest }, 'evicted LRU file from cache');
    }
  }
}
