# Using design/vscode-plugin

## Overview

Design document for Using design/vscode-plugin. 5 of 5 requirements addressed.

## Requirements Summary

1. [FUNCTIONAL] The CLI shall support all core functionalities available in the VS Code plugin, including intent classification, local LLM execution, and Claude API routing — with command-line options for specifying intent (--intent), forcing Claude routing (--claude), outputting JSON (--json), and setting the working directory (--cwd) — DONE
2. [FUNCTIONAL] The CLI shall support structured JSON output for programmatic consumption — DONE
3. [SYSTEM] The CLI shall connect to a locally running insrc daemon via IPC channel for all agent operations — DONE
4. [SYSTEM] The CLI shall handle daemon initialization, including installation, Ollama detection, model pulling, and first-run API key configuration — DONE
5. [SYSTEM] The CLI shall support all Claude model variants (Haiku, Sonnet, Opus) with metrics tracking, caching, and rate limiting when Claude routing is enabled — DONE

### Requirement 1: The CLI shall support all core functionalities available in the VS Code plugin, including intent classification, local LLM execution, and Claude API routing — with command-line options for specifying intent (--intent), forcing Claude routing (--claude), outputting JSON (--json), and setting the working directory (--cwd)

# 1. INTERFACE CONTRACTS

// File: /src/cli/index.ts
interface AskOpts {
  intent?: string;
  claude?: boolean;
  json?: boolean;
  cwd?: string;
}

// File: /src/agent/classifier/index.ts
interface ClassifyResult {
  intent: Intent;
  confidence: number;
  reasoning: string;
}

// File: /src/agent/cli.ts
interface OneShotOpts {
  intent: Intent;
  claude?: boolean;
}

interface OneShotResult {
  output: string;
  metadata: {
    intent: Intent;
    provider: 'local' | 'claude';
    timestamp: number;
    tokensUsed?: number;
  };
}

// File: /src/cli/formatters/json-output-formatter.ts
interface JsonOutputFormatter {
  format(result: OneShotResult): string;
}


# 2. DATA FLOW

1. ENTRY: CLI receives insrc ask  [options]
   - Arguments parsed into AskOpts structure by existing parser in /src/cli/index.ts

2. INIT: WorkingDirectoryResolver validates --cwd option
   - Calls validateCwd(cwd) from /src/cli/resolvers/working-dir-resolver.ts
   - Sets process.cwd() or throws error if invalid

3. CLASSIFICATION: If intent NOT overridden (AskOpts.intent is null):
   - Calls classify(message) from /src/agent/classifier/index.ts
   - Returns ClassifyResult with primary intent
   - Extracts primaryIntent from result

4. ROUTING: Routing decision logic:
   - If AskOpts.claude=true: Use Claude routing
   - Else if isClaudeDefault(primaryIntent, config): Use Claude routing (fallback)
   - Else: Use local agent routing

5. EXECUTION: Execute one-shot operation:
   - Calls runOneShot(message, OneShotOpts) from /src/agent/cli.ts
   - OneShotOpts = { intent: primaryIntent, claude?: AskOpts.claude }
   - [CRITICAL] Must ensure session initialization via initializeSession(cwd) before this call
   - Returns OneShotResult with output and metadata

6. FORMAT: Output formatting:
   - If AskOpts.json=true: 
     - Calls JsonOutputFormatter.format(OneShotResult) from /src/cli/formatters/json-output-formatter.ts
     - Returns JSON string
   - Else: Pretty-print to console using default formatter

7. OUTPUT: Write result to stdout and exit with code 0

# 3. INTEGRATION POINTS

## Files and Functions:

- Entry Point: /src/cli/index.ts 
  - Parses CLI arguments into AskOpts
  - Contains existing AskOpts interface definition
  - Must integrate with new command handler logic if not already present

- Intent Classification: /src/agent/classifier/index.ts
  - Function: classify(message: string): Promise
  - Interface: ClassifyResult

- Routing Logic: /src/agent/router.ts
  - Function: isClaudeDefault(intent: Intent, config: any): boolean

- Agent Selection: /src/agent/orchestrator/agent-router.ts
  - Function: selectAgent(intent: Intent): Agent

- Local Execution: /src/agent/cli.ts
  - Function: runOneShot(message: string, opts: OneShotOpts): Promise
  - Interface: OneShotOpts, OneShotResult

- Claude Provider: /src/agent/providers/claude.ts
  - Class: ClaudeProvider
  - Requires ANTHROPIC_API_KEY environment variable

- Working Directory Resolver: /src/cli/resolvers/working-dir-resolver.ts
  - Function: validateCwd(cwd: string): void

- JSON Formatter: /src/cli/formatters/json-output-formatter.ts
  - Interface: JsonOutputFormatter
  - Function: format(result: OneShotResult): string

# 4. MIGRATION NOTES

## Modified Entities:

1. AskOpts interface in /src/cli/index.ts:
   - Change: Added optional properties intent, claude, json, cwd
   - Impact: No breaking changes; existing code using this interface will continue to work
   - Migration: No action required for existing consumers

