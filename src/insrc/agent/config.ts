import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { PATHS } from '../shared/paths.js';
import type {
  AgentConfig,
  AgentProviderConfigs,
  CloudProviderConfig,
  CloudProviderName,
  LLMProvider,
  LocalProviderConfig,
  ModelParams,
  ProviderName,
  StepBinding,
} from '../shared/types.js';
import { getLogger } from '../shared/logger.js';
import { buildProvider } from './providers/factory.js';

const log = getLogger('config');

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_LOCAL_CORE  = 'qwen3-coder:latest';
const DEFAULT_LOCAL_EMBED = 'qwen3-embedding:4b';
const DEFAULT_LOCAL_EMBED_DIM = 2560;
const DEFAULT_LOCAL_HOST = 'http://localhost:11434';
const DEFAULT_LOCAL_PARAMS: ModelParams = { maxInputTokens: 16_384, maxOutputTokens: 8_192 };
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const DEFAULT_ANTHROPIC_PARAMS: ModelParams = { maxInputTokens: 200_000, maxOutputTokens: 8_192 };

function defaultLocalProvider(): LocalProviderConfig {
  return {
    host: DEFAULT_LOCAL_HOST,
    coreModel: DEFAULT_LOCAL_CORE,
    embeddingModel: DEFAULT_LOCAL_EMBED,
    embeddingDim: DEFAULT_LOCAL_EMBED_DIM,
    charsPerToken: 3,
    params: {
      [DEFAULT_LOCAL_CORE]: { ...DEFAULT_LOCAL_PARAMS },
    },
  };
}

function emptyCloudProvider(): CloudProviderConfig {
  return { default: null, enabled: [], params: {} };
}

const DEFAULT_CONFIG: AgentConfig = {
  models: {
    activeProvider: null,
    visionDefault: null,
    providers: {
      local: defaultLocalProvider(),
      openai: emptyCloudProvider(),
      anthropic: emptyCloudProvider(),
      gemini: emptyCloudProvider(),
      mistral: emptyCloudProvider(),
    },
  },
  keys: {},
  permissions: {
    mode: 'validate',
  },
};

// ---------------------------------------------------------------------------
// Load (with automatic migration from the legacy schema)
// ---------------------------------------------------------------------------

/**
 * Synchronous config load -- reads config.json only, no keychain.
 * Used at module-level initialization (embedder, db layers).
 *
 * Transparently migrates the legacy schema (`models.local`,
 * `models.tiers.*`, `models.context.*`, `models.embedding*`,
 * `ollama.host`, `routing.*`) into the new provider-first shape.
 */
export function loadConfig(): AgentConfig {
  if (!existsSync(PATHS.config)) return cloneDefault();

  try {
    const raw = JSON.parse(readFileSync(PATHS.config, 'utf8')) as Record<string, unknown>;
    const { config, migrated } = mergeConfig(raw);
    if (migrated) {
      try {
        writeFileSync(PATHS.config, JSON.stringify(serialize(config), null, 2) + '\n', 'utf8');
        log.info('[config] migrated config.json to new provider schema');
      } catch (err) {
        log.warn({ err }, 'failed to rewrite config.json after schema migration');
      }
    }
    return config;
  } catch (err) {
    log.warn({ err }, `failed to parse ${PATHS.config}`);
    return cloneDefault();
  }
}

/**
 * Async config load -- reads config.json, migrates plaintext keys to
 * OS keychain, then loads keys from keychain. Used at daemon/agent startup.
 */
export async function loadConfigWithKeys(): Promise<AgentConfig> {
  const config = loadConfig();

  try {
    if (existsSync(PATHS.config)) {
      const raw = JSON.parse(readFileSync(PATHS.config, 'utf8')) as Record<string, unknown>;
      await migrateKeysToKeychain(raw);
    }
    await hydrateKeysFromKeychain(config);
  } catch (err) {
    log.warn({ err }, 'failed to load keys from keychain');
  }

  return config;
}

