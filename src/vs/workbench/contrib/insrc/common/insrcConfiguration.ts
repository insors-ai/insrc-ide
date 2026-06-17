/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../../../platform/registry/common/platform.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';

const configurationRegistry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);

/**
 * Insrc settings are registered as a tree of top-level categories so
 * the Settings UI renders them with proper nesting instead of one
 * flat list under "Extensions". Each `registerConfiguration` call
 * creates its own navigation node; IDs share a common prefix so
 * related sections group together.
 *
 * Because we're an IDE fork (not an extension), we deliberately omit
 * `extensionInfo` -- that promotes the tree to a first-class root
 * entry ("Insrc") instead of burying it under Extensions.
 */

const INSRC_ORDER = 100;

// ---------------------------------------------------------------------------
// Insrc -- connection / logging (parent node)
// ---------------------------------------------------------------------------

configurationRegistry.registerConfiguration({
	id: 'insrc',
	title: localize('insrc', 'Insrc'),
	type: 'object',
	order: INSRC_ORDER,
	properties: {
		'insrc.logLevel': {
			type: 'string',
			default: 'info',
			enum: ['debug', 'info', 'warn', 'error'],
			description: localize('insrc.logLevel', 'Daemon log level.'),
			scope: ConfigurationScope.MACHINE,
		},
	},
});

// Model / provider configuration is managed via the Model Providers
// pane (command `insrc.openModelProviders`), persisted in
// ~/.insrc/config.json, and lives outside VS Code settings.json so it
// can support live model-list fetches and keychain-backed API keys.

// ---------------------------------------------------------------------------
// Insrc > Permissions
// ---------------------------------------------------------------------------

configurationRegistry.registerConfiguration({
	id: 'insrc.permissions',
	title: localize('insrc.permissions.title', 'Insrc > Permissions'),
	type: 'object',
	order: INSRC_ORDER + 2,
	properties: {
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
	},
});

// ---------------------------------------------------------------------------
// Insrc > Daemon (install / update)
// ---------------------------------------------------------------------------

configurationRegistry.registerConfiguration({
	id: 'insrc.daemon',
	title: localize('insrc.daemon.title', 'Insrc > Daemon'),
	type: 'object',
	order: INSRC_ORDER + 3,
	properties: {
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
	},
});

// Routing mode is no longer user-configurable: the router is a flat
// config-driven lookup. See plans/multi-provider-models.md.

// ---------------------------------------------------------------------------
// Insrc > Tools (parent block; the historical `enabledCategories`
// whitelist was dropped -- per-action permission gates already
// authorise tool calls, and the lookup-time category gate was a
// recurring source of "tool registered but invisible" silent
// failures. Block kept for future per-tool subsystem settings.)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Insrc > Tools > Approval
// ---------------------------------------------------------------------------

configurationRegistry.registerConfiguration({
	id: 'insrc.tools.approval',
	title: localize('insrc.tools.approval.title', 'Insrc > Tools > Approval'),
	type: 'object',
	order: INSRC_ORDER + 6,
	properties: {
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
	},
});

// ---------------------------------------------------------------------------
// Insrc > Tools > Loop (LLM tool-call loop caps)
// ---------------------------------------------------------------------------

configurationRegistry.registerConfiguration({
	id: 'insrc.tools.loop',
	title: localize('insrc.tools.loop.title', 'Insrc > Tools > Loop'),
	type: 'object',
	order: INSRC_ORDER + 7,
	properties: {
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
	},
});

// ---------------------------------------------------------------------------
// Insrc > Tools > Output
// ---------------------------------------------------------------------------

configurationRegistry.registerConfiguration({
	id: 'insrc.tools.output',
	title: localize('insrc.tools.output.title', 'Insrc > Tools > Output'),
	type: 'object',
	order: INSRC_ORDER + 8,
	properties: {
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
	},
});

// ---------------------------------------------------------------------------
// Insrc > Tools > Shell (shell / detached runtime caps)
// ---------------------------------------------------------------------------

configurationRegistry.registerConfiguration({
	id: 'insrc.tools.shell',
	title: localize('insrc.tools.shell.title', 'Insrc > Tools > Shell'),
	type: 'object',
	order: INSRC_ORDER + 9,
	properties: {
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
	},
});

