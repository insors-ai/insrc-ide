/**
 * Shared retry-with-exponential-backoff for cloud LLM provider calls
 * (Anthropic / OpenAI / Gemini / Mistral). A single network blip
 * killing a long-running section-flow run is not acceptable -- the
 * orchestrator drops minutes of work and the user re-runs from scratch.
 *
 * Scope: connection-establishment failures and transient HTTP errors
 * (429 / 5xx / 408 / 425). Permanent errors (4xx auth, bad request)
 * bubble immediately. Mid-stream failures are not retried here --
 * resumption would replay partial output.
 *
 * Classification mirrors what every cloud SDK actually throws:
 *   - SDK error with .status -> use status code
 *   - Lower-level network error -> match .code (ECONNRESET etc.) or
 *     message keywords ("fetch failed", "socket hang up")
 *
 * Backoff schedule: base = 1s, doubles each attempt, capped at 16s,
 * plus 0-25% jitter. Default cap is 3 attempts (1 try + 2 retries).
 * If the server returns Retry-After, that header wins.
 */

import type { Logger } from 'pino';

const DEFAULT_MAX_ATTEMPTS  = 3;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS  = 16_000;

export interface CloudRetryOpts {
	readonly label:           string;
	readonly log:             Logger;
	readonly maxAttempts?:    number | undefined;
	readonly baseDelayMs?:    number | undefined;
	readonly maxDelayMs?:     number | undefined;
}

export interface CloudErrorClassification {
	readonly transient:      boolean;
	readonly reason:         string;
	readonly retryAfterMs?:  number | undefined;
}

export async function withCloudRetry<T>(
	fn:   () => Promise<T>,
	opts: CloudRetryOpts,
): Promise<T> {
	const maxAttempts  = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
	const baseDelayMs  = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
	const maxDelayMs   = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

	let lastErr: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			const classified = classifyCloudError(err);
			if (!classified.transient || attempt >= maxAttempts) {
				if (attempt > 1) {
					opts.log.warn({
						attempt,
						maxAttempts,
						reason: classified.reason,
						transient: classified.transient,
						err: String(err),
					}, `${opts.label}: cloud retry giving up`);
				}
				throw err;
			}
			const exp     = baseDelayMs * 2 ** (attempt - 1);
			const capped  = Math.min(exp, maxDelayMs);
			const base    = classified.retryAfterMs ?? capped;
			const jitter  = Math.floor(base * 0.25 * Math.random());
			const delayMs = base + jitter;
			opts.log.warn({
				attempt,
				nextAttempt: attempt + 1,
				maxAttempts,
				reason: classified.reason,
				delayMs,
				retryAfter: classified.retryAfterMs,
				err: String(err),
			}, `${opts.label}: transient cloud error -- retrying`);
			await sleep(delayMs);
		}
	}
	throw lastErr ?? new Error(`${opts.label}: cloud retry loop exited without resolution`);
}

/**
 * Classify a cloud provider error. Status-bearing errors win because
 * SDKs (Anthropic, OpenAI) always attach .status on HTTP failures;
 * pure network errors surface lower-level Node fetch / undici codes.
 */
export function classifyCloudError(err: unknown): CloudErrorClassification {
	const e = err as { status?: unknown; response?: { status?: unknown }; code?: unknown; message?: unknown; cause?: unknown; headers?: Record<string, unknown> };

	const status = pickStatus(e);
	if (status !== undefined) {
		if (status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600)) {
			const retryAfterMs = parseRetryAfterMs(e);
			return retryAfterMs !== undefined
				? { transient: true, reason: `http_${status}`, retryAfterMs }
				: { transient: true, reason: `http_${status}` };
		}
		return { transient: false, reason: `http_${status}` };
	}

	const code = typeof e?.code === 'string' ? e.code : '';
	if (TRANSIENT_NETWORK_CODES.has(code)) {
		return { transient: true, reason: code };
	}

	const msg = typeof e?.message === 'string' ? e.message : String(err);
	if (TRANSIENT_MESSAGE_RE.test(msg)) {
		return { transient: true, reason: 'network' };
	}

	const cause = e?.cause as { code?: unknown; message?: unknown } | undefined;
	if (cause !== undefined) {
		const causeCode = typeof cause.code === 'string' ? cause.code : '';
		if (TRANSIENT_NETWORK_CODES.has(causeCode)) {
			return { transient: true, reason: `cause_${causeCode}` };
		}
		const causeMsg = typeof cause.message === 'string' ? cause.message : '';
		if (TRANSIENT_MESSAGE_RE.test(causeMsg)) {
			return { transient: true, reason: 'cause_network' };
		}
	}

	return { transient: false, reason: 'unknown' };
}

const TRANSIENT_NETWORK_CODES = new Set([
	'ECONNRESET',
	'ETIMEDOUT',
	'EPIPE',
	'EAI_AGAIN',
	'ENETUNREACH',
	'ENOTFOUND',
	'ECONNREFUSED',
	'UND_ERR_SOCKET',
	'UND_ERR_CONNECT_TIMEOUT',
	'UND_ERR_HEADERS_TIMEOUT',
	'UND_ERR_BODY_TIMEOUT',
]);

const TRANSIENT_MESSAGE_RE = /fetch failed|socket hang up|Connection error|network (?:error|timeout)|terminated|aborted by|other side closed|request to .* failed/i;

function pickStatus(e: { status?: unknown; response?: { status?: unknown } }): number | undefined {
	if (typeof e?.status === 'number') return e.status;
	const respStatus = e?.response?.status;
	if (typeof respStatus === 'number') return respStatus;
	return undefined;
}

function parseRetryAfterMs(e: { headers?: Record<string, unknown> }): number | undefined {
	const headers = e?.headers;
	if (!headers || typeof headers !== 'object') return undefined;
	const raw = headers['retry-after'] ?? headers['Retry-After'];
	if (raw === undefined || raw === null) return undefined;
	const s = String(raw).trim();
	const seconds = Number(s);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, DEFAULT_MAX_DELAY_MS * 4);
	const date = Date.parse(s);
	if (!Number.isNaN(date)) {
		const delta = date - Date.now();
		if (delta > 0) return Math.min(delta, DEFAULT_MAX_DELAY_MS * 4);
	}
	return undefined;
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

export const _retryConstantsForTest = {
	DEFAULT_MAX_ATTEMPTS,
	DEFAULT_BASE_DELAY_MS,
	DEFAULT_MAX_DELAY_MS,
	TRANSIENT_NETWORK_CODES,
	TRANSIENT_MESSAGE_RE,
};
