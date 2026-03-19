/**
 * Setup wizard — multi-step webview for first-time configuration.
 *
 * Steps:
 *  1. System detection + model recommendation (system.recommend RPC)
 *  2. Ollama optimizations (from recommendation.ollamaOptimizations)
 *  3. Model pull (ollama pull via shell)
 *  4. API keys (stored in OS keychain via keys.set RPC)
 *  5. Done
 *
 * Auto-triggers on first activation when Ollama or models are missing.
 * Re-openable via insrc.openSetupWizard command.
 */

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import type { RpcClient } from '../daemon/rpc';

export class SetupWizard {
  private panel: vscode.WebviewPanel | null = null;
  private recommendationData: Record<string, unknown> | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly rpc: RpcClient,
    private readonly outputChannel: vscode.OutputChannel,
  ) {}

  /** Check if setup is needed (no Ollama, missing models, no config). */
  async isSetupNeeded(): Promise<boolean> {
    try {
      const result = await this.rpc.call<{
        system: { ollama: { available: boolean; models: unknown[] } };
        recommendation: { coder: { pull: boolean }; embedding: { pull: boolean } };
      }>('system.recommend');
      // Setup needed if: Ollama not available, or recommended models not installed
      if (!result.system.ollama.available) return true;
      if (result.recommendation.coder.pull || result.recommendation.embedding.pull) return true;
      return false;
    } catch {
      // Daemon not running — can't check, don't auto-trigger
      return false;
    }
  }

  /** Open the wizard. */
  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'insrc.setupWizard',
      'insrc Setup',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      },
    );

    const iconPath = vscode.Uri.joinPath(this.extensionUri, 'assets', 'icon-insrc.svg');
    this.panel.iconPath = iconPath;
    this.panel.webview.html = this.getHtml();

    this.panel.webview.onDidReceiveMessage(async (msg: {
      type: string;
      anthropic?: string;
      brave?: string;
    }) => {
      switch (msg.type) {
        case 'detect':
          await this.handleDetect();
          break;
        case 'pullModels':
          await this.handlePullModels();
          break;
        case 'saveKeys':
          await this.handleSaveKeys(msg.anthropic, msg.brave);
          break;
        case 'applyConfig':
          await this.handleApplyConfig();
          break;
        case 'openChat':
          vscode.commands.executeCommand('insrc.openPanel');
          this.panel?.dispose();
          break;
      }
    });

    this.panel.onDidDispose(() => {
      this.panel = null;
    });
  }

  // ---------------------------------------------------------------------------
  // Message handlers
  // ---------------------------------------------------------------------------

  private async handleDetect(): Promise<void> {
    try {
      const result = await this.rpc.call<Record<string, unknown>>('system.recommend');
      this.recommendationData = result;
      this.post({ type: 'systemInfo', ...result });
    } catch (err) {
      // Fallback: run detection locally (daemon may not be running)
      this.log(`RPC detection failed, running locally: ${err}`);
      try {
        const output = execSync('npx tsx src/cli/index.ts setup --recommend', {
          cwd: path.resolve(this.extensionUri.fsPath, '..'),
          timeout: 30000,
          encoding: 'utf-8',
        });
        this.post({
          type: 'systemInfo',
          system: { cpu: {}, ram: {}, gpu: null, os: {}, ollama: { available: false, models: [] } },
          recommendation: { coder: { model: '?', pull: true }, embedding: { model: '?', pull: true }, context: { shape: '16k' }, tier: 'unknown', ollamaOptimizations: [] },
          error: output,
        });
      } catch {
        this.post({
          type: 'systemInfo',
          system: { cpu: {}, ram: {}, gpu: null, os: {}, ollama: { available: false, models: [] } },
          recommendation: { coder: { model: '?', pull: true }, embedding: { model: '?', pull: true }, context: { shape: '16k' }, tier: 'unknown', ollamaOptimizations: [] },
        });
      }
    }
  }

  private async handlePullModels(): Promise<void> {
    if (!this.recommendationData) return;

    const rec = this.recommendationData['recommendation'] as {
      coder: { model: string; pull: boolean };
      embedding: { model: string; pull: boolean };
    };

    const toPull: string[] = [];
    if (rec.coder.pull) toPull.push(rec.coder.model);
    if (rec.embedding.pull) toPull.push(rec.embedding.model);

    for (const model of toPull) {
      this.log(`pulling model: ${model}`);
      this.post({ type: 'pullProgress', model, status: 'pulling', pct: 0 });

      try {
        await this.pullModel(model);
        this.post({ type: 'pullProgress', model, status: 'done', pct: 100 });
      } catch (err) {
        this.log(`pull failed: ${model}: ${err}`);
        this.post({ type: 'pullProgress', model, status: 'error', pct: 0 });
      }
    }

    this.post({ type: 'pullDone' });
  }

  private pullModel(model: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('ollama', ['pull', model], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let lastPct = 0;
      const handleData = (data: Buffer): void => {
        const text = data.toString();
        // Parse progress from ollama pull output
        const pctMatch = text.match(/(\d+)%/);
        if (pctMatch) {
          const pct = parseInt(pctMatch[1]!, 10);
          if (pct > lastPct) {
            lastPct = pct;
            this.post({ type: 'pullProgress', model, status: 'pulling', pct });
          }
        }
      };

      child.stdout?.on('data', handleData);
      child.stderr?.on('data', handleData);

      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ollama pull exited with code ${code}`));
      });

      child.on('error', reject);
    });
  }

  private async handleSaveKeys(anthropic?: string, brave?: string): Promise<void> {
    try {
      if (anthropic) {
        await this.rpc.call('keys.set', { name: 'anthropic', value: anthropic });
        this.log('anthropic key saved to keychain');
      }
      if (brave) {
        await this.rpc.call('keys.set', { name: 'brave', value: brave });
        this.log('brave key saved to keychain');
      }
    } catch (err) {
      this.log(`save keys error: ${err}`);
      vscode.window.showErrorMessage(`Failed to save keys: ${err}`);
    }
  }

  private async handleApplyConfig(): Promise<void> {
    if (!this.recommendationData) return;

    const config = this.recommendationData['config'] as Record<string, unknown>;
    if (!config) return;

    try {
      // Write config via RPC or directly
      await this.rpc.call('config.write', { config });
      this.log('config applied');
    } catch {
      // Fallback: write directly to file
      try {
        const configPath = path.join(process.env['HOME'] ?? '', '.insrc', 'config.json');
        let existing: Record<string, unknown> = {};
        try {
          existing = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
        } catch { /* start fresh */ }
        const merged = { ...config, ...existing, models: { ...(config['models'] as Record<string, unknown>), ...((existing['models'] ?? {}) as Record<string, unknown>) } };
        fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n');
        this.log('config written directly to file');
      } catch (err) {
        this.log(`config write error: ${err}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private post(msg: Record<string, unknown>): void {
    this.panel?.webview.postMessage(msg);
  }

  private log(msg: string): void {
    this.outputChannel.appendLine(`[wizard] ${msg}`);
  }

  private getHtml(): string {
    const htmlPath = path.join(this.extensionUri.fsPath, 'src', 'webview', 'wizard.html');
    try {
      return fs.readFileSync(htmlPath, 'utf-8');
    } catch {
      const distPath = path.join(this.extensionUri.fsPath, 'dist', 'webview', 'wizard.html');
      try {
        return fs.readFileSync(distPath, 'utf-8');
      } catch {
        return '<html><body><p>Setup wizard failed to load.</p></body></html>';
      }
    }
  }
}
