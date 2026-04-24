/**
 * Tests for agent/tasks/artifacts/offline-bundle.ts.
 *
 * The public surface is tiny:
 *   - sriMatches(content, integrity) -- compare SHA-384/base64 against
 *     an `sha384-<b64>` header. Pure function, the bulk of the tests.
 *   - offlineBundlePath(version) -- trivial join, one sanity check.
 *
 * readVerifiedOfflineBundle is covered transitively in the
 * template-binder integration path; its cache dir is rooted in
 * ~/.insrc so redirecting it here would need process-wide env
 * mutation we don't otherwise need.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';

import { offlineBundlePath, sriMatches } from '../offline-bundle.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sri384(content: string): string {
	const b64 = createHash('sha384').update(content).digest('base64');
	return `sha384-${b64}`;
}

// ---------------------------------------------------------------------------
// sriMatches
// ---------------------------------------------------------------------------

describe('sriMatches', () => {
	it('accepts a matching sha384 hash', () => {
		const content = 'console.log("hello");';
		assert.equal(sriMatches(content, sri384(content)), true);
	});

	it('accepts the empty string against its own sha384', () => {
		// Guards against regressions where "" gets special-cased.
		assert.equal(sriMatches('', sri384('')), true);
	});

	it('rejects a mismatched sha384 hash', () => {
		const header = sri384('the real content');
		assert.equal(sriMatches('tampered content', header), false);
	});

	it('rejects a non-sha384 algorithm header (sha256)', () => {
		const b64 = createHash('sha256').update('payload').digest('base64');
		assert.equal(sriMatches('payload', `sha256-${b64}`), false);
	});

	it('rejects a non-sha384 algorithm header (sha512)', () => {
		const b64 = createHash('sha512').update('payload').digest('base64');
		assert.equal(sriMatches('payload', `sha512-${b64}`), false);
	});

	it('rejects a malformed integrity string (no prefix)', () => {
		const raw = createHash('sha384').update('payload').digest('base64');
		assert.equal(sriMatches('payload', raw), false);
	});

	it('rejects an empty integrity string', () => {
		assert.equal(sriMatches('payload', ''), false);
	});

	it('rejects when the base64 portion is truncated', () => {
		const header = sri384('payload');
		const truncated = header.slice(0, header.length - 4);
		assert.equal(sriMatches('payload', truncated), false);
	});

	it('is case-sensitive on the algorithm prefix', () => {
		// SRI is specified lowercase; uppercase should not match.
		const b64 = createHash('sha384').update('payload').digest('base64');
		assert.equal(sriMatches('payload', `SHA384-${b64}`), false);
	});

	it('distinguishes content byte-for-byte (trailing newline)', () => {
		const header = sri384('payload');
		assert.equal(sriMatches('payload\n', header), false);
	});
});

// ---------------------------------------------------------------------------
// offlineBundlePath
// ---------------------------------------------------------------------------

describe('offlineBundlePath', () => {
	it('builds a path ending in mermaid-<version>.min.js', () => {
		const p = offlineBundlePath('10.9.1');
		assert.ok(p.endsWith('/mermaid-10.9.1.min.js'), `unexpected path: ${p}`);
	});

	it('includes the cache subdir in the path', () => {
		const p = offlineBundlePath('10.9.1');
		assert.ok(p.includes('cache/artifacts/'), `unexpected path: ${p}`);
	});
});
