/**
 * Core LLM provider abstraction.
 * All agent logic operates against these interfaces —
 * never directly against Ollama or Anthropic SDK types.
 */

/** A single content block within a multimodal message. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string }   // base64-encoded
  | { type: 'document'; mediaType: string; data: string }; // base64-encoded PDF

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean | undefined;
}

export interface LLMResponse {
  text: string;
  toolCalls?: ToolCall[] | undefined;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
  /** Token usage from the API response (if available). */
  usage?: { inputTokens: number; outputTokens: number } | undefined;
}

export interface CompletionOpts {
  maxTokens?: number;
  temperature?: number;
  tools?: ToolDefinition[] | undefined;
  /** If provided, text tokens are streamed via this callback during complete(). */
  onToken?: ((token: string) => void) | undefined;
  /**
   * Strict-output hint. Three forms:
   *
   *   - `'json'`               -- parseable-JSON constraint (Ollama
   *                               `format: 'json'`). Model output is
   *                               valid JSON of any shape.
   *   - `{ schema: <object> }` -- shape-constrained output. The
   *                               object is a JSON Schema; Ollama
   *                               passes it as `format: <schema>`
   *                               and the constrained decoder emits
   *                               only output that matches.
   *                               Higher leverage than 'json' --
   *                               eliminates schema-violation
   *                               failure modes by construction.
   *                               Same approach instructor-js takes
   *                               for OpenAI's structured-outputs.
   *   - `undefined`            -- no constraint.
   *
   * Providers without server-side support (Anthropic, etc.) ignore
   * the hint; the runner-side parse + retry remains the source of
   * truth in that case.
   */
  responseFormat?: 'json' | { readonly schema: Record<string, unknown> } | undefined;
}

export interface LLMProvider {
  complete(messages: LLMMessage[], opts?: CompletionOpts): Promise<LLMResponse>;
  stream(messages: LLMMessage[], opts?: CompletionOpts): AsyncIterable<string>;
  /** Embed text into a vector. Returns empty array if not supported. */
  embed(text: string): Promise<number[]>;
  readonly supportsTools: boolean;
}

// ---------------------------------------------------------------------------
// Intent taxonomy
// ---------------------------------------------------------------------------

export type Intent =
  | 'implement'
  | 'refactor'
  | 'test'
  | 'debug'
  | 'review'
  | 'document'
  | 'research'
  | 'code-analysis'
  | 'data-analysis'
  | 'plan'
  | 'requirements'
  | 'design'
  | 'brainstorm'
  | 'deploy'
  | 'release'
  | 'infra';

/** Provider identity -- the cloud providers plus Ollama-local. */
export type CloudProviderName = 'openai' | 'anthropic' | 'gemini' | 'mistral';
export type ProviderName = 'local' | CloudProviderName;

/** Explicit @-prefix override used by CLI and classifier. */
export type ExplicitProvider = ProviderName;

// ---------------------------------------------------------------------------
// Agent personas
// ---------------------------------------------------------------------------

export type PersonaName = 'designer' | 'planner' | 'developer' | 'tester' | 'deployer';

/**
 * @deprecated Use `ClassifyResult` from `shared/classify.ts` + the
 * generic classifier module. Kept temporarily during the rewrite; will
 * be removed once every site has migrated to the new shape. Not used
 * by any current code path.
 */
export interface ClassificationResult {
  primary: {
    intent: Intent;
    confidence: number;
    snippet: string;
    reasoning: string;
  };
  secondary?: {
    intent: Intent;
    confidence: number;
    snippet: string;
    reasoning: string;
  } | undefined;
}

export interface Task {
  intent: Intent;
  message: string;
  explicit?: ExplicitProvider | undefined;
  attachments?: Attachment[] | undefined;
  activeFile?: string | undefined;
  selectedEntity?: string | undefined;
}

export interface Attachment {
  kind: 'text' | 'code' | 'image' | 'pdf';
  name: string;
  path: string;
  content?: string | undefined;
}

