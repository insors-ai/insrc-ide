# Multi-provider model configuration

## Context

Today the agent supports exactly two providers: **Ollama** (local,
catch-all) and **Claude** (cloud). Routing is expressed as
`StepBinding { provider: 'local' | 'claude', tier?: 'fast' | 'standard'
| 'powerful', model? }`, where tiers are a Claude-centric shorthand
(haiku / sonnet / opus) wired into `agent/router.ts` and referenced
from every agent's per-step config. Settings for models and their
context windows live in VS Code `settings.json`
(`insrc.models.*`), and there is a single hard-coded Anthropic key
resolved from keychain / `~/.insrc/config.json` / env var.

Users want to **bring their own keys for OpenAI, Anthropic, Gemini,
and Mistral**, pick specific models per provider, and wire those
selected models into per-step routing. Models change frequently, so
the list must be fetched live from the provider, not hard-coded.

## Design answers (locked)

1. **Tiers are removed.** `StepBinding` becomes
   `{ provider, model }` -- no `tier`. Router stops doing
   intent->tier mapping; it picks provider/model straight from the
   per-step config (with `@mention` overrides preserved).
2. **Custom EditorPane** for model configuration. VS Code settings
   UI cannot render "dropdown -> live-fetched multi-select ->
   accordion per row", and we do not want to fight its schema. All
   `insrc.models.*` settings are removed from
   `insrcConfiguration.ts`; the new pane is the single place to
   manage providers and models.
3. **Daemon is the source of truth** for fetch and persist. IDE
   calls `providers.listModels` / `providers.getConfig` /
   `providers.setConfig` over the existing JSON-RPC; IDE never
   touches provider APIs directly, never reads keys.
4. **Embeddings stay local-only.** Only the local (Ollama) provider
   exposes an embedding model selection. Cloud providers have no
   embedding slot in the pane.
5. **Provider mentions simplified.** `@haiku` / `@sonnet` /
   `@opus` / `@claude` are removed. `@local` stays. New:
   `@openai` / `@anthropic` / `@gemini` / `@mistral` -- each
   resolves to that provider's configured `default` model.
   `@sticky @<provider>` / `@clear` are unchanged.
6. **Local is a single core model + single embedding model**,
   picked from the installed list via `/api/tags`. No per-step
   model selection inside local.
7. **Per-model parameters are limited to context-window settings**
   (`maxInputTokens`, `maxOutputTokens`). Temperature / topP /
   topK / stopSequences are deliberately out: newer models
   (gpt-5+, reasoning models) reject these, and per-step parameter
   tuning is a footgun that is not worth the UI surface.

## Config shape

Stored in `~/.insrc/config.json` under `models`, written via
`providers.setConfig` and loaded by the existing `loadConfig()`
path.

```jsonc
{
  "models": {
    "activeProvider": "anthropic",
    "visionDefault":  { "provider": "anthropic", "model": "claude-sonnet-4-6" },
    "providers": {
      "openai": {
        "default": "gpt-4o",
        "enabled": ["gpt-4o", "gpt-4o-mini", "o3-mini"],
        "params": {
          "gpt-4o":      { "maxInputTokens": 128000, "maxOutputTokens": 16384 },
          "gpt-4o-mini": { "maxInputTokens": 128000, "maxOutputTokens": 16384 }
        }
      },
      "anthropic": {
        "default": "claude-sonnet-4-6",
        "enabled": ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-7"],
        "params": {
          "claude-sonnet-4-6": { "maxInputTokens": 200000, "maxOutputTokens": 8192 }
        }
      },
      "gemini":  { "default": "...", "enabled": [...], "params": {...} },
      "mistral": { "default": "...", "enabled": [...], "params": {...} },
      "local": {
        "host": "http://localhost:11434",
        "coreModel": "qwen3-coder:latest",
        "embeddingModel": "qwen3-embedding:0.6b",
        "params": {
          "qwen3-coder:latest": { "maxInputTokens": 16384, "maxOutputTokens": 8192 }
        }
      }
    },
    "agents": {
      "pair":      { "propose":  { "provider": "anthropic", "model": "claude-sonnet-4-6" },
                     "validate": { "provider": "anthropic", "model": "claude-sonnet-4-6" } },
      "planner":   { "draft":    { "provider": "anthropic", "model": "claude-sonnet-4-6" } },
      "designer":  { ... },
      "brainstorm": { ... }
    }
  }
}
```