/** Load config with project-level overrides merged in. */
export async function loadConfigForRepo(repoPath: string): Promise<AgentConfig> {
  const { resolveConfig } = await import('../config/loader.js');
  const config = await resolveConfig(repoPath);

  try {
    if (existsSync(PATHS.config)) {
      const raw = JSON.parse(readFileSync(PATHS.config, 'utf8')) as Record<string, unknown>;
      await migrateKeysToKeychain(raw);
    }
    await hydrateKeysFromKeychain(config);
  } catch (err) {
    log.warn({ err }, 'failed to load keys from keychain in loadConfigForRepo');
  }

  return config;
}

async function hydrateKeysFromKeychain(config: AgentConfig): Promise<void> {
  const { getKey } = await import('../shared/keystore.js');
  for (const account of ['anthropic', 'openai', 'gemini', 'mistral', 'brave'] as const) {
    const v = await getKey(account);
    if (v) config.keys[account] = v;
  }
  // Env-var fallbacks (only when keychain didn't supply a value)
  const ENV = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai:    'OPENAI_API_KEY',
    gemini:    'GEMINI_API_KEY',
    mistral:   'MISTRAL_API_KEY',
    brave:     'BRAVE_API_KEY',
  } as const;
  for (const [account, envName] of Object.entries(ENV) as Array<[keyof typeof ENV, string]>) {
    if (!config.keys[account]) {
      const fromEnv = process.env[envName];
      if (fromEnv) config.keys[account] = fromEnv;
    }
  }
}

/**
 * Migrate plaintext keys from config.json to OS keychain.
 * Removes the `keys` section from the JSON after successful migration.
 */
async function migrateKeysToKeychain(raw: Record<string, unknown>): Promise<void> {
  const keys = typeof raw['keys'] === 'object' && raw['keys'] !== null
    ? raw['keys'] as Record<string, string>
    : null;
  if (!keys) return;

  const { setKey } = await import('../shared/keystore.js');
  let migrated = false;

  for (const [name, value] of Object.entries(keys)) {
    if (typeof value === 'string' && value.length > 0) {
      await setKey(name, value);
      log.info(`[config] migrated '${name}' key to OS keychain`);
      migrated = true;
    }
  }

  if (migrated) {
    delete raw['keys'];
    try {
      writeFileSync(PATHS.config, JSON.stringify(raw, null, 2) + '\n', 'utf8');
      log.info('[config] removed plaintext keys from config.json');
    } catch (err) {
      log.warn({ err }, 'failed to rewrite config.json after key migration');
    }
  }
}

// ---------------------------------------------------------------------------
// Provider resolver -- per-agent step-level provider selection
// ---------------------------------------------------------------------------

/**
 * Resolves LLM providers for agent steps based on config.
 *
 * Each agent has named steps (e.g. 'pair'/'propose', 'designer'/'review').
 * Steps can be bound to any configured provider via
 * `config.models.agents[agent][step]`. Unbound steps fall back to the
 * `activeProvider`'s default (cloud) or local if no active provider.
 */
export class ProviderResolver {
  constructor(
    private readonly config: AgentConfig,
    private readonly local: LLMProvider,
    private readonly cloud: LLMProvider | null,
  ) {}

  /**
   * Resolve provider for an agent step. Returns local provider as fallback
   * when a cloud provider is configured but its key is unavailable.
   */
  resolve(agent: string, step: string): LLMProvider {
    return this.doResolve(agent, step, false) ?? this.local;
  }

  /**
   * Like resolve() but returns null when the step maps to a cloud provider
   * and that provider is unavailable. Used for optional cloud slots.
   */
  resolveOrNull(agent: string, step: string): LLMProvider | null {
    return this.doResolve(agent, step, true);
  }