// ---------------------------------------------------------------------------
// Insrc > Tools > Web
// ---------------------------------------------------------------------------

configurationRegistry.registerConfiguration({
	id: 'insrc.tools.web',
	title: localize('insrc.tools.web.title', 'Insrc > Tools > Web'),
	type: 'object',
	order: INSRC_ORDER + 10,
	properties: {
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
	},
});

// ---------------------------------------------------------------------------
// Insrc > Tools > Destructive
// ---------------------------------------------------------------------------

configurationRegistry.registerConfiguration({
	id: 'insrc.tools.destructive',
	title: localize('insrc.tools.destructive.title', 'Insrc > Tools > Destructive'),
	type: 'object',
	order: INSRC_ORDER + 11,
	properties: {
		'insrc.tools.destructive.requireDoubleConfirm': {
			type: 'boolean',
			default: false,
			description: localize('insrc.tools.destructive.requireDoubleConfirm', 'Show an additional confirmation dialog for destructive tool calls (terminate, drop, recursive delete) even after the in-band confirmation token.'),
			scope: ConfigurationScope.MACHINE,
		},
	},
});

// ---------------------------------------------------------------------------
// Insrc > Tools > Notifications (keychain-backed defaults)
// ---------------------------------------------------------------------------

configurationRegistry.registerConfiguration({
	id: 'insrc.tools.notify',
	title: localize('insrc.tools.notify.title', 'Insrc > Tools > Notifications'),
	type: 'object',
	order: INSRC_ORDER + 12,
	properties: {
		'insrc.tools.notify.slack.defaultWebhookRef': {
			type: 'string',
			default: '',
			description: localize('insrc.tools.notify.slack.defaultWebhookRef', 'Keychain account name holding a default Slack webhook URL used by notify:slack when webhookUrl is omitted. Set the secret via the `insrc: Set Slack Webhook` command.'),
			scope: ConfigurationScope.MACHINE,
		},
		'insrc.tools.notify.teams.defaultWebhookRef': {
			type: 'string',
			default: '',
			description: localize('insrc.tools.notify.teams.defaultWebhookRef', 'Keychain account name holding a default Teams webhook URL.'),
			scope: ConfigurationScope.MACHINE,
		},
		'insrc.tools.notify.discord.defaultWebhookRef': {
			type: 'string',
			default: '',
			description: localize('insrc.tools.notify.discord.defaultWebhookRef', 'Keychain account name holding a default Discord webhook URL.'),
			scope: ConfigurationScope.MACHINE,
		},
		'insrc.tools.notify.email.smtpHost': {
			type: 'string',
			default: '',
			description: localize('insrc.tools.notify.email.smtpHost', 'Default SMTP host for notify:email. Per-call smtpHost still wins.'),
			scope: ConfigurationScope.MACHINE,
		},
		'insrc.tools.notify.email.smtpPort': {
			type: 'number',
			default: 587, minimum: 1, maximum: 65535,
			description: localize('insrc.tools.notify.email.smtpPort', 'Default SMTP port.'),
			scope: ConfigurationScope.MACHINE,
		},
		'insrc.tools.notify.email.smtpUserRef': {
			type: 'string',
			default: '',
			description: localize('insrc.tools.notify.email.smtpUserRef', 'Keychain account name holding the SMTP username.'),
			scope: ConfigurationScope.MACHINE,
		},
		'insrc.tools.notify.email.smtpPassRef': {
			type: 'string',
			default: '',
			description: localize('insrc.tools.notify.email.smtpPassRef', 'Keychain account name holding the SMTP password.'),
			scope: ConfigurationScope.MACHINE,
		},
		'insrc.tools.notify.email.fromAddress': {
			type: 'string',
			default: '',
			description: localize('insrc.tools.notify.email.fromAddress', 'Default From: address for notify:email.'),
			scope: ConfigurationScope.MACHINE,
		},
	},
});

// ---------------------------------------------------------------------------
// Insrc > Handoff (external coding agent integration)
// ---------------------------------------------------------------------------

