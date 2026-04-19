/**
 * Provider RPC handlers.
 *
 * Exposes four operations to the IDE:
 *   providers.listModels({ provider }) -> { models: [...] }
 *   providers.getConfig()               -> { models }
 *   providers.setConfig(patch)          -> { ok: true }
 *   providers.testKey({ provider })     -> { ok, error? }
 *
 * Keys are read from the OS keychain (via shared/keystore). The
 * `models` slice of `~/.insrc/config.json` is rewritten atomically on
 * setConfig and the daemon's in-memory config is reloaded afterwards.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Ollama } from 'ollama';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { Mistral } from '@mistralai/mistralai';

import { PATHS } from '../shared/paths.js';
import { getKey } from '../shared/keystore.js';
import { loadConfig } from '../agent/config.js';
import { getLogger } from '../shared/logger.js';
import type {
  AgentConfig,
  CloudProviderName,
  ProviderName,
} from '../shared/types.js';

const log = getLogger('providers');

// ---------------------------------------------------------------------------
// Shapes returned over the RPC wire
// ---------------------------------------------------------------------------

export interface ListedModel {
  id: string;
  description?: string | undefined;
  maxInputTokens?: number | undefined;
  maxOutputTokens?: number | undefined;
  /** Hint for whether this model can participate in embedding selection
   *  (local only; cloud providers return false). */
  embedding?: boolean | undefined;
}

export interface ListModelsResult {
  models: ListedModel[];
}

export interface TestKeyResult {
  ok: boolean;
  error?: string | undefined;
}

// ---------------------------------------------------------------------------
// listModels
// ---------------------------------------------------------------------------

export async function listModelsForProvider(provider: ProviderName): Promise<ListModelsResult> {
  const cfg = loadConfig();
  switch (provider) {
    case 'local':     return listLocalModels(cfg);
    case 'openai':    return listOpenAIModels();
    case 'anthropic': return listAnthropicModels();
    case 'gemini':    return listGeminiModels();
    case 'mistral':   return listMistralModels();
    default: {
      const unknown: never = provider;
      throw new Error(`Unknown provider: ${String(unknown)}`);
    }
  }
}

async function listLocalModels(cfg: AgentConfig): Promise<ListModelsResult> {
  const host = cfg.models.providers.local.host;
  const ollama = new Ollama({ host });
  try {
    const { models } = await ollama.list();
    const out: ListedModel[] = models.map(m => ({
      id: m.name,
      description: m.details?.family ?? undefined,
      // Heuristic: names containing "embed" are embedding models.
      embedding: /embed/i.test(m.name),
    }));
    return { models: out };
  } catch (err) {
    throw new Error(`Ollama list failed: ${errMsg(err)}`);
  }
}

async function listOpenAIModels(): Promise<ListModelsResult> {
  const apiKey = await resolveKey('openai');
  if (!apiKey) throw new Error('No OpenAI API key configured.');
  const client = new OpenAI({ apiKey });
  try {
    const page = await client.models.list();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any[] = Array.isArray((page as any).data) ? (page as any).data : [];
    const out: ListedModel[] = data
      .filter(m => typeof m?.id === 'string')
      .map(m => ({ id: m.id as string }));
    return { models: out };
  } catch (err) {
    throw new Error(`OpenAI list failed: ${errMsg(err)}`);
  }
}