2. runOneShot function in /src/agent/cli.ts:
   - Change: Function signature now requires session initialization before execution
   - Impact: CLI must call initializeSession(cwd) before calling runOneShot
   - Migration: Update CLI command handler to include session setup step

## New Entities:

1. JsonOutputFormatter in /src/cli/formatters/json-output-formatter.ts:
   - Change: New formatter class for JSON output
   - Impact: No existing code affected; new functionality only

2. WorkingDirectoryResolver in /src/cli/resolvers/working-dir-resolver.ts:
   - Change: New validation logic for --cwd option
   - Impact: No existing code affected; new functionality only

# 5. RISKS

## Critical Risks:

1. Session Initialization Blocking Risk [FLAG]
   - Issue: runOneShot() function depends on session state initialization
   - Location: /src/agent/cli.ts:557
   - Impact: CLI may crash silently if daemon not running or session not bootstrapped
   - Mitigation Required: Add explicit session initialization check before calling runOneShot()

2. Daemon Availability & IPC Setup [FLAG]
   - Issue: Sketch assumes daemon is already running
   - Location: No explicit daemon check in CLI flow
   - Impact: CLI may fail during first-run setup or if daemon not available
   - Mitigation Required: Add isDaemonRunning() check and ensureDaemonReady(cwd) call before execution

3. Claude API Key Validation [FLAG]
   - Issue: No explicit validation of ANTHROPIC_API_KEY when Claude routing is forced or selected
   - Location: /src/agent/providers/claude.ts
   - Impact: Runtime error if key missing but Claude routing is triggered
   - Mitigation Required: Add API key validation in CLI before routing decision

## Integration Risks:

1. Existing CLI Parser Logic:
   - Issue: Need to verify /src/cli/index.ts already handles argument parsing
   - Impact: May require creating new handler if existing logic insufficient
   - Mitigation Required: Confirm parser capability or implement new handler structure

2. Dependency on Daemon State:
   - Issue: CLI must handle daemon startup gracefully per Requirement #4
   - Impact: Complex error handling needed for first-run scenarios
   - Mitigation Required: Implement robust daemon setup orchestration in CLI command handler

---

### Requirement 2: The CLI shall support structured JSON output for programmatic consumption

# Interface Contracts

## TypeScript Signatures

// From src/cli/index.ts
interface AskOpts {
  intent?: string;
  claude?: boolean;
  json?: boolean;
  cwd?: string;
}

interface OneShotResult {
  output: string; // JSON string when --json flag is used
  metadata?: {
    intent: Intent;
    provider: 'local' | 'claude';
    timestamp: number;
    tokensUsed?: number;
  };
}

// Updated formatResult function signature
function formatResult(
  response: string,
  intent: Intent,
  usedClaude: boolean,
  json: boolean
): OneShotResult {
  // Implementation details...
}

// From pipeline/types.ts (referenced)
type OutputFormat = 'text' | 'json';


# Data Flow

1. CLI Input Processing
   - insrc ask "..." --json → parsed into AskOpts with json: true
   - File: /src/cli/index.ts
   - Function: main() (CLI entry point)

2. Execution Path
   - runOneShot(AskOpts) called
   - File: /src/cli/index.ts
   - Function: runOneShot()
   - formatResult(response, intent, usedClaude, json: true) called
   - File: /src/cli/index.ts
   - Function: formatResult()

3. Output Generation
   - formatResult() returns OneShotResult with output as JSON string
   - CLI writes result.output to stdout
   - File: /src/cli/index.ts
   - Function: main() (stdout write)

# Integration Points

## Existing Codebase Integration

### Files and Functions:
- File: /src/cli/index.ts
  - Function: main() - CLI entry point that parses AskOpts
  - Function: runOneShot() - Core execution function
  - Function: formatResult() - Output formatting (modified)
  - Interface: AskOpts - Input parsing structure

- File: /src/pipeline/types.ts
  - Type: OutputFormat - Defines output format options ('text' | 'json')
  - Note: Currently unused in CLI but referenced for consistency

### Key Integration Points:
1. AskOpts.json flag is passed directly to formatResult()
2. formatResult() function signature updated to accept boolean json parameter
3. Return value of formatResult() now includes JSON string in output field
4. CLI stdout write operation remains unchanged, but now writes structured JSON

# Migration Notes

## Modified Entities

### 1. formatResult() Function Signature
- Change: Added json: boolean parameter
- Impact: All calls to formatResult() must include this new parameter
- Migration Path: 
  - Update all existing calls in /src/cli/index.ts
  - Add conditional logic to return JSON string when json: true
  - Maintain backward compatibility for json: false (text output)

### 2. OneShotResult Interface
- Change: output field now contains JSON string when --json is used
- Impact: CLI consumers expecting text output must handle JSON parsing
- Migration Path:
  - Update any code that consumes OneShotResult.output to check if it's already a JSON string
  - No breaking changes for existing functionality

### 3. AskOpts Interface
- Change: No modification required (already includes json?: boolean)
- Impact: No migration needed

# Risks and Mitigation

## High Priority Risks

