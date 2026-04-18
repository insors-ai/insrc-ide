/**
 * GCP tools -- registration aggregator.
 */

import { registerTool } from '../../../registry.js';
import { gcpStorageLsTool, gcpStorageCpTool, gcpStorageRmTool } from './storage.js';
import { gcpComputeListTool, gcpComputeStartTool, gcpComputeStopTool, gcpComputeDeleteTool } from './compute.js';
import { gcpIamWhoAmITool } from './iam.js';
import { gcpFunctionsListTool, gcpFunctionsCallTool } from './functions.js';

export function registerGcpTools(): void {
  registerTool(gcpStorageLsTool);
  registerTool(gcpStorageCpTool);
  registerTool(gcpStorageRmTool);
  registerTool(gcpComputeListTool);
  registerTool(gcpComputeStartTool);
  registerTool(gcpComputeStopTool);
  registerTool(gcpComputeDeleteTool);
  registerTool(gcpIamWhoAmITool);
  registerTool(gcpFunctionsListTool);
  registerTool(gcpFunctionsCallTool);
}
