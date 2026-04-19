# Tools settings -- IDE configuration surface

## Context

With ~180 unified tools shipped across file / shell / git / gh / ssh
/ http / k8s / cloud / diff / notify / test / pkg / web / graph /
plan domains, the daemon needs a small, focused slice of its
behavior exposed as VS Code settings. The bulk of what a tool needs
at runtime -- git identity, kubeconfig, cloud credentials, docker
socket, SSH keys, PATH, editor preferences -- already lives in the
user's environment and should stay there. We only introduce IDE
settings for things that (a) the environment can't supply or
(b) the user genuinely wants to vary per-workspace.

## Existing settings (for reference)

Already registered in
`src/vs/workbench/contrib/insrc/common/insrcConfiguration.ts`:

- `insrc.ollama.host`, `insrc.logLevel`
- `insrc.models.local`, `insrc.models.embedding`,
  `insrc.models.embeddingDim`
- `insrc.models.tiers.{fast,standard,powerful}` (Claude tier names)
- `insrc.models.context.{local,localMaxOutput,claude,claudeMaxOutput}`
- `insrc.permissions.mode` (`validate` vs `auto-accept`)
- `insrc.daemon.{autoUpdate,repoUrl,repoBranch}`
- `insrc.routing.mode` (`static` vs `auto`)

## Design principles

1. **Environment first.** If there is a well-known env var, config
   file, or CLI that already governs a behavior, we do not duplicate
   it. Tools shell out to `git` / `gcloud` / `aws` / `az` / `kubectl`
   / `docker` / `ssh` / `gh` / `npm` and let those read their own
   configs.
2. **Scope = MACHINE.** All tools settings live in user-level or
   workspace-level settings.json, never synced to a profile, so
   secrets and per-machine paths don't travel.
3. **Be stingy.** A setting is a UI commitment; each one adds
   documentation burden, migration risk, and "why isn't it working"
   support load. We add a setting only if (a) it unblocks a concrete
   use case and (b) that use case can't be handled by environment or
   per-call arguments.
4. **Never put secrets in settings.json.** API keys and auth tokens
   go through the keychain service
   (`src/vs/workbench/contrib/insrc/common/keychainService.ts`) and
   surface in the UI via commands, not a `"insrc.x.apiKey"` string.
   Settings carry *references* (e.g., `insrc.tools.web.braveApiKeyRef`)
   or just behavioral toggles; the secret itself is in the OS
   keychain.

## Explicit non-goals (stays in environment)

| Concern | Source of truth | Why we do NOT add a setting |
|---------|-----------------|-----------------------------|
| Git author, remote auth | `git config` + credential helper | `git` already reads them |
| GitHub CLI auth | `gh auth login` | `gh` manages its own token store |
| AWS profile / region | `~/.aws/`, `AWS_PROFILE`, `AWS_REGION` | Tool accepts per-call overrides for profile/region |
| GCP project / account | `gcloud config`, `GOOGLE_APPLICATION_CREDENTIALS` | Same pattern -- tool accepts per-call |
| Azure subscription / resourceGroup | `az account`, env | Per-call overrides |
| Kubernetes context / kubeconfig | `~/.kube/config`, `KUBECONFIG` | `kubectl` reads them |
| Docker socket | `DOCKER_HOST` / `/var/run/docker.sock` | Docker CLI reads them |
| SSH keys / hosts | `~/.ssh/config`, agent | `ssh` reads them |
| PATH / Node / npm | Shell environment | No IDE setting; installer resolves nvm path at spawn time (already shipped) |
| HTTP proxies | `HTTPS_PROXY`, `NO_PROXY` | undici honors them |

Users who need per-workspace overrides for any of the above can use
workspace-scoped env (e.g., `.envrc`, direnv) -- we do not need to
reinvent that.

## New settings to add

### 1. Tool categories gate (opt-out)

For regulated / restricted environments some categories should be
switched off wholesale. Default: all enabled.

```jsonc
"insrc.tools.enabledCategories": {
  "type": "array",
  "items": { "type": "string" },
  "default": [
    "file", "shell", "search", "git", "gh",
    "ssh", "http", "k8s", "cloud", "diff",
    "notify", "test", "pkg", "web", "graph", "plan"
  ],
  "description": "Whitelist of tool categories the agent can invoke. Tools outside this list are unregistered at daemon startup. Use to restrict the agent in compliance-sensitive projects."
}
```

The daemon's `registerBuiltinTools()` reads this on startup and
skips the categories not in the list. Existing call sites still see
a registry miss (they already handle `Unknown tool:` gracefully).

### 2. Approval gate behavior

Governs the three-action gate surface for tool calls that require
approval.