### 1. VS Code Plugin Consistency
- Risk: CLI JSON support may be inconsistent with VS Code plugin if it doesn't support JSON output
- Mitigation: 
  - Verify that VS Code plugin also supports --json flag in its implementation
  - Document this requirement in both CLI and VS Code plugin documentation
  - Consider adding a feature flag or version check to ensure consistency

### 2. Daemon Integration
- Risk: If daemon handles runOneShot() call, JSON formatting may happen on different process
- Mitigation:
  - Clarify that runOneShot() is currently CLI-based (not daemon)
  - If daemon integration is added later, ensure daemon returns OneShotResult with proper JSON string format
  - Add unit tests to verify JSON serialization consistency

### 3. Setup Command JSON Support
- Risk: insrc setup may not support structured JSON output for scripted scenarios
- Mitigation:
  - Confirm if setup commands need --json support (requirement clarification needed)
  - If needed, extend setup command with similar JSON output capability

## Medium Priority Risks

### 4. Aggregate Pipeline Results
- Risk: Current formatResult handles single-shot only
- Mitigation:
  - Design formatResult to be generic or create parallel formatPipelineResultAsJson()
  - Future-proof by using consistent interface design for all output formats

### 5. Streaming vs JSON
- Risk: Large responses (>50KB) will cause memory/latency issues in streaming scenarios
- Mitigation:
  - Document that --json disables streaming mode
  - Serialize only final aggregated result when --json is used
  - Add warning for large outputs when using JSON mode

### 6. OutputFormat Type Consistency
- Risk: Inconsistent use of boolean vs enum for JSON output flag
- Mitigation:
  - Unify: use OutputFormat: 'json' instead of json: boolean for consistency
  - Update all related interfaces and functions to use consistent type definition
  - File: /src/pipeline/types.ts should be updated to reflect this change

---

### Requirement 3: The CLI shall connect to a locally running insrc daemon via IPC channel for all agent operations

# Requirement 3 Design: CLI to Daemon IPC Connection

## 1. INTERFACE CONTRACTS

### TypeScript Signatures

// File: /home/subho/work/dev/insors/insrc/src/shared/types.ts

interface IpcRequest {
  method: string;
  params: any;
  requestId: string;
}

interface IpcResponse {
  type: 'delta' | 'progress' | 'checkpoint' | 'done' | 'error';
  requestId: string;
  data?: any;
  error?: {
    message: string;
    code?: string;
  };
}

// File: /home/subho/work/dev/insors/insrc/src/cli/client.ts

interface RpcOptions {
  retries?: number;
  timeoutMs?: number;
}

/**
 * Sends an RPC request to the daemon via IPC channel
 * @param method - The method name to call on the daemon
 * @param params - Parameters for the method
 * @param options - Optional RPC configuration
 * @returns Promise resolving to final result or rejecting on error
 */
async function rpc(method: string, params: any, options?: RpcOptions): Promise;

// File: /home/subho/work/dev/insors/insrc/src/daemon/chat-handler.ts

interface ChatSendParams {
  message: string;
  intent?: string;
  claude?: boolean;
  json?: boolean;
  cwd?: string;
}

/**
 * Handles chat send operations, routing to appropriate LLM or Claude client
 */
async function chatSend(params: ChatSendParams, channel: DaemonChannel): Promise;


## 2. DATA FLOW

1. CLI Entry Point (src/cli/index.ts)
   - Parses argv into AskOpts object
   - Calls rpc('agent.ask', { message, ...askOpts })

2. RPC Implementation (src/cli/client.ts)
   - Constructs IpcRequest with method 'agent.ask', params from CLI, and unique requestId
   - Connects to Unix socket at PATHS.sockFile
   - Sends JSON-encoded request
   - Listens for streaming IpcResponse messages until 'done' or 'error' type is received

3. Daemon Server Reception (src/daemon/server.ts)
   - Parses incoming IpcRequest from socket
   - Routes to handler based on method (e.g., 'agent.ask' → chatSend)
   - Creates new DaemonChannel instance for streaming response handling

4. Daemon Execution (src/daemon/chat-handler.ts)
   - Executes intent classification and LLM processing
   - Uses DaemonChannel to emit progress/delta/checkpoint messages back to CLI
   - On completion, emits final 'done' message with result data

5. CLI Response Collection (src/cli/client.ts)
   - Accumulates streaming messages from daemon
   - Reconstructs structured output when --json flag is set
   - Resolves Promise with final result on 'done' or rejects on 'error'

6. CLI Output Formatting
   - If --json: converts result to structured JSON and prints
   - Otherwise: pretty-prints to stdout
   - Exits with appropriate code (0 for success, non-zero for error)

## 3. INTEGRATION POINTS

### Files and Functions Involved:

CLI Entry Point:
- File: /home/subho/work/dev/insors/insrc/src/cli/index.ts
- Function: main() - parses CLI arguments and calls rpc()

RPC Client Implementation:
- File: /home/subho/work/dev/insors/insrc/src/cli/client.ts
- Function: rpc(method, params) - handles IPC communication
- Interface: IpcRequest, IpcResponse (imported from shared types)