// ---------------------------------------------------------------------------
// Agent config
// ---------------------------------------------------------------------------

/** Per-model context window parameters. */
export interface ModelParams {
  /** Context window size in tokens. */
  maxInputTokens: number;
  /** Max output tokens per call. */
  maxOutputTokens: number;
}

/** Provider binding for a single LLM operation within an agent. */
export interface StepBinding {
  provider: ProviderName;
  /** Explicit model name (required for cloud providers; optional for local where
   *  there is only one coreModel anyway). */
  model?: string | undefined;
}

/** Per-agent step-level provider config. Keys are step names, values are bindings. */
export type AgentStepConfig = Record<string, string | StepBinding>;

/** All agent configs keyed by agent/persona name. */
export interface AgentProviderConfigs {
  classifier?: AgentStepConfig | undefined;
  context?: AgentStepConfig | undefined;
  designer?: AgentStepConfig | undefined;
  planner?: AgentStepConfig | undefined;
  implement?: AgentStepConfig | undefined;
  refactor?: AgentStepConfig | undefined;
  test?: AgentStepConfig | undefined;
  debug?: AgentStepConfig | undefined;
  document?: AgentStepConfig | undefined;
  research?: AgentStepConfig | undefined;
  brainstorm?: AgentStepConfig | undefined;
  pair?: AgentStepConfig | undefined;
  delegate?: AgentStepConfig | undefined;
  tester?: AgentStepConfig | undefined;
}

/** Local (Ollama) provider config. One core model + one embedding model. */
export interface LocalProviderConfig {
  host: string;
  coreModel: string;
  embeddingModel: string;
  embeddingDim: number;
  /** Chars-per-token ratio for budget estimation (default 3). */
  charsPerToken: number;
  /** Per-model context window params, keyed by model name. */
  params: Record<string, ModelParams>;
}

/** Cloud provider config. Multiple enabled models, one default. */
export interface CloudProviderConfig {
  /** Default model for this provider (what `@<provider>` resolves to). */
  default: string | null;
  /** Whitelisted models the agent may use. */
  enabled: string[];
  /** Per-model context window params, keyed by model name. */
  params: Record<string, ModelParams>;
}

export interface ProvidersConfig {
  local: LocalProviderConfig;
  openai: CloudProviderConfig;
  anthropic: CloudProviderConfig;
  gemini: CloudProviderConfig;
  mistral: CloudProviderConfig;
}

/** Global "use this when an image/PDF attachment is present" binding. */
export type VisionDefault = { provider: ProviderName; model: string } | null;

export interface AgentConfig {
  models: {
    /** The single active cloud provider. `local` is always available alongside. */
    activeProvider: CloudProviderName | null;
    /** Vision override for turns with image/PDF attachments. */
    visionDefault: VisionDefault;
    providers: ProvidersConfig;
    /** Per-agent step-level provider overrides. */
    agents?: AgentProviderConfigs | undefined;
  };
  keys: {
    anthropic?: string | undefined;
    openai?: string | undefined;
    gemini?: string | undefined;
    mistral?: string | undefined;
    brave?: string | undefined;
  };
  permissions: {
    mode: 'validate' | 'auto-accept';
  };
  classifier?: {
    /**
     * When true, every turn prompts the user to confirm / override the
     * classified intent before the agent pipeline runs. Low-confidence
     * classifications (< LOW_CONFIDENCE_THRESHOLD) always prompt
     * regardless of this setting.
     */
    confirmIntent?: boolean | undefined;
  } | undefined;
}

// ---------------------------------------------------------------------------
// Code Knowledge Graph — entity + relation types
// ---------------------------------------------------------------------------

export type Language = 'python' | 'go' | 'typescript' | 'javascript'
  | 'java' | 'scala'
  | 'markdown' | 'html' | 'css' | 'yaml' | 'json' | 'toml' | 'shell'
  | 'sql' | 'proto' | 'graphql' | 'dockerfile' | 'config';