  private doResolve(agent: string, step: string, nullOnMissing: boolean): LLMProvider | null {
    const agentCfg = this.config.models.agents;
    const binding = agentCfg?.[agent as keyof AgentProviderConfigs]?.[step];

    if (binding === undefined) {
      // No binding -> fall back to active provider's default, or local
      const active = this.config.models.activeProvider;
      if (!active) {
        return nullOnMissing ? this.cloud : this.local;
      }
      const def = this.config.models.providers[active].default;
      if (!def) {
        return nullOnMissing ? this.cloud : this.local;
      }
      return this.resolveBinding({ provider: active, model: def }, nullOnMissing);
    }

    const parsed = parseBinding(binding, this.config);
    return this.resolveBinding(parsed, nullOnMissing);
  }

  private resolveBinding(
    parsed: { provider: ProviderName; model: string },
    nullOnMissing: boolean,
  ): LLMProvider | null {
    if (parsed.provider === 'local') {
      return this.local;
    }

    // Cloud provider -- need API key
    const apiKey = this.config.keys[parsed.provider as CloudProviderName];
    if (!apiKey) {
      if (nullOnMissing) return null;
      log.warn(
        `${parsed.provider} configured for ${parsed.model} but no API key -- falling back to local`,
      );
      return this.local;
    }

    return buildProvider({ provider: parsed.provider, model: parsed.model }, this.config);
  }
}

/** Parse a string or StepBinding into a resolved { provider, model }. */
function parseBinding(
  binding: string | StepBinding,
  config: AgentConfig,
): { provider: ProviderName; model: string } {
  if (typeof binding === 'string') {
    if (binding === 'local') {
      return { provider: 'local', model: config.models.providers.local.coreModel };
    }
    // Cloud provider shorthand (e.g. "anthropic", "openai") -> that provider's default
    if (binding === 'openai' || binding === 'anthropic' || binding === 'gemini' || binding === 'mistral') {
      const def = config.models.providers[binding].default;
      if (def) return { provider: binding, model: def };
      return fallbackBinding(config);
    }
    // Unknown string -> treat as local model name
    return { provider: 'local', model: binding };
  }

  // StepBinding object
  if (binding.provider === 'local') {
    return { provider: 'local', model: binding.model ?? config.models.providers.local.coreModel };
  }
  if (binding.model) {
    return { provider: binding.provider, model: binding.model };
  }
  const def = config.models.providers[binding.provider].default;
  if (def) return { provider: binding.provider, model: def };
  return fallbackBinding(config);
}

function fallbackBinding(config: AgentConfig): { provider: ProviderName; model: string } {
  const active = config.models.activeProvider;
  if (active) {
    const def = config.models.providers[active].default;
    if (def) return { provider: active, model: def };
  }
  return { provider: 'local', model: config.models.providers.local.coreModel };
}

// ---------------------------------------------------------------------------
// Helpers: clone, merge, migrate, serialize
// ---------------------------------------------------------------------------

function cloneDefault(): AgentConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as AgentConfig;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function mergeAgents(raw: unknown): AgentProviderConfigs | undefined {
  if (!isObject(raw)) return undefined;
  return raw as AgentProviderConfigs;
}

function parseModelParams(raw: unknown, defaults: ModelParams): ModelParams {
  if (!isObject(raw)) return { ...defaults };
  return {
    maxInputTokens:  typeof raw['maxInputTokens']  === 'number' ? raw['maxInputTokens']  : defaults.maxInputTokens,
    maxOutputTokens: typeof raw['maxOutputTokens'] === 'number' ? raw['maxOutputTokens'] : defaults.maxOutputTokens,
  };
}

function parseParamsMap(raw: unknown, defaults: ModelParams): Record<string, ModelParams> {
  if (!isObject(raw)) return {};
  const out: Record<string, ModelParams> = {};
  for (const [model, v] of Object.entries(raw)) {
    out[model] = parseModelParams(v, defaults);
  }
  return out;
}