```jsonc
"insrc.tools.approval.defaultAction": {
  "type": "string",
  "enum": ["approve", "skip"],
  "default": "skip",
  "description": "Action used when an approval gate is dismissed without an explicit response (e.g., IDE close). `skip` is the safe default."
},
"insrc.tools.approval.maxEditRounds": {
  "type": "number",
  "default": 5, "minimum": 1, "maximum": 20,
  "description": "How many times the user can edit a tool's input before the executor gives up. Currently hardcoded; hoist to config."
},
"insrc.tools.approval.showStructuredDiff": {
  "type": "boolean",
  "default": true,
  "description": "Show a rendered diff / command preview in the gate. Turn off for pure text previews (less visual noise in high-volume agent loops)."
}
```

### 3. Tool-loop caps

The LLM tool-call loop (`agent/tools/loop.ts`) has two hardcoded
ceilings: `MAX_ITERATIONS = 25` and `MAX_NUDGES = 3`. Hoist them so
users working with tight budgets (or wanting to allow deeper chains)
can tune.

```jsonc
"insrc.tools.loop.maxIterations": {
  "type": "number",
  "default": 25, "minimum": 1, "maximum": 200,
  "description": "Maximum tool-call iterations per agent turn before the loop gives up. Raise for long investigations; lower to fail faster."
},
"insrc.tools.loop.maxNudges": {
  "type": "number",
  "default": 3, "minimum": 0, "maximum": 10,
  "description": "How many times the loop re-prompts the LLM if it described a tool action without calling one."
}
```

### 4. Tool output capture

Large tool outputs (grep hitting a whole repo, `kubectl logs -f`)
today spill to temp files at a hardcoded threshold. Expose the
threshold plus whether we keep or delete the spills.

```jsonc
"insrc.tools.output.inlineMaxChars": {
  "type": "number",
  "default": 12000, "minimum": 1024, "maximum": 1000000,
  "description": "Tool outputs under this many characters are returned inline to the LLM. Larger ones spill to a temp file and get SmartRead-chunked."
},
"insrc.tools.output.retainSpills": {
  "type": "boolean",
  "default": false,
  "description": "Keep spill files (in /tmp/.insrc/tool-output) after the session closes. Useful when debugging tool output handling."
}
```

### 5. Shell / SSH runtime caps

Tools that run arbitrary commands have default timeouts and
streaming caps. Users on very slow links or very long-running builds
may need to raise them.

```jsonc
"insrc.tools.shell.defaultTimeoutMs": {
  "type": "number", "default": 120000, "minimum": 1000,
  "description": "Default timeout for shell:exec (one-shot). Per-call `timeoutMs` still wins when set."
},
"insrc.tools.shell.detachedMaxRuntimeMs": {
  "type": "number", "default": 1800000, "minimum": 1000,
  "description": "Hard cap for streaming (shell:exec-detached, ssh:exec-detached, k8s:logs follow mode, k8s:port-forward). SIGTERM fires at this deadline."
}
```

### 6. Web search secret reference

`web:search` needs `BRAVE_API_KEY`. Today it reads the env var; add
a keychain-backed path so users can store the key once via the IDE
UI and forget it. The setting carries the *reference*, not the key.

```jsonc
"insrc.tools.web.braveApiKeySource": {
  "type": "string",
  "enum": ["env", "keychain"],
  "default": "env",
  "description": "Where web:search looks for the Brave API key. `env` reads process.env.BRAVE_API_KEY (recommended for CI). `keychain` pulls from the IDE's secret store; configure via the 'insrc: Set Brave API Key' command."
}
```

Key storage itself goes through `IInsrcKeychainService` with service
id `insrc.tools.web.brave` + account `braveApiKey`. The daemon reads
it via an RPC when the tool fires.

### 7. Notification defaults (all optional)

Webhooks that users invoke repeatedly from the agent can be held as
defaults so the agent doesn't have to be told the URL every turn.
These are *defaults*; per-call `webhookUrl` always wins.

```jsonc
"insrc.tools.notify.slack.defaultWebhookRef": {
  "type": "string",
  "description": "Keychain reference (account name) for a default Slack webhook URL used by notify:slack when webhookUrl is omitted."
},
"insrc.tools.notify.teams.defaultWebhookRef": {
  "type": "string",
  "description": "Keychain reference for a default Teams webhook URL."
},
"insrc.tools.notify.discord.defaultWebhookRef": {
  "type": "string",
  "description": "Keychain reference for a default Discord webhook URL."
},
"insrc.tools.notify.email.smtpHost":    { "type": "string", "description": "Default SMTP host for notify:email." },
"insrc.tools.notify.email.smtpPort":    { "type": "number", "default": 587, "description": "Default SMTP port." },
"insrc.tools.notify.email.smtpUserRef": { "type": "string", "description": "Keychain reference for SMTP username." },
"insrc.tools.notify.email.smtpPassRef": { "type": "string", "description": "Keychain reference for SMTP password." },
"insrc.tools.notify.email.fromAddress": { "type": "string", "description": "Default From: address for notify:email." }
```

