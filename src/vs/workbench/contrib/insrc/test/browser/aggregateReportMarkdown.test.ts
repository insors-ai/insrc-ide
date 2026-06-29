/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { formatAggregateReport } from '../../browser/chat/aggregateReportMarkdown.js';

suite('aggregateReportMarkdown', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('full report -> markdown with summary + findings + metadata', () => {
		const md = formatAggregateReport({
			summary: 'The repo defines two services backed by terraform-managed AWS resources.',
			findings: [
				{
					title: 'Two Kubernetes deployments declared',
					detail: 'The `api` and `worker` deployments live in namespace `prod`.',
					sources: ['t02'],
				},
				{
					title: 'Terraform configures an S3 bucket and IAM role',
					detail: '`aws_s3_bucket.logs` + `aws_iam_role.app` from `tf/main.tf`.',
					sources: ['t03', 't04'],
				},
			],
			metadata: {
				target: 'infra',
				scope: 'XS',
				runId: 'abc123',
				tasksAnalyzed: 3,
			},
		});

		assert.match(md, /^# Analysis report$/m);
		assert.match(md, /two services/);
		assert.match(md, /^## Findings$/m);
		assert.match(md, /^### 1\. Two Kubernetes deployments declared$/m);
		assert.match(md, /^### 2\. Terraform configures an S3 bucket and IAM role$/m);
		assert.match(md, /Sources: t02/);
		assert.match(md, /Sources: t03, t04/);
		assert.match(md, /infra · XS · run `abc123` · 3 tasks analyzed/);
	});

	test('missing report -> placeholder document, not empty string', () => {
		const md = formatAggregateReport(undefined);
		assert.match(md, /No report payload was provided/);
		assert.match(md, /^# Analysis report$/m);
	});

	test('empty findings -> placeholder under ## Findings', () => {
		const md = formatAggregateReport({
			summary: 'No findings reached the aggregator.',
			findings: [],
		});
		assert.match(md, /^## Findings$/m);
		assert.match(md, /The aggregator emitted no findings/);
	});

	test('empty summary -> placeholder line, not blank', () => {
		const md = formatAggregateReport({
			summary: '',
			findings: [{ title: 't', detail: 'd', sources: ['t01'] }],
		});
		assert.match(md, /No summary returned by the aggregator/);
	});

	test('untitled finding -> "(untitled finding)" placeholder', () => {
		const md = formatAggregateReport({
			summary: 'x'.repeat(40),
			findings: [{ detail: 'd', sources: ['t01'] }],
		});
		assert.match(md, /^### 1\. \(untitled finding\)$/m);
	});

	test('findings with empty sources -> Sources line omitted', () => {
		const md = formatAggregateReport({
			summary: 'x'.repeat(40),
			findings: [{ title: 't', detail: 'd', sources: [] }],
		});
		assert.doesNotMatch(md, /Sources:/);
	});

	test('1 task analyzed -> singular "task" in metadata', () => {
		const md = formatAggregateReport({
			summary: 'x'.repeat(40),
			findings: [{ title: 't', detail: 'd', sources: ['t01'] }],
			metadata: { target: 'code', scope: 'XS', runId: 'r', tasksAnalyzed: 1 },
		});
		assert.match(md, /1 task analyzed/);
		assert.doesNotMatch(md, /1 tasks analyzed/);
	});

	test('output ends with exactly one trailing newline', () => {
		const md = formatAggregateReport({
			summary: 'short',
			findings: [{ title: 't', detail: 'd', sources: ['t01'] }],
		});
		assert.match(md, /\n$/);
		assert.doesNotMatch(md, /\n\n$/);
	});

	test('metadata partial: missing fields drop out cleanly', () => {
		const md = formatAggregateReport({
			summary: 'x'.repeat(40),
			findings: [{ title: 't', detail: 'd', sources: ['t01'] }],
			metadata: { target: 'data' },  // only target
		});
		assert.match(md, /_data_/);
		assert.doesNotMatch(md, /undefined/);
	});

});
