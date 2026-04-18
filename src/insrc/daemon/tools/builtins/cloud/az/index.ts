/**
 * Azure tools -- registration aggregator.
 */

import { registerTool } from '../../../registry.js';
import { azAccountShowTool } from './account.js';
import { azStorageBlobLsTool, azStorageBlobCpTool, azStorageBlobRmTool } from './storage.js';
import { azVmListTool, azVmStartTool, azVmStopTool, azVmDeleteTool } from './vm.js';
import { azKeyvaultSecretShowTool, azKeyvaultSecretSetTool } from './keyvault.js';

export function registerAzTools(): void {
  registerTool(azAccountShowTool);
  registerTool(azStorageBlobLsTool);
  registerTool(azStorageBlobCpTool);
  registerTool(azStorageBlobRmTool);
  registerTool(azVmListTool);
  registerTool(azVmStartTool);
  registerTool(azVmStopTool);
  registerTool(azVmDeleteTool);
  registerTool(azKeyvaultSecretShowTool);
  registerTool(azKeyvaultSecretSetTool);
}
