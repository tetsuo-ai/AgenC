import { describe, expect, it } from 'vitest';

import {
  approvalsEnabled,
  resolveGatewayApprovalRules,
} from './approval-runtime.js';

describe("approval-runtime", () => {
  describe("approvalsEnabled", () => {
    it('defaults to disabled when the approvals section is omitted', () => {
      expect(approvalsEnabled(undefined)).toBe(false);
    });

    it('honors explicit disablement', () => {
      expect(approvalsEnabled({ enabled: false })).toBe(false);
    });

    it('requires explicit opt-in', () => {
      expect(approvalsEnabled({ enabled: true })).toBe(true);
    });
  });

  describe('resolveGatewayApprovalRules', () => {
    it('returns no rules when approvals are explicitly disabled', () => {
      expect(
        resolveGatewayApprovalRules({
          approvals: { enabled: false, gateDesktopAutomation: true },
          mcpServers: [
            {
              name: "danger",
              command: "npx",
              args: ["-y", "@pkg/danger@1.2.3"],
              trustTier: "untrusted",
              container: "desktop",
            },
          ],
        }),
      ).toEqual([]);
    });

    it('keeps desktop automation gating opt-in', () => {
      const defaultRules = resolveGatewayApprovalRules({
        approvals: { enabled: true },
      });
      const strictRules = resolveGatewayApprovalRules({
        approvals: { enabled: true, gateDesktopAutomation: true },
      });

      expect(defaultRules.map((rule) => rule.tool)).not.toContain(
        "mcp.peekaboo.click",
      );
      expect(strictRules.map((rule) => rule.tool)).toContain(
        "mcp.peekaboo.click",
      );
    });

    it('still adds MCP trust-tier approval rules when approvals remain enabled', () => {
      const rules = resolveGatewayApprovalRules({
        approvals: { enabled: true },
        mcpServers: [
          {
            name: "danger",
            command: "npx",
            args: ["-y", "@pkg/danger@1.2.3"],
            trustTier: "untrusted",
            container: "desktop",
          },
        ],
      });

      expect(rules.map((rule) => rule.tool)).toContain("mcp.danger.*");
    });

    it('does not create approval rules unless the approval engine is enabled', () => {
      expect(resolveGatewayApprovalRules({})).toEqual([]);
      expect(
        resolveGatewayApprovalRules({
          mcpServers: [
            {
              name: "danger",
              command: "npx",
              args: ["-y", "@pkg/danger@1.2.3"],
              trustTier: "untrusted",
              container: "desktop",
            },
          ],
        }),
      ).toEqual([]);
    });
  });
});
