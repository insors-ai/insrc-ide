/**
 * Tests for the Phase J.4 first-turn framing detector.
 *
 * The detector regexes the FIRST paragraph of a section. True =
 * process-narration framing ("I will investigate...", "Let me start
 * by..."). False = subject topic sentence ("The HDFS layer spans...").
 *
 * Used as a measurement signal -- the J.1 prompt rewrite tells the
 * writer to open with subject framing; this metric tells us whether
 * the rewrite is landing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { _isProcessNarrationFramingForTest as isFraming } from '../write-section.js';

test('framing-detector: subject topic sentence -> false', () => {
	assert.equal(isFraming('The HDFS layer spans three repository module trees.'), false);
	assert.equal(isFraming('Hadoop is an open-source distributed computing framework.'), false);
	assert.equal(isFraming('The YARN ResourceManager exposes 86 DAO classes under webapp/dao/.'), false);
});

test('framing-detector: process-narration opener -> true', () => {
	assert.equal(isFraming('I will investigate the test architecture by examining unit tests.'), true);
	assert.equal(isFraming("I'll start by examining the configuration files."), true);
	assert.equal(isFraming('Let me start by examining the test module structure.'), true);
	assert.equal(isFraming('Let me investigate Hadoop\'s configuration management.'), true);
	assert.equal(isFraming("I'll examine the YARN ResourceManager."), true);
	assert.equal(isFraming('I need to investigate the protocol records.'), true);
});

test('framing-detector: case-insensitive', () => {
	assert.equal(isFraming('I WILL INVESTIGATE the test architecture.'), true);
	assert.equal(isFraming('let me start by examining the configuration.'), true);
});

test('framing-detector: empty / whitespace -> false', () => {
	assert.equal(isFraming(''), false);
	assert.equal(isFraming('   \n\n   '), false);
});

test('framing-detector: subject sentence containing "I will" mid-sentence -> false', () => {
	// "I will" or "let me" mid-paragraph (not anchored at start) must NOT trigger.
	assert.equal(
		isFraming('The HDFS reader (which I will describe next) is BlockReader.'),
		false,
	);
});

test('framing-detector: "Let me check" (not in subject-narration list) -> false', () => {
	// We only flag investigate-style narrations as bad first turns. Other
	// phrasings are caught by the loop-side transition-phrase nudge if
	// they show up as CLOSING paragraphs.
	assert.equal(isFraming('Let me check the configuration file count.'), false);
});
