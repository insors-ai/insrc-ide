/**
 * Settings panel — WebviewPanel for editing insrc configuration.
 *
 * Sections: Ollama, Models, Claude Tiers, Context Window, API Keys,
 * Permissions & Routing, Agent Step Overrides.
 *
 * Reads from: config.show RPC (daemon) or ~/.insrc/config.json
 * Writes to:  config.json (models, routing, permissions)
 *             OS keychain (API keys via keys.set RPC)
 * Validates:  Ollama ping, model availability
 */

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RpcClient } from '../daemon/rpc';

export class SettingsPanel {
  private static instance: SettingsPanel | null = null;
  private panel: vscode.WebviewPanel;
  private disposed = false;

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly rpc: RpcClient,
    private readonly outputChannel: vscode.OutputChannel,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'insrc.settings',
      'insrc Settings',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      },
    );

    const iconPath = vscode.Uri.joinPath(extensionUri, 'assets', 'icon-insrc.svg');
    this.panel.iconPath = iconPath;
    this.panel.webview.html = this.getHtml();

    this.panel.webview.onDidReceiveMessage(async (msg: {
      type: string;
      config?: Record<string, unknown>;
      keys?: Record<string, string>;
    }) => {
      switch (msg.type) {
        case 'loadConfig':
          await this.loadConfig();
          break;
        case 'loadModels':
          await this.loadModels();
          break;
        case 'loadKeys':
          await this.loadKeys();
          break;
        case 'save':
          await this.save(msg.config, msg.keys);
          break;
        case 'redetect':
          await this.redetect();
          break;
        case 'reset':
          await this.resetToRecommended();
          break;
        case 'configSearch':
          await this.configSearch((msg as Record<string, unknown>)['query'] as string);
          break;
        case 'configBrowse':
          await this.configBrowse();
          break;
        case 'configSelect':
          await this.configSelect((msg as Record<string, unknown>)['id'] as string);
          break;
        case 'configReindex':
          await this.configReindex();
          break;
        case 'configEdit':
          await this.configEdit();
          break;
        case 'loadDaemonInfo':
          await this.loadDaemonInfo();
          break;
        case 'daemonCheckUpdate':
          await this.daemonCheckUpdate();
          break;
        case 'daemonUpdate':
          await this.daemonUpdate();
          break;
        case 'daemonRestart':
          vscode.commands.executeCommand('insrc.restartDaemon');
          break;
        case 'daemonForceRestart':
          vscode.commands.executeCommand('insrc.forceRestartDaemon');
          break;
      }
    });

    this.panel.onDidDispose(() => {
      this.disposed = true;
      SettingsPanel.instance = null;
    });
  }

  static show(
    extensionUri: vscode.Uri,
    rpc: RpcClient,
    outputChannel: vscode.OutputChannel,
  ): SettingsPanel {
    if (SettingsPanel.instance && !SettingsPanel.instance.disposed) {
      SettingsPanel.instance.panel.reveal();
      return SettingsPanel.instance;
    }
    SettingsPanel.instance = new SettingsPanel(extensionUri, rpc, outputChannel);
    return SettingsPanel.instance;
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  private async loadConfig(): Promise<void> {
    try {
      const config = await this.rpc.call<Record<string, unknown>>('config.show');
      this.post({ type: 'setConfig', config });
    } catch {
      // Fallback: read file directly
      try {
        const configPath = path.join(process.env['HOME'] ?? '', '.insrc', 'config.json');
        const raw = fs.readFileSync(configPath, 'utf-8');
        this.post({ type: 'setConfig', config: JSON.parse(raw) as Record<string, unknown> });
      } catch {
        this.post({ type: 'setConfig', config: {} });
      }
    }
  }

  private async loadModels(): Promise<void> {
    try {
      const info = await this.rpc.call<{
        system: { ollama: { models: Array<{ name: string; parameterSize: string }> } };
      }>('system.recommend');
      this.post({ type: 'setModels', models: info.system.ollama.models });
    } catch {
      // Fallback: direct Ollama API
      try {
        const { execSync } = await import('node:child_process');
        const tagsJson = execSync('curl -s http://localhost:11434/api/tags', {
          timeout: 5000, encoding: 'utf-8',
        });
        const tags = JSON.parse(tagsJson) as { models?: Array<{ name: string; details?: { parameter_size?: string } }> };
        const models = (tags.models ?? []).map(m => ({
          name: m.name,
          parameterSize: m.details?.parameter_size ?? '',
        }));
        this.post({ type: 'setModels', models });
      } catch {
        this.post({ type: 'setModels', models: [] });
      }
    }
  }

  private async loadKeys(): Promise<void> {
    try {
      const keys = await this.rpc.call<Array<{ name: string; masked: string }>>('keys.list');
      this.post({ type: 'setKeys', keys });
    } catch {
      this.post({ type: 'setKeys', keys: [] });
    }
  }

  private async save(
    config?: Record<string, unknown>,
    keys?: Record<string, string>,
  ): Promise<void> {
    // Save config to file
    if (config) {
      try {
        const configPath = path.join(process.env['HOME'] ?? '', '.insrc', 'config.json');
        let existing: Record<string, unknown> = {};
        try {
          existing = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
        } catch { /* start fresh */ }

        // Merge: new config overwrites, but preserve keys section (handled separately)
        const merged = { ...existing, ...config };
        // Don't overwrite keys in config.json — they're in keychain
        delete (merged as Record<string, unknown>)['keys'];

        fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n');
        this.log('config saved');
      } catch (err) {
        this.log(`config save error: ${err}`);
        vscode.window.showErrorMessage(`Failed to save config: ${err}`);
        return;
      }
    }

    // Save keys to keychain
    if (keys) {
      for (const [name, value] of Object.entries(keys)) {
        if (value) {
          try {
            await this.rpc.call('keys.set', { name, value });
            this.log(`key saved: ${name}`);
          } catch (err) {
            this.log(`key save error: ${name}: ${err}`);
          }
        }
      }
    }

    // Hot-reload config into active daemon sessions
    try {
      const result = await this.rpc.call<{ reloaded: number }>('config.reload');
      this.log(`config reloaded: ${result.reloaded} session(s) updated`);
    } catch (err) {
      this.log(`config reload failed (daemon may need restart): ${err}`);
    }

    this.post({ type: 'saved' });
  }

  private async redetect(): Promise<void> {
    try {
      const result = await this.rpc.call<Record<string, unknown>>('system.recommend');
      const config = result['config'] as Record<string, unknown>;
      if (config) {
        this.post({ type: 'setRecommendation', config });
      }
    } catch (err) {
      this.log(`redetect error: ${err}`);
    }
  }

  private async resetToRecommended(): Promise<void> {
    try {
      const result = await this.rpc.call<Record<string, unknown>>('system.recommend');
      const config = result['config'] as Record<string, unknown>;
      if (config) {
        this.post({ type: 'setConfig', config });
        vscode.window.showInformationMessage('Settings reset to hardware-recommended values');
      }
    } catch (err) {
      this.log(`reset error: ${err}`);
      vscode.window.showErrorMessage(`Failed to get recommendations: ${err}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Config store (Segment 15 — integrated into settings)
  // ---------------------------------------------------------------------------

  private selectedConfigEntry: Record<string, unknown> | null = null;

  private async configSearch(query: string): Promise<void> {
    try {
      const entries = await this.rpc.call<Array<Record<string, unknown>>>('config.search', {
        query,
        limit: 20,
      });
      this.post({ type: 'setConfigEntries', entries });
    } catch (err) {
      this.log(`config search error: ${err}`);
      this.post({ type: 'setConfigEntries', entries: [] });
    }
  }

  private async configBrowse(): Promise<void> {
    try {
      const entries = await this.rpc.call<Array<Record<string, unknown>>>('config.list', {});
      this.post({ type: 'setConfigEntries', entries });
    } catch (err) {
      this.log(`config browse error: ${err}`);
      this.post({ type: 'setConfigEntries', entries: [] });
    }
  }

  private async configSelect(id: string): Promise<void> {
    try {
      const entries = await this.rpc.call<Array<Record<string, unknown>>>('config.list', {});
      const entry = entries.find(e => (e['id'] as string) === id);
      if (entry) {
        this.selectedConfigEntry = entry;
        this.post({ type: 'setConfigDetail', entry });
      }
    } catch (err) {
      this.log(`config select error: ${err}`);
    }
  }

  private async configReindex(): Promise<void> {
    try {
      await this.rpc.call('config.reindex', { scope: { kind: 'global' } });
      this.post({ type: 'configReindexed' });
      this.log('config store reindexed');
    } catch (err) {
      this.log(`config reindex error: ${err}`);
    }
  }

  private async configEdit(): Promise<void> {
    if (!this.selectedConfigEntry) return;
    const filePath = this.selectedConfigEntry['filePath'] as string | undefined;
    if (filePath) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(doc);
    } else {
      vscode.window.showInformationMessage('This entry has no source file to edit.');
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Daemon management
  // ---------------------------------------------------------------------------

  async loadDaemonInfo(): Promise<void> {
    try {
      await this.rpc.call('daemon.status');
      const homedir = require('node:os').homedir();
      const daemonDir = require('node:path').join(homedir, '.insrc', 'daemon');
      const configPath = require('node:path').join(homedir, '.insrc', 'config.json');
      let installPath = daemonDir;
      try {
        const config = JSON.parse(require('node:fs').readFileSync(configPath, 'utf-8'));
        if (config.installPath) installPath = config.installPath;
      } catch { /* use default */ }

      let version = '—';
      try {
        const pkg = JSON.parse(require('node:fs').readFileSync(
          require('node:path').join(installPath, 'package.json'), 'utf-8'));
        version = pkg.version ?? '—';
      } catch { /* ignore */ }

      this.post({ type: 'setDaemonInfo', info: { running: true, version, path: installPath } });
    } catch {
      this.post({ type: 'setDaemonInfo', info: { running: false, version: '—', path: '—' } });
    }
  }

  private async daemonCheckUpdate(): Promise<void> {
    this.post({ type: 'daemonUpdateResult', message: 'Checking for updates...', success: true });
    try {
      const daemonDir = require('node:path').join(require('node:os').homedir(), '.insrc', 'daemon');
      const { execSync } = require('node:child_process');
      const output = execSync('git fetch --dry-run 2>&1', { cwd: daemonDir, timeout: 15000 }).toString();
      if (output.trim().length > 0) {
        this.post({ type: 'daemonUpdateResult', message: 'Update available! Click "Update Daemon" to install.', success: true });
      } else {
        this.post({ type: 'daemonUpdateResult', message: 'Daemon is up to date.', success: true });
      }
    } catch (err) {
      this.post({ type: 'daemonUpdateResult', message: `Check failed: ${err}`, success: false });
    }
  }

  private async daemonUpdate(): Promise<void> {
    this.post({ type: 'daemonUpdateResult', message: 'Updating...', success: true });
    try {
      const daemonDir = require('node:path').join(require('node:os').homedir(), '.insrc', 'daemon');
      const { execSync } = require('node:child_process');
      execSync('git pull --ff-only', { cwd: daemonDir, timeout: 30000 });
      execSync('npm install --legacy-peer-deps', { cwd: daemonDir, timeout: 120000 });
      execSync('npm run build', { cwd: daemonDir, timeout: 60000 });
      this.post({ type: 'daemonUpdateResult', message: 'Updated! Restart the daemon to apply.', success: true });
    } catch (err) {
      this.post({ type: 'daemonUpdateResult', message: `Update failed: ${err}`, success: false });
    }
  }

  private post(msg: Record<string, unknown>): void {
    if (!this.disposed) this.panel.webview.postMessage(msg);
  }

  private log(msg: string): void {
    this.outputChannel.appendLine(`[settings] ${msg}`);
  }

  private getHtml(): string {
    const htmlPath = path.join(this.extensionUri.fsPath, 'src', 'webview', 'settings.html');
    try {
      return fs.readFileSync(htmlPath, 'utf-8');
    } catch {
      const distPath = path.join(this.extensionUri.fsPath, 'dist', 'webview', 'settings.html');
      try {
        return fs.readFileSync(distPath, 'utf-8');
      } catch {
        return '<html><body><p>Settings panel failed to load.</p></body></html>';
      }
    }
  }
}
