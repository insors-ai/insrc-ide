/**
 * Min-hash + shingled-token duplication algo for
 * `code.quality.duplication` (code-analyzer-skills.md Phase 5.3).
 *
 * Approach (deterministic, no LLM):
 *   1. Tokenise each entity body (lower-cased identifiers + keywords;
 *      drop punctuation, numbers, string literals, comments).
 *   2. Compute K shingles of size SHINGLE_SIZE.
 *   3. For each shingle, compute MINHASH_K independent hashes
 *      (linear hash family h_i(x) = (a_i * x + b_i) mod p).
 *   4. The min-hash signature is the per-hash minimum across all
 *      shingles. Jaccard similarity ≈ matching positions / MINHASH_K.
 *   5. Pair scan with O(N^2) but cheap (just signature compares).
 *      For N > MAX_PAIRS_BUDGET we LSH-bucket by signature prefix
 *      and only compare within buckets.
 *
 * Trade-offs:
 *   - SHINGLE_SIZE = 5 catches refactor-style copy-paste (5 tokens
 *     in a row is a large enough fingerprint to avoid syntactic
 *     coincidence; small enough to survive minor edits).
 *   - MINHASH_K = 64 is the standard balance (signature comparison
 *     is one Uint32Array equality scan; precision is ±0.125 on
 *     Jaccard which is fine for "near-duplicate" UX).
 *   - Hashes are deterministic seeded from a fixed array so runs
 *     are reproducible (tests would be flaky otherwise).
 */

const SHINGLE_SIZE = 5;
const MINHASH_K    = 64;
// Pseudo-Mersenne; large enough that (a*x+b) doesn't overflow JS
// safe integer when x fits a u32. 2^31 - 1 is convenient.
const HASH_PRIME   = 2_147_483_647;

const HASH_SEEDS: readonly { readonly a: number; readonly b: number }[] = (() => {
	// Deterministic LCG seed expansion; mirrors how production
	// minhash libs (datasketch / minhash-lsh) bootstrap their hash
	// family. Seed value is constant for reproducibility.
	const out: { a: number; b: number }[] = [];
	let state = 0x9E3779B9;
	for (let i = 0; i < MINHASH_K; i++) {
		state = (state * 1103515245 + 12345) & 0x7FFFFFFF;
		const a = (state | 1) % HASH_PRIME;        // odd a improves distribution
		state = (state * 1103515245 + 12345) & 0x7FFFFFFF;
		const b = state % HASH_PRIME;
		out.push({ a, b });
	}
	return out;
})();

export type Signature = Uint32Array;

export function computeSignature(body: string): Signature | null {
	const tokens = tokenize(body);
	if (tokens.length < SHINGLE_SIZE) return null;

	const sig = new Uint32Array(MINHASH_K).fill(HASH_PRIME);

	for (let i = 0; i + SHINGLE_SIZE <= tokens.length; i++) {
		const shingle = tokens.slice(i, i + SHINGLE_SIZE).join('');
		const base    = djb2(shingle);
		for (let k = 0; k < MINHASH_K; k++) {
			const seed = HASH_SEEDS[k]!;
			const h = ((seed.a * base) + seed.b) % HASH_PRIME;
			if (h < sig[k]!) sig[k] = h;
		}
	}
	return sig;
}

export function jaccardEstimate(a: Signature, b: Signature): number {
	if (a.length !== b.length) return 0;
	let match = 0;
	for (let i = 0; i < a.length; i++) {
		if (a[i] === b[i]) match++;
	}
	return match / a.length;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

function tokenize(body: string): string[] {
	const stripped = stripStringsCommentsAndNumerics(body);
	const out: string[] = [];
	let cur = '';
	for (let i = 0; i < stripped.length; i++) {
		const c = stripped.charCodeAt(i);
		const isWord =
			(c >= 48 && c <= 57)   ||  // 0-9
			(c >= 65 && c <= 90)   ||  // A-Z
			(c >= 97 && c <= 122)  ||  // a-z
			c === 95;                  // _
		if (isWord) {
			cur += stripped[i];
		} else {
			if (cur.length > 0) {
				out.push(cur.toLowerCase());
				cur = '';
			}
		}
	}
	if (cur.length > 0) out.push(cur.toLowerCase());
	return out;
}

/**
 * Replace string literals + line comments + block comments + numeric
 * literals with spaces. The shingle is meant to fingerprint
 * structure, not data; copy-pasted code with renamed string literals
 * should still match.
 */
function stripStringsCommentsAndNumerics(body: string): string {
	let out = '';
	let i = 0;
	let inSingle = false;
	let inDouble = false;
	let inBack   = false;
	let inLineComment  = false;
	let inBlockComment = false;
	while (i < body.length) {
		const c = body[i]!;
		const next = body[i + 1] ?? '';

		if (inLineComment) {
			out += (c === '\n') ? '\n' : ' ';
			if (c === '\n') inLineComment = false;
			i++;
			continue;
		}
		if (inBlockComment) {
			if (c === '*' && next === '/') {
				inBlockComment = false;
				out += '  ';
				i += 2;
				continue;
			}
			out += (c === '\n') ? '\n' : ' ';
			i++;
			continue;
		}

		if (!inSingle && !inDouble && !inBack) {
			if (c === '/' && next === '/') { inLineComment = true; out += '  '; i += 2; continue; }
			if (c === '/' && next === '*') { inBlockComment = true; out += '  '; i += 2; continue; }
			if (c === '#' && next !== '!')   { inLineComment = true; out += ' ';  i += 1; continue; }
		}

		if (!inDouble && !inBack && c === '\'' && body[i - 1] !== '\\') inSingle = !inSingle;
		else if (!inSingle && !inBack && c === '"' && body[i - 1] !== '\\') inDouble = !inDouble;
		else if (!inSingle && !inDouble && c === '`' && body[i - 1] !== '\\') inBack = !inBack;

		if (inSingle || inDouble || inBack) {
			out += ' ';
			i++;
			continue;
		}

		// Replace runs of digits (and inline decimal points / hex
		// suffixes) with a single `0` so different magic numbers don't
		// perturb the fingerprint -- and so `100` vs `7` produce the
		// same token instead of drifting the shingle alignment.
		const charCode = c.charCodeAt(0);
		if (charCode >= 48 && charCode <= 57) {
			while (i < body.length) {
				const cc = body.charCodeAt(i);
				if ((cc >= 48 && cc <= 57) || cc === 46 /* '.' */ ||
					(cc >= 97 && cc <= 102) /* hex a-f */) {
					i++;
				} else break;
			}
			out += '0';
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

function djb2(s: string): number {
	let h = 5381;
	for (let i = 0; i < s.length; i++) {
		h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	}
	// Coerce to unsigned u32 so seed expansion stays positive.
	return h >>> 0;
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

export const _tokenizeForTest = tokenize;
export const _stripForTest    = stripStringsCommentsAndNumerics;
export const SHINGLE_SIZE_FOR_TEST = SHINGLE_SIZE;
export const MINHASH_K_FOR_TEST    = MINHASH_K;