Daemon Server:
- File: /home/subho/work/dev/insors/insrc/src/daemon/server.ts
- Class: IpcServer - receives and routes IPC requests
- Method: handleRequest() - parses incoming request and dispatches to handlers

Chat Handler:
- File: /home/subho/work/dev/insors/insrc/src/daemon/chat-handler.ts
- Function: chatSend(params, channel) - main execution logic for agent.ask
- Class: DaemonChannel - handles streaming response messages

Shared Types:
- File: /home/subho/work/dev/insors/insrc/src/shared/types.ts
- Interfaces: IpcRequest, IpcResponse

## 4. MIGRATION NOTES

### Modified Entities:

1. rpc() function in src/cli/client.ts:
   - Change: Extended to handle streaming responses instead of single request-response
   - Impact: All existing CLI commands using rpc() will now support progress updates and structured JSON output
   - Backward Compatibility: Fully maintained - existing code that calls rpc() with simple responses continues to work

2. IpcResponse interface in src/shared/types.ts:
   - Change: Added new message types ('delta', 'progress', 'checkpoint') to support streaming
   - Impact: CLI and daemon components must now handle these additional response types
   - Backward Compatibility: Maintained for existing code that only uses 'done' and 'error' types

### Migration Steps:
1. Update rpc() implementation in src/cli/client.ts to collect streaming messages
2. Ensure all CLI commands that use rpc() properly handle the new streaming behavior
3. Verify that daemon-side handlers correctly emit the new response types
4. Test both single-response and streaming scenarios

## 5. RISKS

### Critical Risks:

1. Streaming Response Handling Not Yet Implemented:
   - Risk: Current rpc() function only handles single request-response calls, not streaming
   - Mitigation: Implement streaming message collection logic in rpc() that accumulates messages until 'done' or 'error' is received

2. Daemon Must Be Running:
   - Risk: CLI commands will fail with connection errors if daemon isn't running
   - Mitigation: Add user-friendly error handling that suggests insrc setup or insrc daemon start when socket connection fails

3. Socket Path Configuration Issues:
   - Risk: Hard-coded PATHS.sockFile may cause permission or environment-specific issues
   - Mitigation: Implement environment variable override (INSRC_SOCK) and document socket location clearly

### Integration Risks:

4. Cross-Requirement: Requirement 1 ↔ Requirement 3:
   - Risk: CLI must preserve structured metadata from streaming messages for --json output
   - Mitigation: Verify that IpcResponse.delta messages include sufficient context to reconstruct JSON when needed

5. Cross-Requirement: Requirement 3 ↔ Requirement 5 (Claude Routing):
   - Risk: Daemon-side chatSend handler must properly respect claude flag from IPC requests
   - Mitigation: Confirm that chatSend in src/daemon/chat-handler.ts accepts and processes the claude parameter correctly

6. Daemon Initialization Prerequisite:
   - Risk: Requirement 3 assumes daemon is already running, but Requirement 4 (daemon initialization) isn't implemented yet
   - Mitigation: Add clear error messages directing users to insrc setup or insrc daemon start when connection fails

---

### Requirement 4: The CLI shall handle daemon initialization, including installation, Ollama detection, model pulling, and first-run API key configuration

# Requirement 4: CLI Daemon Initialization

## 1. INTERFACE CONTRACTS

### New/Modified Entities

// File: src/cli/commands/setup.ts

interface SetupOptions {
  nonInteractive?: boolean;
  ollamaInstallPath?: string;
  modelDownloadTimeout?: number;
}

interface OllamaStatus {
  available: boolean;
  version?: string;
  installPath?: string;
  permissionError?: boolean;
  notRunning?: boolean;
}

interface ModelProgress {
  current: number;
  total: number;
  modelName: string;
  status: 'downloading' | 'extracting' | 'completed';
}

type SetupStep = 
  | 'ollama-validation'
  | 'model-installation'
  | 'config-setup'
  | 'daemon-start';

interface SetupProgress {
  step: SetupStep;
  message: string;
  progress?: ModelProgress;
}

// Function signatures
async function setupCommand(options: SetupOptions): Promise;
async function detectOllama(): Promise;
async function isOllamaAvailable(timeoutMs: number): Promise;
async function pullModels(onProgress: (progress: ModelProgress) => void): Promise;
async function applyConfig(apiKey: string): Promise;
async function ensureAgentModel(host: string, onProgress?: (progress: ModelProgress) => void): Promise;
async function ensureEmbeddingModel(onProgress?: (progress: ModelProgress) => void): Promise;
async function promptBraveKeySetup(): Promise;


// File: src/shared/system-info.ts

interface SystemInfo {
  os: string;
  arch: string;
  nodeVersion: string;
  ollamaStatus: OllamaStatus;
}

function detectOllama(): Promise;
function getSystemInfo(): Promise;


// File: src/agent/lifecycle.ts

interface ModelInstallationOptions {
  host?: string;
  onProgress?: (progress: ModelProgress) => void;
  timeoutMs?: number;
}

async function ensureAgentModel(options: ModelInstallationOptions): Promise;
async function ensureEmbeddingModel(options: ModelInstallationOptions): Promise;


// File: src/cli/commands/daemon.ts