async function listAnthropicModels(): Promise<ListModelsResult> {
  const apiKey = await resolveKey('anthropic');
  if (!apiKey) throw new Error('No Anthropic API key configured.');
  const client = new Anthropic({ apiKey });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page = await (client as any).models.list({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any[] = Array.isArray(page?.data) ? page.data : [];
    const out: ListedModel[] = data
      .filter(m => typeof m?.id === 'string')
      .map(m => ({
        id: m.id as string,
        description: typeof m.display_name === 'string' ? m.display_name : undefined,
      }));
    return { models: out };
  } catch (err) {
    throw new Error(`Anthropic list failed: ${errMsg(err)}`);
  }
}

async function listGeminiModels(): Promise<ListModelsResult> {
  const apiKey = await resolveKey('gemini');
  if (!apiKey) throw new Error('No Gemini API key configured.');
  const client = new GoogleGenAI({ apiKey });
  try {
    const page = await client.models.list();
    const out: ListedModel[] = [];
    // AsyncIterable of Model objects
    for await (const model of page) {
      const name = typeof model?.name === 'string' ? model.name : undefined;
      if (!name) continue;
      // Strip "models/" prefix so the IDs look like "gemini-2.0-flash"
      const id = name.startsWith('models/') ? name.slice('models/'.length) : name;
      out.push({
        id,
        description: typeof model.displayName === 'string' ? model.displayName : undefined,
        maxInputTokens:  typeof model.inputTokenLimit  === 'number' ? model.inputTokenLimit  : undefined,
        maxOutputTokens: typeof model.outputTokenLimit === 'number' ? model.outputTokenLimit : undefined,
      });
    }
    return { models: out };
  } catch (err) {
    throw new Error(`Gemini list failed: ${errMsg(err)}`);
  }
}

async function listMistralModels(): Promise<ListModelsResult> {
  const apiKey = await resolveKey('mistral');
  if (!apiKey) throw new Error('No Mistral API key configured.');
  const client = new Mistral({ apiKey });
  try {
    const page = await client.models.list();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any[] = Array.isArray((page as any)?.data) ? (page as any).data : [];
    const out: ListedModel[] = data
      .filter(m => typeof m?.id === 'string')
      .map(m => ({
        id: m.id as string,
        description: typeof m.description === 'string' ? m.description : undefined,
        maxInputTokens: typeof m.maxContextLength === 'number' ? m.maxContextLength : undefined,
      }));
    return { models: out };
  } catch (err) {
    throw new Error(`Mistral list failed: ${errMsg(err)}`);
  }
}

// ---------------------------------------------------------------------------
// testKey
// ---------------------------------------------------------------------------

export async function testProviderKey(provider: ProviderName): Promise<TestKeyResult> {
  try {
    await listModelsForProvider(provider);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

// ---------------------------------------------------------------------------
// getConfig / setConfig
// ---------------------------------------------------------------------------

/**
 * Returns the `models` slice of the current config. Never includes
 * secrets -- those live in the keychain.
 */
export function getProvidersConfig(): AgentConfig['models'] {
  const cfg = loadConfig();
  return cfg.models;
}

/**
 * Validates and persists a partial `models` slice, then asks the caller
 * to reload in-memory config. Special handling for active-provider
 * changes: clears `agents` and `visionDefault` wholesale (plan locked
 * behavior).
 */
export function setProvidersConfig(
  patch: Partial<AgentConfig['models']>,
): { ok: true; models: AgentConfig['models'] } {
  const rawOnDisk: Record<string, unknown> = existsSync(PATHS.config)
    ? (() => {
        try { return JSON.parse(readFileSync(PATHS.config, 'utf8')) as Record<string, unknown>; }
        catch { return {}; }
      })()
    : {};

  const current = loadConfig();
  const nextModels: AgentConfig['models'] = mergeModelsPatch(current.models, patch);

  // Clear agents / visionDefault if activeProvider changed.
  if (patch.activeProvider !== undefined && patch.activeProvider !== current.models.activeProvider) {
    nextModels.agents = {};
    nextModels.visionDefault = null;
    log.info(
      { from: current.models.activeProvider, to: patch.activeProvider },
      'active provider changed -- cleared agents bindings and visionDefault',
    );
  }

  rawOnDisk['models'] = nextModels as unknown as Record<string, unknown>;
  // Never write `keys` back -- keychain is authoritative.
  if ('keys' in rawOnDisk) delete rawOnDisk['keys'];
  writeFileSync(PATHS.config, JSON.stringify(rawOnDisk, null, 2) + '\n', 'utf8');

  return { ok: true, models: nextModels };
}

function mergeModelsPatch(
  current: AgentConfig['models'],
  patch: Partial<AgentConfig['models']>,
): AgentConfig['models'] {
  const merged: AgentConfig['models'] = {
    activeProvider: patch.activeProvider !== undefined ? patch.activeProvider : current.activeProvider,
    visionDefault:  patch.visionDefault  !== undefined ? patch.visionDefault  : current.visionDefault,
    providers: {
      local:     { ...current.providers.local,     ...(patch.providers?.local     ?? {}) },
      openai:    { ...current.providers.openai,    ...(patch.providers?.openai    ?? {}) },
      anthropic: { ...current.providers.anthropic, ...(patch.providers?.anthropic ?? {}) },
      gemini:    { ...current.providers.gemini,    ...(patch.providers?.gemini    ?? {}) },
      mistral:   { ...current.providers.mistral,   ...(patch.providers?.mistral   ?? {}) },
    },
    ...(patch.agents !== undefined
      ? { agents: patch.agents }
      : current.agents !== undefined
        ? { agents: current.agents }
        : {}),
  };
  return merged;
}

// ---------------------------------------------------------------------------
// NOT_CONFIGURED check
// ---------------------------------------------------------------------------

export type NotConfiguredMissing = 'local' | 'provider' | 'both';

export interface NotConfiguredError {
  code: 'NOT_CONFIGURED';
  missing: NotConfiguredMissing;
  message: string;
}

/**
 * Returns null if the config is usable, otherwise a structured
 * `NOT_CONFIGURED` payload suitable to throw or return from any agent
 * RPC. "Usable" means local has a coreModel + embeddingModel (required
 * because embeddings are local-only) and either local's core is set or
 * an activeProvider has an API key + default.
 */
export function checkConfigured(cfg: AgentConfig): NotConfiguredError | null {
  const local = cfg.models.providers.local;
  const localOk = Boolean(local.coreModel) && Boolean(local.embeddingModel);

  const active = cfg.models.activeProvider;
  const cloudOk = (() => {
    if (!active) return false;
    const c = cfg.models.providers[active];
    const hasKey = Boolean(cfg.keys[active]);
    return Boolean(c.default) && c.enabled.length > 0 && hasKey;
  })();

  if (localOk && (cloudOk || true)) {
    // Local is required (embeddings); cloud is optional. Treat config
    // as usable if local is configured; the router falls back to local
    // when no cloud is active.
    return null;
  }

  if (!localOk && !cloudOk) return toError('both');
  if (!localOk)             return toError('local');
  return toError('provider');
}

function toError(missing: NotConfiguredMissing): NotConfiguredError {
  return {
    code: 'NOT_CONFIGURED',
    missing,
    message: missingMessage(missing),
  };
}

function missingMessage(missing: NotConfiguredMissing): string {
  switch (missing) {
    case 'local':    return 'Local model is not configured. Pick a core model + embedding model in Model Providers > Local.';
    case 'provider': return 'No cloud provider is configured. Pick an active provider with a default model and API key, or stay on local-only.';
    case 'both':     return 'Neither local nor any cloud provider is configured. Open Model Providers to set up local first.';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveKey(name: CloudProviderName): Promise<string | undefined> {
  const fromChain = await getKey(name);
  if (fromChain) return fromChain;
  const envName =
    name === 'openai'    ? 'OPENAI_API_KEY'
    : name === 'anthropic' ? 'ANTHROPIC_API_KEY'
    : name === 'gemini'  ? 'GEMINI_API_KEY'
    :                       'MISTRAL_API_KEY';
  return process.env[envName];
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