Only models belonging to `activeProvider` or `local` may
appear in `agents.*.*` bindings or in `visionDefault`. Entries
referencing any other provider are nulled at save time (see
"Switching active provider" above).

Provider API keys continue to live in the OS keychain under service
`insrc`, account names `openai` / `anthropic` / `gemini` /
`mistral`. The existing `IInsrcKeychainService` already exposes
`setKey` / `getKey` / `deleteKey`, and the daemon reads from it in
`loadConfigWithKeys()`. No new secret storage.

## RPCs added to the daemon

All in `src/insrc/daemon/server.ts` (or a new `providers.ts`
handler module).

- `providers.listModels({ provider: 'openai' | 'anthropic' | 'gemini' | 'mistral' | 'local' })`
  -> `{ models: Array<{ id, maxInputTokens?, maxOutputTokens?, description? }> }`.
  Daemon uses the stored key + per-provider SDK/HTTP call:
  - OpenAI: `GET /v1/models`
  - Anthropic: `GET /v1/models`
  - Gemini: `GET /v1beta/models?key=...`
  - Mistral: `GET /v1/models`
  - Local: `GET {ollama.host}/api/tags` (for both core and embedding lists)
  Errors (missing key, network, auth) propagate as structured
  RPC errors so the pane can show them inline.

- `providers.getConfig()` -> `{ providers, agents }` (the
  `models` slice, minus secrets).

- `providers.setConfig(patch)` -> `{ ok: true }`. Validates the
  patch, merges into `~/.insrc/config.json`, calls
  `reloadConfig()` so in-flight provider instances pick up the
  change without a daemon restart. (Open sessions keep their
  current instance; next LLM call constructs a new one.)

- `providers.testKey({ provider })` -> `{ ok, error? }`. Quick
  list-models round-trip used by the pane after the user pastes
  a key, to fail fast before saving.

## Provider layer

`src/insrc/shared/types.ts`

- Drop `StepBinding.tier`.
- Change `StepBinding.provider` from `'local' | 'claude'` to
  `'local' | 'openai' | 'anthropic' | 'gemini' | 'mistral'`.
- Add `StepBinding.model: string` (now required).

`src/insrc/agent/providers/`

- `claude.ts` -> rename to `anthropic.ts`. API is unchanged;
  constructor takes `{ model, apiKey, maxInputTokens,
  maxOutputTokens }` (context window values come from the
  provider config, not hard-coded).
- New: `openai.ts` -- uses the `openai` npm SDK, implements
  `complete` / `stream` / `embed` (embed throws / returns empty
  since cloud embeddings are out of scope) / `supportsTools: true`.
- New: `gemini.ts` -- uses `@google/generative-ai`, same
  interface.
- New: `mistral.ts` -- uses `@mistralai/mistralai`, same
  interface.
- `ollama.ts` -- accept an explicit embedding-model parameter
  (today it is baked in via `loadConfig()` at module init).

`src/insrc/agent/providers/factory.ts` (new)

- `buildProvider(binding: StepBinding, cfg: Config): LLMProvider`
  reads the per-model context window from
  `cfg.models.providers[provider].params[model]`, fetches the
  key from keychain/env, and instantiates the right class. This
  is the single construction point; controllers / agents call
  it per step instead of each knowing about specific provider
  classes.

## Routing changes

### Single active cloud provider

Only **one** cloud provider is active at any point in time,
tracked in a new config field:

```jsonc
"models": {
  "activeProvider": "anthropic"   // "openai" | "anthropic" | "gemini" | "mistral"
}
```

Local is always available alongside the active cloud provider
(it is not an alternative to it). Keys for non-active cloud
providers may still exist in keychain (so switching is fast),
but their models do not participate in routing or `@mentions`.

**Switching active provider** (via the pane):

When the user changes `activeProvider`, the daemon wipes all
model-level selections that were bound to the previous state:

- `cfg.models.visionDefault` -> `null`.
- `cfg.models.agents` -> `{}` (every step binding cleared,
  including ones pointing at `local`). The resolver then falls
  through to `providers[activeProvider].default` for every
  step, and the user re-pins the ones they care about in the
  pane.
- Per-provider `enabled` / `default` / `params` blocks are
  **preserved** for every provider (these are the user's
  per-provider configs -- keeping them means switching back
  later does not force a re-setup).
