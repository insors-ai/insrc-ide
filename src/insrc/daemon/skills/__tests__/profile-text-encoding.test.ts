/**
 * Encoding-detection unit tests for `data.profile.text` (Phase 5a.4).
 * Operates on the pure helper exported as `_computeEncodingSignalsForTest`.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { _computeEncodingSignalsForTest as computeEncodingSignals } from '../built-ins/data.profile.text.algo.js';

describe('computeEncodingSignals', () => {
	it('empty sample -> inconclusive', () => {
		const r = computeEncodingSignals([]);
		assert.equal(r.verdict, 'inconclusive');
		assert.equal(r.totalChars, 0);
	});

	it('plain ASCII -> ascii verdict', () => {
		const r = computeEncodingSignals(['hello', 'world', 'abc 123']);
		assert.equal(r.verdict, 'ascii');
		assert.equal(r.asciiOnly, true);
		assert.equal(r.nonAsciiCount, 0);
		assert.equal(r.astralPresent, false);
	});

	it('clean UTF-8 with non-ASCII -> utf8-clean verdict', () => {
		const r = computeEncodingSignals(['café', 'naïve', 'résumé']);
		assert.equal(r.verdict, 'utf8-clean');
		assert.equal(r.asciiOnly, false);
		assert.ok(r.nonAsciiCount > 0);
		assert.ok(r.nonAsciiRate > 0);
	});

	it('emoji / supplementary plane -> astralPresent true, utf8-clean', () => {
		const r = computeEncodingSignals(['hello 👋', '🌟 star']);
		assert.equal(r.astralPresent, true);
		assert.equal(r.verdict, 'utf8-clean');
	});

	it('BOM at start -> has-bom verdict', () => {
		const r = computeEncodingSignals(['﻿hello', 'world']);
		assert.equal(r.bomCount, 1);
		assert.equal(r.verdict, 'has-bom');
	});

	it('control chars present -> control-chars-present verdict', () => {
		const r = computeEncodingSignals(['hello\x00world', 'plain']);
		assert.equal(r.controlCharCount, 1);
		assert.equal(r.verdict, 'control-chars-present');
	});

	it('mojibake markers (Latin-1 decoded as UTF-8) -> mojibake-suspect verdict', () => {
		// Real-world examples: "café" double-decoded becomes "cafÃ©",
		// "they're" becomes "theyâ€™re", "£10" becomes "Â£10".
		const r = computeEncodingSignals(['cafÃ©', 'theyâ€™re', 'Â£10']);
		assert.ok(r.mojibakeSuspectCount >= 2);
		assert.equal(r.verdict, 'mojibake-suspect');
	});

	it('mojibake takes precedence over control chars + BOM', () => {
		// All three signals; mojibake is the most actionable diagnosis.
		const r = computeEncodingSignals(['﻿cafÃ©\x00x']);
		assert.equal(r.verdict, 'mojibake-suspect');
	});

	it('whitespace + tab + newline are not control chars', () => {
		const r = computeEncodingSignals(['line1\nline2\tcol', '   trimmed   ']);
		assert.equal(r.controlCharCount, 0);
		assert.equal(r.verdict, 'ascii');
	});

	it('DEL (0x7F) is treated as a control char', () => {
		const r = computeEncodingSignals(['hello\x7Fworld']);
		assert.equal(r.controlCharCount, 1);
		assert.equal(r.verdict, 'control-chars-present');
	});

	it('non-ASCII rate is computed correctly', () => {
		// 5 ASCII + 1 non-ASCII = nonAsciiRate ~= 1/6
		const r = computeEncodingSignals(['hellö']);
		assert.equal(r.totalChars, 5);
		assert.equal(r.nonAsciiCount, 1);
		assert.ok(Math.abs(r.nonAsciiRate - 0.2) < 0.001);
	});
});