configurationRegistry.registerConfiguration({
	id: 'insrc.handoff',
	title: localize('insrc.handoff.title', 'Insrc > Handoff'),
	type: 'object',
	order: INSRC_ORDER + 13,
	properties: {
		'insrc.handoff.preferredAgent': {
			type: 'string',
			default: 'auto',
			enum: ['auto', 'claude-code', 'codex'],
			enumDescriptions: [
				localize('insrc.handoff.preferredAgent.auto', 'Pick the agent that matches the active cloud provider: `claude-code` for Anthropic, `codex` for everything else.'),
				localize('insrc.handoff.preferredAgent.claude-code', 'Always use Claude Code for external-agent handoffs.'),
				localize('insrc.handoff.preferredAgent.codex', 'Always use Codex for external-agent handoffs.'),
			],
			description: localize('insrc.handoff.preferredAgent', 'Which external coding agent to spawn for handoffs. The Phase 4 router (`pickAgent`) reads this setting; `auto` defers to the active cloud provider. (plans/external-agent-integration.md Phase 4)'),
			scope: ConfigurationScope.MACHINE,
		},
	},
});

// ---------------------------------------------------------------------------
// Insrc > Memory (user-assertion classifier confidence dynamics)
//
// Settings for the memory + context system. See design/memory-context.html
// and plans/memory-context.md. The user-assertion classifier writes new
// preferences at `baseScore`; reinforcement saturates toward 1.0; refining /
// weakening / contradicting assertions decay the prior entry's score; entries
// below `noiseThreshold` are suppressed at retrieval (but kept in storage as
// audit trail).
// ---------------------------------------------------------------------------

configurationRegistry.registerConfiguration({
	id: 'insrc.memory',
	title: localize('insrc.memory.title', 'Insrc > Memory'),
	type: 'object',
	order: INSRC_ORDER + 14,
	properties: {
		'insrc.memory.assertionClassifier.autoAcceptThreshold': {
			type: 'number',
			default: 0.85, minimum: 0, maximum: 1,
			description: localize('insrc.memory.assertionClassifier.autoAcceptThreshold', 'Layer 2 classifier confidence above which an `accept` verdict auto-persists. Below it the user is asked to confirm. (memory-context G2)'),
			scope: ConfigurationScope.MACHINE,
		},
		'insrc.memory.assertions.baseScore': {
			type: 'number',
			default: 0.80, minimum: 0, maximum: 1,
			description: localize('insrc.memory.assertions.baseScore', 'Initial confidence assigned to a freshly captured user assertion. (memory-context G7)'),
			scope: ConfigurationScope.MACHINE,
		},
		'insrc.memory.assertions.reinforcementRate': {
			type: 'number',
			default: 0.50, minimum: 0, maximum: 1,
			description: localize('insrc.memory.assertions.reinforcementRate', 'Saturating bump applied on exact re-assertion: c = c + (1 - c) * rate. (memory-context G7)'),
			scope: ConfigurationScope.MACHINE,
		},
		'insrc.memory.assertions.refinementDecay': {
			type: 'number',
			default: 0.15, minimum: 0, maximum: 1,
			description: localize('insrc.memory.assertions.refinementDecay', 'Confidence decay applied to the old entry when a refining assertion supersedes it: c = c * (1 - rate). (memory-context G7)'),
			scope: ConfigurationScope.MACHINE,
		},
		'insrc.memory.assertions.weakeningDecay': {
			type: 'number',
			default: 0.40, minimum: 0, maximum: 1,
			description: localize('insrc.memory.assertions.weakeningDecay', 'Confidence decay applied to the old entry when a weakening assertion supersedes it. (memory-context G7)'),
			scope: ConfigurationScope.MACHINE,
		},
		'insrc.memory.assertions.contradictionDecay': {
			type: 'number',
			default: 0.65, minimum: 0, maximum: 1,
			description: localize('insrc.memory.assertions.contradictionDecay', 'Confidence decay applied to the old entry when a contradicting assertion supersedes it. (memory-context G7)'),
			scope: ConfigurationScope.MACHINE,
		},
		'insrc.memory.assertions.noiseThreshold': {
			type: 'number',
			default: 0.30, minimum: 0, maximum: 1,
			description: localize('insrc.memory.assertions.noiseThreshold', 'Entries with confidence below this threshold are suppressed at retrieval (but remain in storage). (memory-context G7)'),
			scope: ConfigurationScope.MACHINE,
		},
	},
});