interface DaemonStartOptions {
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  port?: number;
}

async function cmdStart(options: DaemonStartOptions): Promise;


## 2. DATA FLOW

### Concrete Path Through Components

1. User Input → setupCommand() (src/cli/commands/setup.ts:17)
   - Parses CLI arguments and options
   - Calls SetupOrchestrator.initialize(options)

2. Ollama Validation Phase 
   - OllamaValidator.ensureAvailable() → detectOllama() (src/shared/system-info.ts:270)
     - Returns OllamaStatus object with availability details
     - If not available, prompts user for installation or Docker fallback
   - isOllamaAvailable(30000) with retry logic
     - Returns boolean indicating if Ollama is running and accessible

3. Model Installation Phase
   - ModelInstaller.installRequired(progress_callback) → pullModels()
     - Calls ensureAgentModel(host='localhost:11434', onProgress)
     - Calls ensureEmbeddingModel(onProgress)
     - Handles network failures with exponential backoff
     - Reports progress every 5-10 seconds

4. Configuration Setup Phase
   - SetupConfigManager.applyFirstRunConfig()
     - If interactive mode: promptBraveKeySetup() → applyConfig(apiKey)
     - If non-interactive mode: applyConfig(apiKey from env or default)

5. Daemon Launch (Optional)
   - User runs insrc daemon start
   - cmdStart() launches daemon with logging
   - Calls buildDaemonTransport() for IPC channel setup

### Entity Flow Chain:
setupCommand() 
  → SetupOrchestrator.initialize()
    → OllamaValidator.ensureAvailable() 
      → detectOllama() 
        → isOllamaAvailable(30000)
    → ModelInstaller.installRequired()
      → pullModels()
        → ensureAgentModel()
        → ensureEmbeddingModel()
    → SetupConfigManager.applyFirstRunConfig()
      → promptBraveKeySetup() or applyConfig()
  → cmdStart() (optional)


## 3. INTEGRATION POINTS

### Existing Code Integration

Files and Functions:
- src/cli/commands/setup.ts:
  - Entry point: setupCommand() (line 17)
  - Implementation: pullModels() (line 155), applyConfig() (line 120)
  - References: detectOllama(), ensureAgentModel(), ensureEmbeddingModel()

- src/shared/system-info.ts:
  - Function: detectOllama() (line 270)
  - Function: getSystemInfo() 

- src/agent/lifecycle.ts:
  - Function: ensureAgentModel() (line 12)
  - Function: ensureEmbeddingModel()

- src/cli/commands/daemon.ts:
  - Function: cmdStart() (line 41)
  - Function: buildDaemonTransport() (referenced)

### Cross-Component Dependencies:
- setupCommand() depends on detectOllama() and ensureAgentModel()
- pullModels() calls both ensureAgentModel() and ensureEmbeddingModel()
- applyConfig() persists configuration to local storage
- cmdStart() uses buildDaemonTransport() for IPC communication

## 4. MIGRATION NOTES

### Modified Entities:

1. detectOllama() in src/shared/system-info.ts:
   - Change: Enhanced return type from simple boolean to structured OllamaStatus object
   - Impact: All calling functions must be updated to handle new return structure
   - Migration: Update all call sites to check status.available, status.version, etc.

2. ensureAgentModel() in src/agent/lifecycle.ts:
   - Change: Added optional onProgress callback parameter for progress reporting
   - Impact: Existing calls without this parameter remain functional
   - Migration: Add progress callback handling where needed

3. ensureEmbeddingModel() in src/agent/lifecycle.ts:
   - Change: Added optional onProgress callback parameter for progress reporting
   - Impact: Same as above
   - Migration: Add progress callback handling where needed

4. setupCommand() in src/cli/commands/setup.ts:
   - Change: New nonInteractive option support and enhanced error handling
   - Impact: CLI interface extended with new flag
   - Migration: No breaking changes, backward compatibility maintained

## 5. RISKS

### Identified Risks from Sketch Concerns:

1. Ollama Installation & Permissions
   - Risk: Silent failures in detectOllama() 
   - Mitigation: Implement explicit status checking and user guidance
   - Handling: OllamaValidator must distinguish between "not installed", "no permission", and "not running" states

2. Model Download Timeouts & Interruption
   - Risk: Long download times causing user frustration or hanging processes
   - Mitigation: Implement cancelable operations with SIGINT handling
   - Handling: Add progress reporting every 5-10 seconds, retry logic (max 3 attempts), and resume capability

3. Setup Hanging Due to Slow Ollama Startup
   - Risk: Setup process hangs if Ollama startup is slow (>30s)
   - Mitigation: Implement timeout with clear error messages
   - Handling: isOllamaAvailable() must have configurable timeout and retry logic

4. Network Failure During Model Pulling
   - Risk: Transient network failures causing setup to fail completely
   - Mitigation: Implement exponential backoff retry strategy
   - Handling: ModelInstaller must support retry with appropriate delays

5. Progress Reporting Inconsistency
   - Risk: Progress updates not visible or inconsistent during long operations
   - Mitigation: Ensure regular progress callbacks and UI updates
   - Handling: Implement consistent progress reporting every 5-10 seconds for model downloads