function parseCloudProvider(raw: unknown): CloudProviderConfig {
  if (!isObject(raw)) return emptyCloudProvider();
  const enabled = Array.isArray(raw['enabled'])
    ? (raw['enabled'] as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  return {
    default: typeof raw['default'] === 'string' ? raw['default'] : null,
    enabled,
    params: parseParamsMap(raw['params'], { maxInputTokens: 128_000, maxOutputTokens: 8_192 }),
  };
}

function parseLocalProvider(raw: unknown): LocalProviderConfig {
  const base = defaultLocalProvider();
  if (!isObject(raw)) return base;
  return {
    host:           typeof raw['host']           === 'string' ? raw['host']           : base.host,
    coreModel:      typeof raw['coreModel']      === 'string' ? raw['coreModel']      : base.coreModel,
    embeddingModel: typeof raw['embeddingModel'] === 'string' ? raw['embeddingModel'] : base.embeddingModel,
    embeddingDim:   typeof raw['embeddingDim']   === 'number' ? raw['embeddingDim']   : base.embeddingDim,
    charsPerToken:  typeof raw['charsPerToken']  === 'number' ? raw['charsPerToken']  : base.charsPerToken,
    params: parseParamsMap(raw['params'], DEFAULT_LOCAL_PARAMS),
  };
}

/**
 * Parse raw JSON into an AgentConfig. Returns `migrated: true` when the
 * raw input looked like the legacy schema and was converted.
 */
function mergeConfig(raw: Record<string, unknown>): { config: AgentConfig; migrated: boolean } {
  const looksLegacy = detectLegacy(raw);
  const source = looksLegacy ? convertLegacy(raw) : raw;

  const models = isObject(source['models']) ? source['models'] : {};
  const providersRaw = isObject(models['providers']) ? models['providers'] : {};

  const providers = {
    local:     parseLocalProvider(providersRaw['local']),
    openai:    parseCloudProvider(providersRaw['openai']),
    anthropic: parseCloudProvider(providersRaw['anthropic']),
    gemini:    parseCloudProvider(providersRaw['gemini']),
    mistral:   parseCloudProvider(providersRaw['mistral']),
  };

  const activeRaw = models['activeProvider'];
  const activeProvider: CloudProviderName | null =
    activeRaw === 'openai' || activeRaw === 'anthropic' || activeRaw === 'gemini' || activeRaw === 'mistral'
      ? activeRaw
      : null;

  const vision = models['visionDefault'];
  const visionDefault = isObject(vision) && typeof vision['provider'] === 'string' && typeof vision['model'] === 'string'
    ? { provider: vision['provider'] as ProviderName, model: vision['model'] }
    : null;

  const keys = isObject(source['keys']) ? source['keys'] as Record<string, string> : {};
  const permissions = isObject(source['permissions']) ? source['permissions'] as Record<string, unknown> : {};

  const config: AgentConfig = {
    models: {
      activeProvider,
      visionDefault,
      providers,
      agents: mergeAgents(models['agents']),
    },
    keys: {
      anthropic: keys['anthropic'],
      openai:    keys['openai'],
      gemini:    keys['gemini'],
      mistral:   keys['mistral'],
      brave:     keys['brave'],
    },
    permissions: {
      mode: permissions['mode'] === 'auto-accept' ? 'auto-accept' : 'validate',
    },
    ...(isObject(source['classifier'])
      ? {
          classifier: {
            confirmIntent: (source['classifier'] as Record<string, unknown>)['confirmIntent'] === true,
          },
        }
      : {}),
  };

  return { config, migrated: looksLegacy };
}

function detectLegacy(raw: Record<string, unknown>): boolean {
  const m = isObject(raw['models']) ? raw['models'] : null;
  if (!m) return false;
  // Legacy sentinels: tiers object, top-level local string, context block,
  // embedding string -- all absent in the new schema.
  return 'tiers' in m || 'local' in m || 'context' in m || 'embedding' in m || 'embeddingDim' in m;
}

/**
 * Convert the old flat config shape to the new provider-nested shape.
 * Non-destructive: returns a new object; does not mutate `raw`.
 */
function convertLegacy(raw: Record<string, unknown>): Record<string, unknown> {
  const m = isObject(raw['models']) ? raw['models'] : {};
  const tiers = isObject(m['tiers']) ? m['tiers'] as Record<string, string> : {};
  const context = isObject(m['context']) ? m['context'] as Record<string, unknown> : {};
  const oldOllama = isObject(raw['ollama']) ? raw['ollama'] as Record<string, unknown> : {};

  const localCore  = typeof m['local']     === 'string' ? m['local']     : DEFAULT_LOCAL_CORE;
  const localEmbed = typeof m['embedding'] === 'string' ? m['embedding'] : DEFAULT_LOCAL_EMBED;
  const localEmbedDim = typeof m['embeddingDim'] === 'number' ? m['embeddingDim'] : DEFAULT_LOCAL_EMBED_DIM;
  const localHost  = typeof oldOllama['host'] === 'string' ? oldOllama['host'] : DEFAULT_LOCAL_HOST;
  const localCtx   = typeof context['local']          === 'number' ? context['local']          : DEFAULT_LOCAL_PARAMS.maxInputTokens;
  const localOut   = typeof context['localMaxOutput'] === 'number' ? context['localMaxOutput'] : DEFAULT_LOCAL_PARAMS.maxOutputTokens;
  const charsPer   = typeof context['charsPerToken']  === 'number' ? context['charsPerToken']  : 3;

  const anthroModel = tiers['standard'] ?? DEFAULT_ANTHROPIC_MODEL;
  const anthroEnabled = Array.from(new Set(
    [tiers['fast'], tiers['standard'], tiers['powerful']].filter((v): v is string => typeof v === 'string'),
  ));
  const anthroCtx = typeof context['claude']          === 'number' ? context['claude']          : DEFAULT_ANTHROPIC_PARAMS.maxInputTokens;
  const anthroOut = typeof context['claudeMaxOutput'] === 'number' ? context['claudeMaxOutput'] : DEFAULT_ANTHROPIC_PARAMS.maxOutputTokens;

  const hadAnthropic = anthroEnabled.length > 0;
  const active = hadAnthropic ? 'anthropic' : null;

  const anthropicParams: Record<string, ModelParams> = {};
  for (const model of anthroEnabled) {
    anthropicParams[model] = { maxInputTokens: anthroCtx, maxOutputTokens: anthroOut };
  }

  const converted: Record<string, unknown> = {
    ...raw,
    models: {
      activeProvider: active,
      visionDefault: null,
      providers: {
        local: {
          host: localHost,
          coreModel: localCore,
          embeddingModel: localEmbed,
          embeddingDim: localEmbedDim,
          charsPerToken: charsPer,
          params: {
            [localCore]: { maxInputTokens: localCtx, maxOutputTokens: localOut },
          },
        },
        anthropic: {
          default: hadAnthropic ? anthroModel : null,
          enabled: anthroEnabled,
          params: anthropicParams,
        },
        openai:  emptyCloudProvider(),
        gemini:  emptyCloudProvider(),
        mistral: emptyCloudProvider(),
      },
      ...(isObject(m['agents']) ? { agents: m['agents'] } : {}),
    },
  };

  // Drop legacy top-level fields (ollama, routing) -- their contents are now
  // under providers.local / removed entirely.
  delete converted['ollama'];
  delete converted['routing'];

  return converted;
}

function serialize(config: AgentConfig): Record<string, unknown> {
  // Strip `keys` before writing -- keys live in the keychain.
  const { keys: _keys, ...rest } = config;
  void _keys;
  return rest as unknown as Record<string, unknown>;
}
