/**
 * AWS tools -- registration aggregator.
 */

import { registerTool } from '../../../registry.js';
import { awsS3LsTool, awsS3CpTool, awsS3RmTool, awsS3SyncTool } from './s3.js';
import { awsEc2ListTool, awsEc2StartTool, awsEc2StopTool, awsEc2TerminateTool } from './ec2.js';
import { awsStsWhoAmITool } from './sts.js';
import { awsLambdaInvokeTool } from './lambda.js';

export function registerAwsTools(): void {
  registerTool(awsS3LsTool);
  registerTool(awsS3CpTool);
  registerTool(awsS3RmTool);
  registerTool(awsS3SyncTool);
  registerTool(awsEc2ListTool);
  registerTool(awsEc2StartTool);
  registerTool(awsEc2StopTool);
  registerTool(awsEc2TerminateTool);
  registerTool(awsStsWhoAmITool);
  registerTool(awsLambdaInvokeTool);
}
