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
	},
});
