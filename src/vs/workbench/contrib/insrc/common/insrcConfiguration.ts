/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../../../platform/registry/common/platform.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';

const configurationRegistry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);

configurationRegistry.registerConfiguration({
	id: 'insrc',
	title: localize('insrc', 'insrc'),
	type: 'object',
	order: 100,
	extensionInfo: {
		id: 'insrc',
		displayName: 'insrc',
	},
	properties: {
		// -- Connection --
		'insrc.ollama.host': {
			type: 'string',
			default: 'http://localhost:11434',
			description: localize('insrc.ollama.host', 'Ollama server URL.'),
			scope: ConfigurationScope.MACHINE,
		},
		'insrc.logLevel': {
			type: 'string',
			default: 'info',
			enum: ['debug', 'info', 'warn', 'error'],
			description: localize('insrc.logLevel', 'Daemon log level.'),
			scope: ConfigurationScope.MACHINE,
		},

		// -- Models --
		'insrc.models.local': {
			type: 'string',
			default: 'qwen3-coder:latest',
			description: localize('insrc.models.local', 'Local LLM model name (Ollama).'),
			scope: ConfigurationScope.MACHINE,
		},
		'insrc.models.embedding': {
			type: 'string',
			default: 'qwen3-embedding:0.6b',
			description: localize('insrc.models.embedding', 'Embedding model name (Ollama).'),
			scope: ConfigurationScope.MACHINE,
		},
		'insrc.models.embeddingDim': {
			type: 'number',
			default: 2048,
			description: localize('insrc.models.embeddingDim', 'Embedding vector dimensions.'),
			scope: ConfigurationScope.MACHINE,
		},

		// -- Claude tiers --
		'insrc.models.tiers.fast': {
			type: 'string',
			default: 'claude-haiku-4-5',
			description: localize('insrc.models.tiers.fast', 'Claude model for fast tier (classification, simple tasks).'),
			scope: ConfigurationScope.MACHINE,
		},
		'insrc.models.tiers.standard': {
			type: 'string',
			default: 'claude-sonnet-4-5',
			description: localize('insrc.models.tiers.standard', 'Claude model for standard tier (code generation).'),
			scope: ConfigurationScope.MACHINE,
		},
		'insrc.models.tiers.powerful': {
			type: 'string',
			default: 'claude-sonnet-4-6',
			description: localize('insrc.models.tiers.powerful', 'Claude model for powerful tier (architecture, validation).'),
			scope: ConfigurationScope.MACHINE,
		},

		// -- Context budgets --
		'insrc.models.context.local': {
			type: 'number',
			default: 16384,
			description: localize('insrc.models.context.local', 'Context window size for local model (tokens).'),
			scope: ConfigurationScope.MACHINE,
		},
		'insrc.models.context.localMaxOutput': {
			type: 'number',
			default: 8192,
			description: localize('insrc.models.context.localMaxOutput', 'Max output tokens for local model.'),
			scope: ConfigurationScope.MACHINE,
		},
		'insrc.models.context.claude': {
			type: 'number',
			default: 200000,
			description: localize('insrc.models.context.claude', 'Context window size for Claude (tokens).'),
			scope: ConfigurationScope.MACHINE,
		},
		'insrc.models.context.claudeMaxOutput': {
			type: 'number',
			default: 8192,
			description: localize('insrc.models.context.claudeMaxOutput', 'Max output tokens for Claude.'),
			scope: ConfigurationScope.MACHINE,
		},

		// -- Permissions --
		'insrc.permissions.mode': {
			type: 'string',
			default: 'validate',
			enum: ['validate', 'auto-accept'],
			enumDescriptions: [
				localize('insrc.permissions.validate', 'Agent asks before executing commands or writing files.'),
				localize('insrc.permissions.autoAccept', 'Agent executes without confirmation (use with caution).'),
			],
			description: localize('insrc.permissions.mode', 'Permission mode for agent actions.'),
			scope: ConfigurationScope.MACHINE,
		},

		// -- Daemon install/update --
		'insrc.daemon.autoUpdate': {
			type: 'string',
			default: 'onStartup',
			enum: ['onStartup', 'never'],
			enumDescriptions: [
				localize('insrc.daemon.autoUpdate.onStartup', 'Check for daemon updates each time the IDE starts.'),
				localize('insrc.daemon.autoUpdate.never', 'Never check for daemon updates (manual via command only).'),
			],
			description: localize('insrc.daemon.autoUpdate', 'When to check the daemon repo for updates.'),
			scope: ConfigurationScope.MACHINE,
		},
		'insrc.daemon.repoUrl': {
			type: 'string',
			default: 'https://github.com/insors-ai/insrc-ide.git',
			description: localize('insrc.daemon.repoUrl', 'Git URL to clone the daemon source from.'),
			scope: ConfigurationScope.MACHINE,
		},
		'insrc.daemon.repoBranch': {
			type: 'string',
			default: 'release/1.96',
			description: localize('insrc.daemon.repoBranch', 'Branch of the daemon repo to clone and track.'),
			scope: ConfigurationScope.MACHINE,
		},

		// -- Routing --
		'insrc.routing.mode': {
			type: 'string',
			default: 'static',
			enum: ['static', 'auto'],
			enumDescriptions: [
				localize('insrc.routing.static', 'Use per-step provider bindings from config.'),
				localize('insrc.routing.auto', 'Smart router selects provider based on task complexity.'),
			],
			description: localize('insrc.routing.mode', 'LLM routing mode.'),
			scope: ConfigurationScope.MACHINE,
		},

		// -- Tools: category gate --
		'insrc.tools.enabledCategories': {
			type: 'array',
			items: { type: 'string' },
			default: [
				'file', 'shell', 'search', 'git', 'gh',
				'ssh', 'http', 'k8s', 'cloud', 'diff',
				'notify', 'test', 'pkg', 'web', 'graph', 'plan',
			],
			description: localize('insrc.tools.enabledCategories', 'Whitelist of tool categories the agent can invoke. Tools outside this list are unregistered at daemon startup. Use to restrict the agent in compliance-sensitive projects.'),
			scope: ConfigurationScope.MACHINE,
		},

		// -- Tools: approval gate UX --
		'insrc.tools.approval.defaultAction': {
			type: 'string',
			default: 'skip',
			enum: ['approve', 'skip'],
			enumDescriptions: [
				localize('insrc.tools.approval.defaultAction.approve', 'Auto-approve when the gate times out (risky).'),
				localize('insrc.tools.approval.defaultAction.skip', 'Auto-skip when the gate times out (safe default).'),
			],
			description: localize('insrc.tools.approval.defaultAction', 'Action used when an approval gate is dismissed without an explicit response.'),
			scope: ConfigurationScope.MACHINE,
		},
		'insrc.tools.approval.maxEditRounds': {
			type: 'number',
			default: 5, minimum: 1, maximum: 20,
			description: localize('insrc.tools.approval.maxEditRounds', 'How many times the user can edit a tool\'s input before the executor gives up.'),
			scope: ConfigurationScope.MACHINE,
		},
		'insrc.tools.approval.showStructuredDiff': {
			type: 'boolean',
			default: true,
			description: localize('insrc.tools.approval.showStructuredDiff', 'Show rendered diff/command previews in the gate. Disable for pure-text previews.'),
			scope: ConfigurationScope.MACHINE,
		},

		// -- Tools: LLM tool-call loop --
		'insrc.tools.loop.maxIterations': {
			type: 'number',
			default: 25, minimum: 1, maximum: 200,
			description: localize('insrc.tools.loop.maxIterations', 'Maximum tool-call iterations per agent turn before the loop gives up.'),
			scope: ConfigurationScope.MACHINE,
		},
		'insrc.tools.loop.maxNudges': {
			type: 'number',
			default: 3, minimum: 0, maximum: 10,
			description: localize('insrc.tools.loop.maxNudges', 'How many times the loop re-prompts the LLM if it described a tool action without calling one.'),
			scope: ConfigurationScope.MACHINE,
		},

		// -- Tools: output capture --
		'insrc.tools.output.inlineMaxChars': {
			type: 'number',
			default: 12000, minimum: 1024, maximum: 1000000,
			description: localize('insrc.tools.output.inlineMaxChars', 'Tool outputs under this many characters are returned inline. Larger outputs spill to a temp file and get SmartRead-chunked.'),
			scope: ConfigurationScope.MACHINE,
		},
		'insrc.tools.output.retainSpills': {
			type: 'boolean',
			default: false,
			description: localize('insrc.tools.output.retainSpills', 'Keep tool-output spill files in /tmp/.insrc/tool-output after the session closes.'),
			scope: ConfigurationScope.MACHINE,
		},

		// -- Tools: shell / detached runtime caps --
		'insrc.tools.shell.defaultTimeoutMs': {
			type: 'number',
			default: 120000, minimum: 1000,
			description: localize('insrc.tools.shell.defaultTimeoutMs', 'Default timeout for one-shot shell:exec calls (ms). Per-call timeoutMs still wins.'),
			scope: ConfigurationScope.MACHINE,
		},
		'insrc.tools.shell.detachedMaxRuntimeMs': {
			type: 'number',
			default: 1800000, minimum: 1000,
			description: localize('insrc.tools.shell.detachedMaxRuntimeMs', 'Hard cap for streaming tools (shell:exec-detached, ssh:exec-detached, k8s:logs follow, k8s:port-forward).'),
			scope: ConfigurationScope.MACHINE,
		},

		// -- Tools: web:search secret source --
		'insrc.tools.web.braveApiKeySource': {
			type: 'string',
			default: 'env',
			enum: ['env', 'keychain'],
			enumDescriptions: [
				localize('insrc.tools.web.braveApiKeySource.env', 'Read BRAVE_API_KEY from the daemon process environment.'),
				localize('insrc.tools.web.braveApiKeySource.keychain', 'Read the key from the IDE secret store (set via the `insrc: Set Brave API Key` command).'),
			],
			description: localize('insrc.tools.web.braveApiKeySource', 'Where web:search looks for the Brave API key.'),
			scope: ConfigurationScope.MACHINE,
		},

		// -- Tools: destructive-op double-confirm --
		'insrc.tools.destructive.requireDoubleConfirm': {
			type: 'boolean',
			default: false,
			description: localize('insrc.tools.destructive.requireDoubleConfirm', 'Show an additional confirmation dialog for destructive tool calls (terminate, drop, recursive delete) even after the in-band confirmation token.'),
			scope: ConfigurationScope.MACHINE,
		},
	},
});