---

### Requirement 5: The CLI shall support all Claude model variants (Haiku, Sonnet, Opus) with metrics tracking, caching, and rate limiting when Claude routing is enabled

# Requirement 5 Design Section  
The CLI shall support all Claude model variants (Haiku, Sonnet, Opus) with metrics tracking, caching, and rate limiting when Claude routing is enabled

---

## 1. INTERFACE CONTRACTS

### New/Modified TypeScript Interfaces and Types

// File: /home/subho/work/dev/insors/insrc/src/cli/index.ts

interface AskOpts {
  intent?: string;
  claude?: boolean;
  json?: boolean;
  cwd?: string;
  model?: 'haiku' | 'sonnet' | 'opus'; // NEW — added for model variant selection
}

// File: /home/subho/work/dev/insors/insrc/src/agent/providers/claude.ts

interface ClaudeModel {
  name: string;
  maxTokens: number;
  contextWindow: number;
  costPerInputToken: number;
  costPerOutputToken: number;
}

interface ClaudeProviderConfig {
  defaultModel: 'haiku' | 'sonnet' | 'opus';
  models: Record<'haiku' | 'sonnet' | 'opus', ClaudeModel>;
  getModel(modelName: 'haiku' | 'sonnet' | 'opus'): ClaudeModel;
}

// File: /home/subho/work/dev/insors/insrc/src/agent/smart-router.ts

interface RouterDeps {
  claudeProvider: ClaudeProvider;
  ollamaProvider: OllamaProvider;
  cache: LRUCache;
  rateLimiter: RateLimiter;
  metricsTracker: MetricsTracker;
}

type RouteResult = {
  provider: 'claude' | 'ollama';
  model?: string;
  intent?: Intent;
};

// File: /home/subho/work/dev/insors/insrc/src/agent/services/claude-client.ts

interface ClaudeMetrics {
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number;
  cacheHit: boolean;
  model: 'haiku' | 'sonnet' | 'opus';
}

interface RateLimitConfig {
  maxTokensPerMinute: Record<'haiku' | 'sonnet' | 'opus', number>;
}


---

## 2. DATA FLOW

### Concrete Path Through Components

1. CLI Entry Point
   - insrc ask  [options] command in /home/subho/work/dev/insors/insrc/src/cli/commands/ask.ts
   - Parses AskOpts, including new model field
   - Instantiates ClaudeCliClient with parsed options

2. Routing Decision
   - ClaudeCliClient.route() method:
     - Checks opts.claude flag to force Claude path
     - If not forced, delegates to SmartRouter.route(routerDeps)
     - Validates hasClaudeKey() before proceeding

3. Model Selection
   - selectModelVariant(opts.model || 'sonnet')
   - Returns ClaudeModel from ClaudeProviderConfig

4. Caching Layer
   - Generates cache key using cacheKey(userQuery, intent, model) helper
   - Checks LRUCache.get(key) before API call
   - Stores result after successful API response

5. Rate Limiting Enforcement
   - Calls ClaudeCliClient.rateLimiter.canProceed(model)
   - Returns 429 Too Many Requests if limit exceeded

6. Metrics Tracking
   - Records pre-call metrics (timestamp, model, intent, input tokens)
   - Records post-call metrics (output tokens, latency, cache hit/miss, cost)
   - Aggregates per model variant (claude-haiku-*, claude-sonnet-*, etc.)

7. Execution
   - Calls ClaudeProvider.complete(prompt, selectedModel)
   - Catches errors (API error, rate limit, key missing)
   - Falls back to ollamaProvider.complete() if Claude fails

8. Output Formatting
   - Formats result using existing logic in formatResult()
   - Outputs plain text or JSON based on opts.json

---

## 3. INTEGRATION POINTS

### Existing Codebase Integration

| Component | File | Function/Class |
|----------|------|----------------|
| CLI Command Entry | /home/subho/work/dev/insors/insrc/src/cli/commands/ask.ts | ask(message, opts: AskOpts) |
| Routing Logic | /home/subho/work/dev/insors/insrc/src/agent/smart-router.ts | SmartRouter.route(routerDeps) |
| Claude Provider | /home/subho/work/dev/insors/insrc/src/agent/providers/claude.ts | ClaudeProvider, ClaudeProviderConfig |
| Caching | /home/subho/work/dev/insors/insrc/src/agent/smart-router.ts | LRUCache, cacheKey() helper |
| Rate Limiter | /home/subho/work/dev/insors/insrc/src/agent/services/rate-limiter.ts | RateLimiter class |
| Metrics Tracker | /home/subho/work/dev/insors/insrc/src/agent/services/metrics-tracker.ts | MetricsTracker class |
| Key Validation | /home/subho/work/dev/insors/insrc/src/agent/session.ts | hasClaudeKey() |

### New Service File

- New File: /home/subho/work/dev/insors/insrc/src/agent/services/claude-client.ts
  - Exports ClaudeCliClient class
  - Integrates all existing components (SmartRouter, ClaudeProvider, LRUCache, RateLimiter, MetricsTracker)
  - Implements unified routing, caching, rate limiting, and metrics tracking

