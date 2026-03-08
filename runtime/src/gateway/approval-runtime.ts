import {
  buildDefaultApprovalRules,
  type ApprovalRule,
} from './approvals.js';
import { buildMCPApprovalRules } from '../policy/mcp-governance.js';
import type {
  GatewayApprovalConfig,
  GatewayMCPServerConfig,
} from './types.js';

export function approvalsEnabled(
  approvals: GatewayApprovalConfig | undefined,
): boolean {
  return approvals?.enabled === true;
}

export function resolveGatewayApprovalRules(params: {
  approvals?: GatewayApprovalConfig;
  mcpServers?: readonly GatewayMCPServerConfig[];
}): ApprovalRule[] {
  if (!approvalsEnabled(params.approvals)) {
    return [];
  }

  return [
    ...buildDefaultApprovalRules({
      gateDesktopAutomation: params.approvals?.gateDesktopAutomation === true,
    }),
    ...buildMCPApprovalRules(params.mcpServers),
  ];
}
