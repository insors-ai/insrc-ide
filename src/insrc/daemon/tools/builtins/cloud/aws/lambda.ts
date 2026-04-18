/**
 * AWS Lambda -- invoke (batch 1). List / update come in batch 2.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runShell } from '../../../shell-helper.js';
import type { Tool, ToolApprovalGate, ToolInput, ToolResult } from '../../../types.js';
import { AWS_SCHEMA, awsArgv, awsFlags, awsScope, str, tryParseJson } from './helpers.js';

function fail(id: string, msg: string): ToolResult {
  return { output: `[${id}] ${msg}`, format: 'text', success: false, error: msg };
}

// ---------------------------------------------------------------------------
// cloud:aws:lambda:invoke
// ---------------------------------------------------------------------------

interface AwsLambdaInvokeData {
  functionName: string;
  invocationType: string;
  exitCode: number | null;
  payloadPath: string;
  responsePath: string;
  cliStdout: string;
  responseBody: string;
  parsedResponse: unknown;
  statusCode: number | undefined;
  functionError: string | undefined;
}

export const awsLambdaInvokeTool: Tool = {
  id: 'cloud:aws:lambda:invoke',
  description: 'Invoke a Lambda function (RequestResponse by default) and return its response.',
  inputSchema: {
    type: 'object',
    properties: {
      functionName: { type: 'string', description: 'Name, ARN, or partial ARN.' },
      payload: { description: 'JSON-serializable payload (object/array/string/number/etc).' },
      payloadString: { type: 'string', description: 'Use raw string as payload. Overrides `payload`.' },
      invocationType: { type: 'string', enum: ['RequestResponse', 'Event', 'DryRun'] },
      qualifier: { type: 'string', description: 'Version or alias.' },
      logType: { type: 'string', enum: ['None', 'Tail'], description: 'Include last 4KB of log in LogResult.' },
      ...AWS_SCHEMA,
    },
    required: ['functionName'],
    additionalProperties: false,
  },
  requiresApproval: true,

  buildApprovalGate(input: ToolInput): ToolApprovalGate {
    const flags = awsFlags(input);
    const invocationType = str(input, 'invocationType') ?? 'RequestResponse';
    const preview = input['payloadString'] !== undefined && typeof input['payloadString'] === 'string'
      ? (input['payloadString'] as string)
      : input['payload'] !== undefined
        ? JSON.stringify(input['payload'], null, 2)
        : '{}';
    return {
      title: 'cloud:aws:lambda:invoke',
      content: [
        `Scope: **${awsScope(flags)}**`,
        `Function: \`${str(input, 'functionName')}\` (${invocationType})`,
        '',
        '**Payload**',
        '```json',
        preview.slice(0, 2000),
        '```',
      ].join('\n'),
      actions: [
        { name: 'approve', label: 'Approve' },
        { name: 'skip', label: 'Skip' },
      ],
    };
  },

  async execute(input: ToolInput): Promise<ToolResult> {
    const fn = str(input, 'functionName');
    if (!fn) { return fail('cloud:aws:lambda:invoke', 'functionName required'); }
    const flags = awsFlags(input);
    const invocationType = str(input, 'invocationType') ?? 'RequestResponse';

    const payloadStr = typeof input['payloadString'] === 'string'
      ? (input['payloadString'] as string)
      : JSON.stringify(input['payload'] ?? {});
    const payloadPath = join(tmpdir(), `insrc-lambda-in-${process.pid}-${Date.now()}.json`);
    const responsePath = join(tmpdir(), `insrc-lambda-out-${process.pid}-${Date.now()}.json`);
    await fs.writeFile(payloadPath, payloadStr, 'utf8');

    const argv = [
      'aws', 'lambda', 'invoke',
      '--function-name', fn,
      '--payload', `fileb://${payloadPath}`,
      '--invocation-type', invocationType,
      '--cli-binary-format', 'raw-in-base64-out',
    ];
    const qualifier = str(input, 'qualifier');
    if (qualifier) { argv.push('--qualifier', qualifier); }
    const logType = str(input, 'logType');
    if (logType)   { argv.push('--log-type', logType); }
    argv.push(...awsArgv(flags));
    argv.push(responsePath);

    try {
      const r = await runShell(argv, { timeoutMs: 15 * 60_000 });
      if (r.spawnError) { return fail('cloud:aws:lambda:invoke', `aws CLI not found: ${r.stderr.trim()}`); }

      let responseBody = '';
      try { responseBody = await fs.readFile(responsePath, 'utf8'); } catch { /* may be empty for Event type */ }

      const cliJson = tryParseJson(r.stdout);
      let statusCode: number | undefined;
      let functionError: string | undefined;
      if (cliJson && typeof cliJson === 'object') {
        const j = cliJson as Record<string, unknown>;
        if (typeof j['StatusCode'] === 'number') { statusCode = j['StatusCode']; }
        if (typeof j['FunctionError'] === 'string') { functionError = j['FunctionError']; }
      }
      const parsedResponse = tryParseJson(responseBody);
      const ok = r.code === 0 && !functionError;

      const data: AwsLambdaInvokeData = {
        functionName: fn,
        invocationType,
        exitCode: r.code,
        payloadPath, responsePath,
        cliStdout: r.stdout,
        responseBody,
        parsedResponse,
        statusCode,
        functionError,
      };
      return {
        output: [
          ok
            ? `Invoked \`${fn}\` (${invocationType})${statusCode !== undefined ? ` -> status ${statusCode}` : ''}.`
            : `**Invoke failed** (exit ${r.code}${functionError ? `, ${functionError}` : ''}).`,
          responseBody ? '\n**Response**\n```json\n' + responseBody.slice(0, 4000).replace(/\n+$/, '') + '\n```' : '',
          r.stderr ? '\n**stderr**\n```\n' + r.stderr.replace(/\n+$/, '') + '\n```' : '',
        ].filter(Boolean).join('\n'),
        format: 'markdown',
        success: ok,
        ...(ok ? {} : { error: functionError ?? `exit ${r.code}` }),
        data,
      };
    } finally {
      try { await fs.unlink(payloadPath); } catch { /* ignore */ }
      try { await fs.unlink(responsePath); } catch { /* ignore */ }
    }
  },
};
