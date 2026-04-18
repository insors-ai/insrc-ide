/**
 * Shared helpers for AWS CLI tools.
 *
 * Every aws:* tool accepts the same (profile, region, endpoint,
 * output) triple; this module standardizes the flag mapping so a
 * caller's AWS_PROFILE / AWS_REGION env vars still take over when
 * the tool is invoked without an explicit override.
 */

import type { ToolInput } from '../../../types.js';

export interface AwsFlags {
  profile?: string;
  region?: string;
  endpointUrl?: string;
  output?: string;
}

export function str(input: ToolInput, key: string): string | undefined {
  const v = input[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function num(input: ToolInput, key: string): number | undefined {
  const v = input[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function bool(input: ToolInput, key: string): boolean | undefined {
  const v = input[key];
  return typeof v === 'boolean' ? v : undefined;
}

export function awsFlags(input: ToolInput): AwsFlags {
  const out: AwsFlags = {};
  const p = str(input, 'profile');
  const r = str(input, 'region');
  const e = str(input, 'endpointUrl');
  const o = str(input, 'output');
  if (p) { out.profile = p; }
  if (r) { out.region = r; }
  if (e) { out.endpointUrl = e; }
  if (o) { out.output = o; }
  return out;
}

/** Render AWS CLI flags for argv. Defaults output=json when unset. */
export function awsArgv(flags: AwsFlags, { defaultJson = true }: { defaultJson?: boolean } = {}): string[] {
  const args: string[] = [];
  if (flags.profile)     { args.push('--profile', flags.profile); }
  if (flags.region)      { args.push('--region', flags.region); }
  if (flags.endpointUrl) { args.push('--endpoint-url', flags.endpointUrl); }
  if (flags.output)      { args.push('--output', flags.output); }
  else if (defaultJson)  { args.push('--output', 'json'); }
  return args;
}

export function awsScope(flags: AwsFlags): string {
  const parts: string[] = [];
  if (flags.profile)     { parts.push(`profile=${flags.profile}`); }
  if (flags.region)      { parts.push(`region=${flags.region}`); }
  if (flags.endpointUrl) { parts.push(`endpoint=${flags.endpointUrl}`); }
  return parts.length > 0 ? parts.join(', ') : 'default profile / region';
}

export const AWS_SCHEMA = {
  profile: { type: 'string', description: 'Named AWS profile (~/.aws/config).' },
  region: { type: 'string', description: 'AWS region override.' },
  endpointUrl: { type: 'string', description: '--endpoint-url (LocalStack etc).' },
  output: { type: 'string', description: 'aws --output. Defaults to json.' },
} as const;

export function tryParseJson(stdout: string): unknown {
  try { return JSON.parse(stdout); } catch { return null; }
}