- `@mention` tokens are constrained (see "Provider mentions"
  below).

Saves are transactional: the daemon pre-writes the full new
`models` slice, reloads in place, and only then acknowledges
success to the IDE. A crash mid-switch does not leave a
dangling `visionDefault` or agent binding pointing at a model
the active provider does not offer.

### Resolution order

Resolution order for every LLM call:

1. **Vision override.** If the current turn has an
   `image`/`pdf` attachment, route through
   `cfg.models.visionDefault`. If unset, return the
   "no-vision-default" error (see section D). Steps 2-5
   below do not run.
2. **Mention override.** If `ctx.state.providerOverride` is
   set (from an `@mention` gate), use it.
3. **Step binding.** Look up
   `cfg.models.agents[agent][step]` -> `{ provider, model }`.
4. **Agent catch-all.**
   `cfg.models.agents[agent]['*']` (if set).
5. **Active provider default.**
   `cfg.models.providers[activeProvider].default`.
6. If `activeProvider` is unset or its `default` /
   `enabled` are empty, the daemon returns `NOT_CONFIGURED`.

No automatic complexity assessment, no step-name heuristics, no
auto-escalation, no tier guesswork, no provider preference
list (unnecessary: there is only one active cloud provider).
Resolution is pure config lookup.

`src/insrc/agent/router.ts`

- Delete `type Tier`, `INTENT_TIER`, `intentToTier`,
  `claudeForIntent`, `claudeForExplicitIntent`,
  `claudeOpusEscalation`, `tierLabel`.
- `selectProvider(intent, explicit, deps)` collapses to the
  5-step lookup above; intent no longer influences routing.

`src/insrc/agent/smart-router.ts`

- **Delete entire file.** Both `SmartRouter` (per-request
  complexity assessor) and `SmartProviderResolver` (per-step
  name heuristics) are removed. Callers fall through to the
  plain config-lookup resolver.
- The `insrc.routing.mode` setting (`static` vs `auto`) is
  removed from `insrcConfiguration.ts` along with the smart
  router; there is only one mode now.

`src/insrc/agent/escalation.ts`

- **Delete entire file.** Today triggers auto-escalation to
  Claude on scope signals (batch size, complexity keywords).
  Replaced by explicit per-step config + `@mention` overrides.

`src/insrc/agent/framework/provider-mention.ts`

- Drop `@haiku`, `@sonnet`, `@opus`, `@claude` tokens.
- Keep `@local`.
- Add `@<activeProvider>` (e.g. `@anthropic` when
  `activeProvider === 'anthropic'`). Resolves to
  `{ provider, model: cfg.providers[activeProvider].default }`.
- `@<other-cloud-provider>` (a provider name that is not the
  active one) returns a gate error: *"Provider 'openai' is
  not the active provider. Switch in Model Providers before
  using this mention."*
- `@sticky @<provider>` / `@clear` unchanged in shape;
  `@sticky` applied to a non-active provider errors the same
  way.
- Update help text strings wherever mentions are documented.

## EditorPane: Model Providers

New pane under `src/vs/workbench/contrib/insrc/browser/models/`:

- `modelProvidersPane.ts` -- the EditorPane shell, registered in
  `insrc.contribution.ts` alongside SetupWizard /
  StepProviderEditor / Brainstorm.
- `modelProvidersInput.ts` -- `EditorInput` carrier.
- `modelProvidersWebview.ts` -- the actual UI (webview or
  direct DOM). Given the existing setup panes are webview-based,
  match that style.