---

## 4. MIGRATION NOTES

### Modified Entities

| Entity | Change Description | Impact |
|--------|--------------------|--------|
| AskOpts | Added optional model?: 'haiku' | 'sonnet' | 'opus' field | Backward compatible; CLI will default to sonnet if not specified |
| ClaudeProviderConfig | Already exists, but now used for dynamic model selection | No breaking change; only new usage pattern |
| SmartRouter.route() | No modification required; existing logic reused | No impact on other routing paths |

### Migration Steps

1. Update CLI argument parsing in /home/subho/work/dev/insors/insrc/src/cli/commands/ask.ts to include --model option
2. Extend AskOpts interface with new model field (already done above)
3. Create new service file /home/subho/work/dev/insors/insrc/src/agent/services/claude-client.ts
4. Refactor CLI command to instantiate and use ClaudeCliClient
5. Ensure all metrics and rate limiting logic is wired into the new service

---

## 5. RISKS

### Identified Risks

1. Model Variant Selection Misalignment
   - Risk: If AskOpts doesn't support --model, CLI may not allow user to select Haiku/Sonnet/Opus
   - Mitigation: Add model option to CLI parser and validate input against known variants

2. Rate Limiting Granularity
   - Risk: Per-model rate limits may be too strict or too lenient
   - Mitigation: Use empirical data from Anthropic API documentation for initial values; allow configuration override

3. Caching Invalidation
   - Risk: Cache key generation might not account for all relevant parameters (e.g., intent, model)
   - Mitigation: Use cacheKey() helper consistently and test with various inputs

4. Fallback Behavior
   - Risk: If Claude fails, fallback to Ollama may not be robust
   - Mitigation: Ensure ollamaProvider.complete() is properly integrated and tested in error scenarios

5. Metrics Aggregation
   - Risk: Metrics tracking may not scale well with high-frequency calls
   - Mitigation: Implement batched or periodic aggregation; consider sampling for performance

6. Backward Compatibility
   - Risk: Existing CLI usage without --model could break if defaults change
   - Mitigation: Default to sonnet as per README, maintain explicit opt-in behavior

---

## Architecture Summary

Reused Entities:
- [local] [insrc] function rpc — /home/subho/work/dev/insors/insrc/src/cli/client.ts:11
- [local] [insrc] interface IpcRequest — /home/subho/work/dev/insors/insrc/src/shared/types.ts:367
- [local] [insrc] interface IpcResponse — /home/subho/work/dev/insors/insrc/src/shared/types.ts:374
- [local] [insrc] class DaemonChannel — /home/subho/work/dev/insors/insrc/src/daemon/channel.ts:18
- [local] [insrc] function chatSend — /home/subho/work/dev/insors/insrc/src/daemon/chat-handler.ts:124
- [local] [insrc] class IpcServer — /home/subho/work/dev/insors/insrc/src/daemon/server.ts
- [local] [insrc] interface Channel — (referenced in local sketch)
- [local] -- — 
- [local] [insrc] setupCommand — /home/subho/work/dev/insors/insrc/src/cli/commands/setup.ts:17
- [local] [insrc] pullModels — /home/subho/work/dev/insors/insrc/src/cli/commands/setup.ts:155
- [local] [insrc] applyConfig — /home/subho/work/dev/insors/insrc/src/cli/commands/setup.ts:120
- [local] [insrc] detectOllama — /home/subho/work/dev/insors/insrc/src/shared/system-info.ts:270
- [local] [insrc] ensureAgentModel — /home/subho/work/dev/insors/insrc/src/agent/lifecycle.ts:12
- [local] [insrc] promptBraveKeySetup — /home/subho/work/dev/insors/insrc/src/agent/index.ts:1280
- [local] [insrc] cmdStart — /home/subho/work/dev/insors/insrc/src/cli/commands/daemon.ts:41
- [local] [insrc] ensureEmbeddingModel — /home/subho/work/dev/insors/insrc/src/cli/commands/setup.ts (inferred)
- [local] [insrc] isOllamaAvailable — (referenced in local list)
- [local] [insrc] buildDaemonTransport — (referenced in local list)

## Risks & Open Questions