export type EntityKind =
  | 'repo'
  | 'file'
  | 'module'
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'variable'
  | 'document'
  | 'section'
  | 'config';

export type RelationKind =
  | 'DEFINES'
  | 'IMPORTS'
  | 'CALLS'
  | 'INHERITS'
  | 'IMPLEMENTS'
  | 'DEPENDS_ON'
  | 'EXPORTS'
  | 'REFERENCES';

export interface Entity {
  /** Stable deterministic ID: SHA256(repo + file + kind + name), hex-32 */
  id:         string;
  kind:       EntityKind;
  name:       string;
  language:   Language;
  /**
   * u32 Repo registry id (Phase 5.x strict-contract). Allocated by
   * `addRepo()` for workspace repos; reserved top-of-u32 IDs for
   * shared-modules namespace rows (jvm / npm / python / go).
   * Storage layer uses this exclusively; the `repo` string below
   * stays for display + entity-id-hash compatibility but is
   * derivable from `repoId` via `lookupRepoPath()`.
   */
  repoId:     number;
  repo:       string;   // repo root absolute path
  file:       string;   // absolute file path
  startLine:  number;
  endLine:    number;
  /** Raw source text — used as embedding input */
  body:       string;
  /** Embedding vector from configured model; [] if not yet embedded */
  embedding:  number[];
  indexedAt:  string;   // ISO datetime

  // Optional fields populated by specific entity kinds
  isExported?:     boolean;
  isAsync?:        boolean;
  isAbstract?:     boolean;
  signature?:      string;
  hash?:           string;  // content hash for File entities
  rootPath?:       string;  // for Repo entities
  embeddingModel?: string;
  /** True for non-code artifacts (docs, configs, plans). Enables code vs artifact filtering. */
  artifact?:       boolean;
}

