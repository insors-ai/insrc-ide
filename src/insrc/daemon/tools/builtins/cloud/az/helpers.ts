/**
 * Shared helpers for `az` CLI tools.
 *
 * Every az:* tool accepts (subscription, resourceGroup). Most Azure
 * verbs are resource-group scoped so we centralize the flag names
 * here; individual tools can still accept ARM-specific knobs like
 * --location.
 */

import type { ToolInput } from '../../../types.js';

export interface AzFlags {
  subscription?: string;
  resourceGroup?: string;
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

export function azFlags(input: ToolInput): AzFlags {
  const out: AzFlags = {};
  const s = str(input, 'subscription');
  const g = str(input, 'resourceGroup');
  if (s) { out.subscription = s; }
  if (g) { out.resourceGroup = g; }
  return out;
}

export function azArgv(flags: AzFlags, { includeResourceGroup = true }: { includeResourceGroup?: boolean } = {}): string[] {
  const args: string[] = [];
  if (flags.subscription)                     { args.push('--subscription', flags.subscription); }
  if (includeResourceGroup && flags.resourceGroup) { args.push('--resource-group', flags.resourceGroup); }
  return args;
}

export function azScope(flags: AzFlags): string {
  const parts: string[] = [];
  if (flags.subscription)  { parts.push(`subscription=${flags.subscription}`); }
  if (flags.resourceGroup) { parts.push(`rg=${flags.resourceGroup}`); }
  return parts.length > 0 ? parts.join(', ') : 'current az context';
}

export const AZ_SCHEMA = {
  subscription:  { type: 'string', description: 'Subscription name or ID.' },
  resourceGroup: { type: 'string', description: 'Target resource group.' },
} as const;

export function tryParseJson(stdout: string): unknown {
  try { return JSON.parse(stdout); } catch { return null; }
}