- Req 2: ### 🔴 HIGH PRIORITY
- Req 2: 1. Requirement #1 vs #2 conflict (Both reference insrc ask with --json):
- Req 2: - Req#1: "all core functionalities available in VS Code plugin"
- Req 2: - Req#2: "structured JSON output for programmatic consumption"
- Req 2: - Risk: If vs-code plugin doesn't output JSON, CLI JSON support may be inconsistent with plugin
- Req 2: - Action: Verify vs-code plugin also supports JSON output (referenced in design/vscode-plugin.html but not confirmed in sketch)
- Req 2: 2. Requirement #3: Daemon integration (IPC channel for agent operations):
- Req 2: - Current sketch assumes formatResult runs in CLI process
- Req 2: - Concern: Is JSON formatting happening in daemon or CLI?
- Req 2: - Risk: If daemon-side, need to verify daemon's JSON serialization matches CLI expectations
- Req 2: - Action: Clarify: does runOneShot() call daemon? If yes, ensure daemon returns JSON-compatible OneShotResult
- Req 2: 3. Requirement #4: Daemon initialization:
- Req 2: - No mention of --json support during setup flow
- Req 2: - Risk: insrc setup may not output structured JSON for scripted scenarios
- Req 2: - Action: Confirm if setup commands need --json support (requirement clarification needed)
- Req 2: ### 🟡 MEDIUM PRIORITY
- Req 2: 4. Aggregate pipeline results (your concern is valid):
- Req 2: - Current formatResult handles single-shot only
- Req 2: - Risk: insrc ask is one-shot, but other commands (e.g., insrc assemble, future batch modes) need JSON output too
- Req 2: - Action: Design formatResult to be generic or create parallel formatPipelineResultAsJson() for future use
- Req 2: 5. Streaming vs. JSON:
- Req 2: - JSON serialization requires buffering entire response
- Req 2: - Risk: Large responses (>50KB) will cause memory/latency issues in streaming scenarios
- Req 2: - Mitigation: Document that --json disables streaming; serialize only final aggregated result
- Req 2: 6. OutputFormat type consistency:
- Req 2: - /pipeline/types.ts:90 defines OutputFormat with 'json' option
- Req 2: - Verify formatResult respects this type definition (not just boolean json parameter)
- Req 2: - Action: Unify: use OutputFormat: 'json' instead of json: boolean for consistency
- Req 2: --
- Req 3: ### [CRITICAL]
- Req 3: 1. Streaming Response Handling Not Yet Implemented
- Req 3: The current rpc() function in src/cli/client.ts only handles single request-response calls. Requirement 1 (insrc ask with progress updates) will require extending rpc() to collect streaming messages before resolving the Promise. The daemon already supports streaming via DaemonChannel (types: 'delta' | 'progress' | 'checkpoint' | 'done'), but the CLI half is incomplete.
- Req 3: Action: Update rpc() to listen for IpcResponse messages with type field and accumulate until 'done' or 'error' is received.
- Req 3: 2. Daemon Must Be Running
- Req 3: CLI commands will fail with "daemon not running" or socket connection error if insrc daemon is not running. Requirement 4 (daemon initialization) must be implemented in insrc setup to address this, but Requirement 3 assumes the daemon is already available.
- Req 3: Action: Ensure error message is user-friendly and suggests insrc setup or insrc daemon start.
- Req 3: 3. Socket Path Configuration
- Req 3: Hard-coded PATHS.sockFile path may cause issues if:
- Req 3: - Multiple users on same machine (socket file permissions)
- Req 3: - Different environments (macOS /var/tmp vs Linux /tmp)
- Req 3: - Non-standard daemon installation paths
- Req 3: Action: Consider environment variable override (e.g., INSRC_SOCK) and document socket location.
- Req 3: ### [INTEGRATION RISKS]
- Req 3: 4. Cross-Requirement: Requirement 1 ↔ Requirement 3
- Req 3: Requirement 1 expects insrc ask to support --json output format. Requirement 3 specifies IPC connection. The flow works, but the rpc() function must preserve structured metadata from streaming messages so CLI can reconstruct full JSON output. If daemon streams raw deltas, CLI needs to reassemble them correctly.
- Req 3: Action: Verify that IpcResponse.delta messages include enough context to reconstruct structured output when --json is set.
- Req 3: 5. Cross-Requirement: Requirement 3 ↔ Requirement 5 (Claude Routing)
- Req 3: When --claude flag is set in Requirement 1, the CLI calls rpc('agent.ask', { claude: true, ... }). The daemon's chatSend handler must route this to the Anthropic Claude Client. The IPC channel itself is agnostic, but the daemon-side handler (chatSend) must implement this logic. This is not a direct concern for Requirement 3, but the IPC contract must support it.
- Req 3: Action: Confirm chatSend handler in daemon accepts and respects claude flag from IpcRequest.params.
- Req 3: 6. Cross-Requirement: Requirement 4 (Daemon Initialization) Prerequisite
- Req 3: Requirement 3 assumes daemon is already running. Requirement 4 must provide a mechanism to start the daemon automatically or guide the user. If the CLI tries to connect and fails, it should suggest insrc setup or
- Req 4: ### [FIXED] Refined Concerns
- Req 4: 1. Ollama Installation & Permissions
- Req 4: - detectOllama() may fail silently or return "not found"
- Req 4: - ACTION: OllamaValidator must distinguish:
- Req 4: - Not installed → suggest install URL
- Req 4: - No permission → suggest sudo or container workaround
- Req 4: - Installed but not running → suggest ollama serve
- Req 4: - RISK: Setup hangs if Ollama startup is slow (>30s)
- Req 4: 2. Model Download Timeouts & Interruption
- Req 4: - ensureAgentModel + ensureEmbeddingModel can be slow (5–30 min for large models)
- Req 4: - ACTION: ModelInstaller must support:
- Req 4: - Cancelable operations (SIGINT handling)
- Req 4: - Progress reporting every 5–10s
- Req 4: - Retry on transient network failures (max 3 attempts)
- Req 4: - Resume capability (check existing model)