export interface Relation {
  kind: RelationKind;
  /** Source entity id */
  from: string;
  /** Target entity id (or raw specifier if unresolved) */
  to:   string;
  /** Whether 'to' is a resolved entity id or a raw import specifier */
  resolved: boolean;
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Repo registry
// ---------------------------------------------------------------------------

export interface RegisteredRepo {
  /**
   * Phase 5.x strict-contract discriminator. 'workspace' is the
   * default and the only kind the IDE / IPC surface care about.
   * 'shared-modules' rows are synthetic registry slots for
   * external modules (npm / jvm / python / go); they're filtered
   * out of `repo.list` and are never returned to user-facing UI.
   */
  kind?:        'workspace' | 'shared-modules';
  /**
   * Namespace for `kind === 'shared-modules'` rows; absent
   * otherwise. Possible values: 'jvm' | 'npm' | 'python' | 'go'.
   */
  namespace?:   string;
  path:         string;
  name:         string;
  addedAt:      string;
  lastIndexed?: string;
  status:       'pending' | 'indexing' | 'ready' | 'error';
  errorMsg?:    string;
}

// ---------------------------------------------------------------------------
// Indexer queue
// ---------------------------------------------------------------------------

export type IndexJob =
  | { kind: 'full';    repoPath: string }
  | { kind: 'file';    filePath: string; event: 'create' | 'update' | 'delete' }
  | { kind: 'reembed'; repoPath: string }
  | { kind: 'config-full';    scope: ConfigScope }
  | { kind: 'config-file';    filePath: string; scope: ConfigScope; event: 'create' | 'update' | 'delete' }
  | { kind: 'config-reindex'; scope: ConfigScope };

// ---------------------------------------------------------------------------
// Config management
// ---------------------------------------------------------------------------

export type ConfigScope =
  | { kind: 'global' }
  | { kind: 'project'; repoPath: string };

/**
 * Config namespaces for template / feedback / convention storage.
 *
 * Mirrors the family-level ids from `shared/agent-registry.ts` (minus
 * `'chat'` and `'system'`, which have no user-authored config assets),
 * plus the cross-family `'common'` bucket. Variants (pair / delegate
 * under `'implementation'`; brainstorm sub-categories) are internal
 * to their family and never appear here -- config assets live in the
 * family's namespace directory and may use variant-prefixed filenames
 * (e.g. `pair-analyze.md` under `implementation/`) for internal
 * disambiguation.
 */
export type ConfigNamespace =
  | 'implementation' | 'brainstorm' | 'designer' | 'planner'
  | 'tester' | 'research' | 'debugging' | 'deployment' | 'common';

export type ConfigCategory = 'template' | 'feedback' | 'convention';

export interface ConfigEntry {
  id:          string;
  scope:       ConfigScope;
  namespace:   ConfigNamespace;
  category:    ConfigCategory;
  language:    Language | 'all';
  name:        string;
  filePath:    string;
  body:        string;
  tags:        string[];
  updatedAt:   string;   // ISO datetime
  contentHash: string;
  embedding:   number[];
}

export interface ConfigSearchOpts {
  query: string;
  namespace?: ConfigNamespace | ConfigNamespace[] | undefined;
  category?: ConfigCategory | undefined;
  language?: Language | 'all' | undefined;
  scope?: ConfigScope | undefined;
  limit?: number | undefined;
  boostProject?: boolean | undefined;
}

export interface ConfigSearchResult {
  entry: ConfigEntry;
  score: number;
  boosted: boolean;
}

export interface RecordFeedbackOpts {
  content: string;
  namespace: ConfigNamespace;
  language: Language | 'all';
  repoPath: string;
  provider: LLMProvider;
  agentId?: string | undefined;
}

export interface TemplateQuery {
  namespace: ConfigNamespace;
  language: Language | 'all';
  name: string;
  repoPath?: string | undefined;
}

// ---------------------------------------------------------------------------
// IPC — JSON-RPC over Unix socket
// ---------------------------------------------------------------------------

export interface IpcRequest {
  id:     number;
  method: string;
  params: unknown;
  stream?: boolean | undefined;
}

export interface IpcResponse {
  id:     number;
  result?: unknown;
  error?:  string;
}

export type IpcStreamKind = 'delta' | 'progress' | 'gate' | 'checkpoint' | 'done' | 'error' | 'qna.update' | 'liveStep' | 'todos';

export interface IpcStreamMessage {
  id:     number;
  stream: IpcStreamKind;
  data:   unknown;
}

export interface DaemonStatus {
  uptime:            number;  // seconds
  repos:             RegisteredRepo[];
  queueDepth:        number;
  embeddingsPending: number;
  modelPullStatus?:  'pulling' | 'ready';
  modelPullPct?:     number;
  /** Current LMDB env file size in MiB (`~/.insrc/graph.lmdb`).
   *  Compare to actual data volume to spot when `insrc daemon compact`
   *  would reclaim space (LMDB never returns freed pages to the OS;
   *  large delete bursts inflate the file until compact-and-replace). */
  lmdbFileSizeMb?:   number;
}

// ---------------------------------------------------------------------------
// Plan graph — persistent across sessions
// ---------------------------------------------------------------------------

/** @deprecated Use StepStatus from '../agent/planner/types.js' for new code. */
export type PlanStepStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';
export type PlanStepComplexity = 'low' | 'medium' | 'high';
/** @deprecated Use PlanStatus from '../agent/planner/types.js' for new code. */
export type PlanStatus = 'active' | 'completed' | 'abandoned';

export interface PlanStep {
  id:          string;
  planId:      string;
  idx:         number;
  title:       string;
  description: string;
  checkpoint:  boolean;
  status:      PlanStepStatus;
  complexity:  PlanStepComplexity;
  fileHint:    string;
  notes:       string;
  dependsOn:   string[];   // step IDs this step depends on
  createdAt:   string;
  updatedAt:   string;
  startedAt?:  string | undefined;
  doneAt?:     string | undefined;
}

export interface Plan {
  id:        string;
  repoPath:  string;
  title:     string;
  status:    PlanStatus;
  steps:     PlanStep[];
  createdAt: string;
  updatedAt: string;
}