### 8. Destructive-operation guardrail

Some tools (`git:push --force` to protected refs, `cloud:aws:ec2:terminate`,
`k8s:delete --all`, `cloud:aws:s3:rm --recursive`) already require
token-style confirmation at call time. Let the user demand an extra
UI-level confirmation on top of that.

```jsonc
"insrc.tools.destructive.requireDoubleConfirm": {
  "type": "boolean",
  "default": false,
  "description": "Show an additional 'Are you sure?' dialog for destructive tool calls even after the agent has supplied the in-band confirmation token (e.g., confirmBucket, confirmCount). Belt-and-suspenders for shared / production environments."
}
```

## Consumption plan

1. **Settings register** in
   `src/vs/workbench/contrib/insrc/common/insrcConfiguration.ts` (one
   file, additive only; keep existing ordering).
2. **Workbench -> daemon plumbing.** All tool settings read by the
   daemon need to travel over IPC. Add a single RPC method
   `tools.config.get` that returns the relevant subtree, called by
   the daemon at startup and whenever a settings-change event fires.
   Avoid per-call RPCs; the daemon caches the snapshot.
3. **Keychain helpers.** A small `insrcKeychainService` method set:
   `setSecret(account, value)`, `getSecret(account)`, `deleteSecret`.
   Already partially exists; we add helpers per subsystem
   (`brave`, `notify.slack.<ref>`, `notify.email.smtpPass`).
4. **Migration for hardcoded caps.** Replace `MAX_EDIT_ROUNDS` in
   `daemon/tools/executor.ts`, `MAX_ITERATIONS` / `MAX_NUDGES` in
   `agent/tools/loop.ts`, `MAX_INLINE_CHARS` in `agent/tools/loop.ts`
   with reads from the cached settings snapshot. Defaults match
   current hardcodes so behavior doesn't shift when settings are
   absent.
5. **Commands (palette).** A small set of "insrc:" commands for
   operations that settings alone can't do: `insrc: Set Brave API
   Key`, `insrc: Set Slack Webhook`, `insrc: Set Teams Webhook`,
   `insrc: Set Email Credentials`, `insrc: Clear All Tool Secrets`.

## Verification

| Setting | How we know it works |
|---------|----------------------|
| `enabledCategories` | After setting `["file","search"]`, daemon startup log shows only file:* and search:* tools registered. |
| `approval.defaultAction` | Close the gate window without acting -> the default fires and the agent sees the matching result. |
| `loop.maxIterations` | Lower it to 5, run a research query that normally takes 10+ iterations -> loop hits limit and reports it. |
| `output.inlineMaxChars` | Run a grep that produces 100KB of output at threshold 12000 vs 200000 -> observe inline vs spill behavior. |
| `shell.defaultTimeoutMs` | Run `shell:exec` with `command: 'sleep 200'` and no per-call timeout -> tool kills at 120s by default, 60s when setting lowered to 60000. |
| `web.braveApiKeySource=keychain` | After `insrc: Set Brave API Key`, `web:search` succeeds even when BRAVE_API_KEY is unset in the shell. |
| `notify.slack.defaultWebhookRef` | Call `notify:slack` without `webhookUrl` -> uses the stored webhook. |
| `destructive.requireDoubleConfirm=true` | Call `git:push` with `forceToMain:true` on a protected ref -> dialog appears after the usual gate. |

## Open questions

- **Secret-ref vs key-path indirection.** We store the *account* name
  in settings (e.g., `defaultWebhookRef: "personal-slack"`) and the
  actual URL/password in the keychain. An alternative is hardcoding
  account names per setting (e.g., just one Slack webhook). The
  indirection lets users manage multiple Slack destinations;
  overkill for a single-user setup. Leaning indirection because
  keychain storage is cheap; revisit if the UX feels heavy.
- **Workspace vs user scope.** Currently everything is MACHINE. Some
  settings (approval.defaultAction, enabledCategories) make sense
  per-workspace (different risk tolerance for sandbox vs prod
  workspace). Add `"scope": "WINDOW"` for those, keep secrets at
  MACHINE.
- **Runtime-reload vs restart.** Do daemon-side settings take effect
  on the next agent turn, or is a daemon restart required?
  Preference: daemon subscribes to a workbench config-change event
  and refreshes its snapshot; no restart required for any setting
  above.