- Command: `insrc.openModelProviders` (palette title "insrc:
  Configure Model Providers"), and a toolbar action inside the
  pane.

Layout:

```
+-------------------------------------------------------------+
|  Model Providers                                           |
|  ┌──────────────────────┐                                  |
|  │ Provider: [OpenAI ▾] │   [Set API Key...]  [Test key]   |
|  └──────────────────────┘                                  |
|                                                             |
|  Available models (live list)         Selected              |
|  ☑ gpt-4o                             gpt-4o      [default] |
|  ☑ gpt-4o-mini                        gpt-4o-mini           |
|  ☐ o1                                 ───────────────────── |
|  ☐ o3-mini                            ▾ gpt-4o              |
|                                         maxInputTokens  [..]|
|                                         maxOutputTokens [..]|
|                                       ▾ gpt-4o-mini         |
|                                         ...                  |
|                                                             |
|  [Refresh model list]                   [Save]  [Cancel]    |
+-------------------------------------------------------------+
```

Interactions:

- Provider dropdown: OpenAI / Anthropic / Gemini / Mistral /
  Local. Local gets a different right-pane layout:
  two single-select dropdowns (core model, embedding model)
  populated from the same `/api/tags` response, plus the
  Ollama host string.
- "Set API Key..." opens the existing QuickInput flow (same as
  `insrc.tools.setBraveApiKey`) but writes to the provider's
  keychain account.
- On pane open (or provider switch), call
  `providers.listModels`. If the call fails, show the error and
  a "Set API Key..." shortcut.
- Saving writes via `providers.setConfig`; the daemon hot-reloads.
- **Cost-guard warning banner** is rendered at the top of every
  cloud provider sub-page (OpenAI / Anthropic / Gemini /
  Mistral), not on Local. Text:

  > **Set spend limits in your provider console.** insrc does not
  > track token usage or enforce spend caps. Configure usage
  > limits and alerts directly with your provider (billing /
  > usage / quota settings in their web console) to avoid
  > unexpected charges.

  The banner is dismissible per-provider (stored in VS Code
  `globalState`) so returning users aren't nagged, but reappears
  if the user revokes and resets a key (since that often signals
  a new account). The exact console URL per provider is resolved
  at implementation time from each provider's official
  documentation -- not hard-coded in the plan.

## Migration

First run after this ships, the daemon migrates old
`config.json`:

- `models.local` string -> `models.providers.local.coreModel`
- `models.embedding` string -> `models.providers.local.embeddingModel`
- `models.tiers.{fast,standard,powerful}` -> dropped; if any were
  set, seed `providers.anthropic.default` from `tiers.standard`,
  add that model to `providers.anthropic.enabled`.
- `models.context.*` -> dropped; seed
  `providers.local.params[coreModel].maxInputTokens`,
  `providers.anthropic.params[default].maxInputTokens`.
- `keys.anthropic` -> already migrated to keychain by the existing
  flow in `loadConfigWithKeys()`; no change.

Corresponding VS Code settings (`insrc.models.*`,
`insrc.ollama.host`) are removed from `insrcConfiguration.ts`.
Daemon's `Ollama host` now lives in
`models.providers.local.host` with a single-line input in the
Local pane.

## Call sites to migrate

Audit found every spot that touches the provider surface today.
Grouped by concern.

### A. Direct provider instantiation (routed through factory)

Every `new OllamaProvider(...)` / `new ClaudeProvider(...)` is
replaced with `buildProvider(binding, cfg)`.

- `src/insrc/agent/session.ts:79-83, 86-88, 165-174`
  (constructor + `updateConfig`)
- `src/insrc/agent/config.ts:235-237` (`resolveLLMProvider`)
- `src/insrc/agent/router.ts:105, 126-128, 141-143, 161-163`
  (all four tier branches — see section B)
- `src/insrc/agent/smart-router.ts` — deleted wholesale
  (no factory rewire needed; callers fall through to the
  plain config resolver)
- `src/insrc/agent/framework/provider-mention.ts:113`
- `src/insrc/agent/index.ts:433` (auto-escalation)
- `src/insrc/agent/cli.ts:258`
- `src/insrc/cli/commands/test.ts:68-69, 153-154`
- `src/insrc/agent/framework/__tests__/runner.test.ts:28-31`
  (test mock — update shape)

### B. Tier / INTENT_TIER removal

- `src/insrc/shared/types.ts:135` — remove `StepBinding.tier`.
- `src/insrc/shared/types.ts:165-170` — remove
  `config.models.tiers` from schema.
- `src/insrc/agent/router.ts:35, 37-50, 104, 127, 139-140,
  159-160, 172-182` — delete `type Tier`, `INTENT_TIER`,
  `claudeForIntent`, `claudeForExplicitIntent`,
  `claudeOpusEscalation`, `tierLabel`.
- `src/insrc/agent/smart-router.ts` — entire file deleted
  (see Routing changes).
- `src/insrc/agent/config.ts:173-175, 213, 249, 255-257,
  269, 274` — `ProviderResolver` loses tier fallback;
  `resolveBinding` just reads `{provider, model}`.
- `src/insrc/agent/framework/provider-mention.ts:111-112` —
  override resolution drops the tier->model lookup.
- `src/insrc/agent/session.ts:87, 111, 118, 126` — stop
  reading `config.models.tiers.standard` /
  `config.models.context.claude`; read from
  `cfg.models.providers[p].params[model]`.

### C. Escalation deletion

`src/insrc/agent/escalation.ts` is deleted. Callers:

- `src/insrc/agent/index.ts:425-437` — auto-escalate on local
  failure. Replaced with: propagate the error. The user can
  retry with an explicit `@anthropic` (or any) provider mention.
  No automatic fallback.
- `src/insrc/agent/cli.ts:250-270` — same auto-escalation in
  CLI; same treatment.
- `src/insrc/daemon/controllers/tester.ts:18, 298-299` —
  comment/log references; clean up.

### D. Attachment-forced routing (vision)

- `src/insrc/agent/attachments/router.ts` and
  `src/insrc/agent/attachments/forced-claude.ts` —
  today, an image or PDF in the prompt forces a hop to Claude
  (the only vision-capable provider wired in). With four
  cloud providers and varied model support, this becomes an
  explicit single-binding setting.

  New config field (global, not per-provider):

  ```jsonc
  "models": {
    "visionDefault": { "provider": "anthropic", "model": "claude-sonnet-4-6" }
  }
  ```

  Behavior: when any attachment with `kind === 'image'` or
  `kind === 'pdf'` is present in the turn:

  1. If `models.visionDefault` is set, route the entire turn
     through that `(provider, model)` -- independent of the
     step's normally-resolved binding and independent of any
     `@mention` override for this turn.
  2. If `models.visionDefault` is not set, the daemon returns
     a clear error: *"This turn includes an image or PDF,
     but no Vision Default is configured. Set one in Model
     Providers, or remove the attachment."* The turn does not
     execute.

  No silent fallback, no per-provider vision default, no
  preference list. One setting, one binding, explicit error
  when missing. Matches the "explicit or default" rule used
  elsewhere.

  Rename `forced-claude.ts` -> `forced-vision.ts`. Its single
  job becomes "look up `models.visionDefault`, return the
  binding or the error".

### E. Agent-internal LLM call sites (pass through factory)

These modules already receive an `LLMProvider` instance today;
they don't need logic changes, but whoever constructs them
(session, runner, controllers) must source the instance from
`buildProvider(binding, cfg)` instead of `new XProvider(...)`:

- `src/insrc/agent/tools/loop.ts:73-170` (`runToolLoop`)
- `src/insrc/agent/tools/validator.ts` (`validateToolCall`)
- `src/insrc/agent/classifier/llm-classify.ts`
- `src/insrc/agent/classifier/decompose.ts`
  (called from `src/insrc/agent/framework/runner.ts`)
- `src/insrc/agent/context/summary.ts`
- `src/insrc/agent/context/semantic.ts`
- `src/insrc/agent/tasks/brainstorm/context-builder.ts:74-79`
  — reads `config.models.context.*`; switch to
  `cfg.models.providers[p].params[m].maxInputTokens`.

Internal agents (classifier, decomposer, summary, validator)
are **not** user-configurable. They always route through
`providers[activeProvider].default`. No `agents.internal.*`
config bucket, no pane entry. These call sites just need to
stop constructing their own providers and start calling
`buildProvider({ provider: activeProvider, model:
providers[activeProvider].default }, cfg)`.

### F. Embedding wiring

- `src/insrc/indexer/embedder.ts:7-8` — today exports
  `EMBEDDING_MODEL` / `EMBEDDING_DIM` as module-level
  constants. Replace with a function that reads
  `cfg.models.providers.local.embeddingModel` +
  `providers.local.params[model].embeddingDim`.
- `src/insrc/agent/lifecycle.ts:17` — reads
  `config.models.local`; now reads
  `cfg.models.providers.local.coreModel`.

### G. Prefix parser (second place that reads `@`-mentions)

- `src/insrc/agent/classifier/prefix.ts` — parses `@claude` /
  `@opus` prefixes on user input (separate code path from
  `framework/provider-mention.ts`, which handles gates).
  Update the same way: drop `@claude`/`@opus`/`@haiku`/
  `@sonnet`; accept `@local` + `@<provider>`.

### H. Docs

- `CLAUDE.md` — "Provider `@mention` overrides" line.
- `README.md` — wherever `@haiku`/`@sonnet`/`@opus` is
  enumerated.
- `design/agent-framework.html` — check and update.

### I. IDE-side

- `src/vs/workbench/contrib/insrc/common/insrcConfiguration.ts`
  — remove `insrc.models.*`, `insrc.ollama.host`.
- `src/vs/workbench/contrib/insrc/browser/setup/setupWizardPane.ts`
  — first-run setup. Today probably writes model defaults; new
  behavior: on first run, the wizard links out to the Model
  Providers pane (same "not configured" banner mechanism).
- `src/vs/workbench/contrib/insrc/browser/setup/stepProviderEditorPane.ts`
  — existing step-provider editor. This pane lets users bind
  agents-step to providers. Today it offers `local | claude`
  + tier; update the dropdown options to enumerate
  `local | openai | anthropic | gemini | mistral`, with a
  second dropdown showing that provider's `enabled` list.
  Tier dropdown is removed.

## Files touched (condensed)

New:

- `src/insrc/agent/providers/openai.ts`
- `src/insrc/agent/providers/gemini.ts`
- `src/insrc/agent/providers/mistral.ts`
- `src/insrc/agent/providers/factory.ts`
- `src/insrc/agent/attachments/forced-vision.ts`
  (replaces `forced-claude.ts`)
- `src/insrc/daemon/providers.ts` (RPC handlers)
- `src/vs/workbench/contrib/insrc/browser/models/modelProvidersPane.ts`
- `src/vs/workbench/contrib/insrc/browser/models/modelProvidersInput.ts`
- `src/vs/workbench/contrib/insrc/browser/models/modelProvidersCommands.ts`

Renamed:

- `src/insrc/agent/providers/claude.ts` -> `anthropic.ts`
- `src/insrc/agent/attachments/forced-claude.ts`
  -> `forced-vision.ts`

Modified (call-site edits listed in A-I above):

- `src/insrc/shared/types.ts`
- `src/insrc/agent/config.ts`
- `src/insrc/agent/session.ts`
- `src/insrc/agent/router.ts`
- `src/insrc/agent/smart-router.ts`
- `src/insrc/agent/index.ts`
- `src/insrc/agent/cli.ts`
- `src/insrc/agent/lifecycle.ts`
- `src/insrc/agent/providers/ollama.ts`
- `src/insrc/agent/framework/provider-mention.ts`
- `src/insrc/agent/framework/runner.ts`
- `src/insrc/agent/classifier/prefix.ts`
- `src/insrc/agent/classifier/llm-classify.ts`
- `src/insrc/agent/classifier/decompose.ts`
- `src/insrc/agent/context/summary.ts`
- `src/insrc/agent/context/semantic.ts`
- `src/insrc/agent/tools/loop.ts`
- `src/insrc/agent/tools/validator.ts`
- `src/insrc/agent/tasks/brainstorm/context-builder.ts`
- `src/insrc/agent/attachments/router.ts`
- `src/insrc/daemon/server.ts`
- `src/insrc/daemon/controllers/tester.ts`
- `src/insrc/indexer/embedder.ts`
- `src/insrc/cli/commands/test.ts`
- `src/insrc/agent/framework/__tests__/runner.test.ts`
- `src/vs/workbench/contrib/insrc/common/insrcConfiguration.ts`
- `src/vs/workbench/contrib/insrc/browser/insrc.contribution.ts`
- `src/vs/workbench/contrib/insrc/browser/setup/setupWizardPane.ts`
- `src/vs/workbench/contrib/insrc/browser/setup/stepProviderEditorPane.ts`
- `CLAUDE.md`, `README.md`, `design/agent-framework.html`

Deleted:

- `src/insrc/agent/escalation.ts`
- `src/insrc/agent/smart-router.ts`
- (inside `src/insrc/agent/router.ts`)
  `type Tier`, `INTENT_TIER`, `claudeForIntent`,
  `claudeForExplicitIntent`, `claudeOpusEscalation`,
  `tierLabel`
- `insrc.routing.mode` setting from
  `insrcConfiguration.ts` (only one routing mode now)

## Additional design points surfaced by the audit

1. **Vision default (global, single)** — see section D.
   One setting `models.visionDefault: { provider, model }`,
   surfaced in the pane as a top-level "Vision Default" row.
   The picker shows enabled vision-capable models from the
   active provider only (since only the active provider's
   models participate in routing). If unset, attachments
   raise an error.


## Implementation order

1. **Config + migration** (agent/config.ts, types.ts). Old
   `models.*` reshaped into `models.providers.*`; everything still
   works with `anthropic` + `local` only.
2. **Provider factory** and Anthropic/Ollama moved onto it, with
   tiers stripped from the routing path.
3. **OpenAI provider** (most common ask; good test of the
   factory).
4. **Daemon RPCs** (`providers.listModels` / `getConfig` /
   `setConfig` / `testKey`) -- Anthropic + OpenAI first so the
   pane has something to render.
5. **EditorPane** for model providers, wired to the RPCs.
6. **Gemini + Mistral providers** -- drop-ins once the factory
   and pane exist.
7. **Provider-mention grammar update** + escalation deletion.
   Defer until all providers are in so the mention help text is
   accurate.
8. **Remove `insrc.models.*` + `insrc.ollama.host`** from VS Code
   settings.

## Not-configured behavior

No `globalDefault` field. Agents that don't have an explicit
per-step binding look up `providers[<configured-provider>].default`;
if that provider isn't configured either, the daemon treats the
whole config as unusable.

**Minimum valid config**:

- Local: `providers.local.coreModel` AND
  `providers.local.embeddingModel` both set; OR
- At least one cloud provider with a key in keychain AND
  `providers.<p>.default` AND at least one entry in
  `providers.<p>.enabled`.

(Embedding is required regardless -- without it the knowledge
graph cannot index. So in practice `providers.local.embeddingModel`
must always be set; what is optional is whether the core model is
also local or a cloud provider.)

Daemon behavior when config is invalid:

- All agent / chat / index / classify RPCs return a structured
  error `{ code: 'NOT_CONFIGURED', missing: 'local' | 'provider' | 'both' }`.
- Config-related RPCs (`providers.listModels`, `providers.getConfig`,
  `providers.setConfig`, `providers.testKey`) keep working so the
  pane can still render.

IDE behavior on receiving `NOT_CONFIGURED`:

- Auto-open the Model Providers pane.
- Jump to the relevant sub-page based on `missing`:
  - `'local'` -> Local page.
  - `'provider'` -> the first cloud provider page (OpenAI by
    default, since every cloud user has to pick something).
  - `'both'` -> Local page (local is required anyway for
    embeddings).
- Render an inline banner at the top of the pane:
  "Set a [local model | API key] to continue."

## Out of scope

- **Rate-limit / cost-guard**. Every cloud provider already
  offers per-key spend caps and usage dashboards in their own
  console (OpenAI usage limits, Anthropic billing thresholds,
  Gemini quotas, Mistral workspace limits). Mirroring that in
  the IDE would duplicate an existing, authoritative control.
  The pane does not surface usage metrics or spend caps; users
  configure those with the provider.

## Provider SDK choice

Each cloud provider is implemented against its official SDK, not
raw `fetch`. Rationale: streaming (SSE parsing, partial tool-call
assembly), retry / back-off, auth, and the provider-specific
tool-calling schema are non-trivial to hand-roll correctly across
four providers, and the existing codebase is SDK-first
(Ollama uses `ollama`; Anthropic uses `@anthropic-ai/sdk`).
Bundle size is acceptable given the daemon is not size-constrained.

Dependencies added to daemon `package.json`:

- `openai` (OpenAI SDK)
- `@google/generative-ai` (Gemini SDK)
- `@mistralai/mistralai` (Mistral SDK)

`@anthropic-ai/sdk` and `ollama` are already present.

## Verification

1. Fresh config, open Model Providers pane. OpenAI is selected;
   paste key -> "Test key" succeeds -> model list renders.
2. Enable two models, set one as default, save. `config.json`
   reflects the change.
3. Swap the `pair.propose` step binding to OpenAI / gpt-4o via
   the existing step-provider editor. Run a pair session -> logs
   show `openai.complete()` being called.
4. `@mistral` in a gate resolves to that provider's configured
   default.
5. Remove the Anthropic key; daemon RPC returns a clean error;
   pane renders it inline without crashing.
6. Uninstall all cloud keys; only `@local` works and the agent
   still runs through Ollama as it did pre-multi-provider.
