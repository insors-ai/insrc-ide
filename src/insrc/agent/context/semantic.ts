import type { LLMProvider } from '../../shared/types.js';
import type { ConversationTurn } from './summary.js';

// ---------------------------------------------------------------------------
// L3b — Semantic History
//
// In-memory store of past turns with embeddings. On each new turn, the user
// message is embedded once (shared with L4 code search). The top-K most
// similar past turns are retrieved via cosine similarity.
//
// Skipped for the first MAX_RECENT (5) turns — recent turns are already
// fully visible in L3a.
//
// Phase 5 will persist this to LanceDB via the daemon.
// ---------------------------------------------------------------------------

const TOP_K = 4;
const MIN_TURNS_FOR_SEMANTIC = 5;
const MAX_STORED_TURNS = 50;
const RETRIEVAL_CHAR_LIMIT = 600;

interface StoredTurn {
  turn: ConversationTurn;
  embedding: number[];
  /** Number of times this turn was retrieved (for eviction scoring) */
  retrievalCount: number;
  /** Turn index when added */
  addedAt: number;
}

export class SemanticHistory {
  private readonly store: StoredTurn[] = [];
  private _nextIdx = 0;

  /** Total number of stored turns. */
  get size(): number {
    return this.store.length;
  }

  /**
   * Add a turn with its pre-computed embedding.
   * Evicts lowest-utility turns if store exceeds MAX_STORED_TURNS.
   */
  add(turn: ConversationTurn, embedding: number[]): void {
    if (embedding.length === 0) return;
    this.store.push({ turn, embedding, retrievalCount: 0, addedAt: this._nextIdx++ });

    // Evict if over capacity
    if (this.store.length > MAX_STORED_TURNS) {
      this._evictLowestUtility();
    }
  }

  /**
   * Retrieve the top-K most similar past turns to the query embedding.
   * Returns formatted text blocks ordered by similarity (highest first).
   * Retrieval limit increased to 600 chars per turn for better context.
   */
  retrieve(queryEmbedding: number[], skip: number = MIN_TURNS_FOR_SEMANTIC): string[] {
    return this.topK(queryEmbedding, skip).map(({ turn, score }) => {
      const trimmed = turn.assistantResponse.length > RETRIEVAL_CHAR_LIMIT
        ? turn.assistantResponse.slice(0, RETRIEVAL_CHAR_LIMIT) + '...'
        : turn.assistantResponse;
      return `[similarity=${score.toFixed(3)}] User: ${turn.userMessage}\nAssistant: ${trimmed}`;
    });
  }

  /**
   * Retrieve the raw ConversationTurn objects for the top-K similar turns.
   * Used by the disclosure context builder to collect entity IDs.
   */
  retrieveTurns(queryEmbedding: number[], skip: number = MIN_TURNS_FOR_SEMANTIC): ConversationTurn[] {
    return this.topK(queryEmbedding, skip).map(({ turn }) => turn);
  }

  private topK(queryEmbedding: number[], skip: number): Array<{ turn: ConversationTurn; score: number }> {
    if (this.store.length < skip || queryEmbedding.length === 0) return [];

    const scored = this.store.map((entry, idx) => {
      const score = cosineSimilarity(queryEmbedding, entry.embedding);
      // Track retrieval for eviction scoring
      if (idx < this.store.length) {
        entry.retrievalCount++;
      }
      return { idx, score, turn: entry.turn };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, TOP_K);
  }

  /**
   * Evict the lowest-utility turn.
   * Utility = retrievalCount * 0.5 + recency * 0.5
   * (oldest + least-retrieved gets evicted first)
   */
  private _evictLowestUtility(): void {
    if (this.store.length === 0) return;

    let lowestIdx = 0;
    let lowestScore = Infinity;

    for (let i = 0; i < this.store.length; i++) {
      const entry = this.store[i]!;
      // Normalize: recency 0-1 (oldest=0, newest=1), retrieval 0-1
      const recency = (entry.addedAt - this.store[0]!.addedAt) / Math.max(1, this._nextIdx - this.store[0]!.addedAt);
      const maxRetrievals = Math.max(1, ...this.store.map(e => e.retrievalCount));
      const retrieval = entry.retrievalCount / maxRetrievals;
      const utility = recency * 0.5 + retrieval * 0.5;

      if (utility < lowestScore) {
        lowestScore = utility;
        lowestIdx = i;
      }
    }

    this.store.splice(lowestIdx, 1);
  }
}

/**
 * Embed text using the provider's embed method.
 * Returns empty array on failure (never throws).
 */
export async function embedText(provider: LLMProvider, text: string): Promise<number[]> {
  try {
    return await provider.embed(text);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Vector math
// ---------------------------------------------------------------------------

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
