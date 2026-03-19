/**
 * CLI commands for secure key management.
 *
 * Keys are stored in the OS keychain via keytar.
 * Commands: insrc keys set|get|delete|list
 */

import type { Command } from 'commander';
import { createInterface } from 'node:readline';
import { getKey, setKey, deleteKey, listKeys, maskKey } from '../../shared/keystore.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('cli');

export function registerKeysCommands(program: Command): void {
  const keys = program
    .command('keys')
    .description('Manage API keys and secrets (stored in OS keychain)');

  keys
    .command('set <name> [value]')
    .description('Store a key in the OS keychain (prompts if value omitted)')
    .action(async (name: string, value?: string) => {
      const keyValue = value ?? await promptHidden(`Enter value for '${name}': `);
      if (!keyValue) {
        log.error('No value provided');
        return;
      }
      await setKey(name, keyValue);
      log.info(`key '${name}' saved to OS keychain`);
    });

  keys
    .command('get <name>')
    .description('Show if a key exists (masked value)')
    .action(async (name: string) => {
      const value = await getKey(name);
      if (value) {
        log.info(`${name}: ${maskKey(value)}`);
      } else {
        log.info(`${name}: not set`);
      }
    });

  keys
    .command('delete <name>')
    .description('Remove a key from the OS keychain')
    .action(async (name: string) => {
      await deleteKey(name);
      log.info(`key '${name}' deleted`);
    });

  keys
    .command('list')
    .description('List all stored key names with masked values')
    .action(async () => {
      const names = await listKeys();
      if (names.length === 0) {
        log.info('no keys stored');
        return;
      }
      for (const name of names) {
        const value = await getKey(name);
        log.info(`  ${name}: ${value ? maskKey(value) : '(empty)'}`);
      }
    });
}

/**
 * Prompt for hidden input (password-style, no echo).
 */
function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Disable echo by writing directly
    process.stdout.write(prompt);

    let input = '';
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }

    stdin.resume();
    stdin.on('data', function handler(ch: Buffer) {
      const char = ch.toString('utf8');
      if (char === '\n' || char === '\r') {
        stdin.removeListener('data', handler);
        if (stdin.isTTY && wasRaw !== undefined) {
          stdin.setRawMode(wasRaw);
        }
        process.stdout.write('\n');
        rl.close();
        resolve(input);
      } else if (char === '\u0003') {
        // Ctrl+C
        rl.close();
        process.exit(0);
      } else if (char === '\u007F') {
        // Backspace
        input = input.slice(0, -1);
      } else {
        input += char;
      }
    });
  });
}
