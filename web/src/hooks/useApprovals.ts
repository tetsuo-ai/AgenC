import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApprovalRequest, WSMessage } from '../types';

const AUTO_APPROVE_KEY = 'agenc-auto-approve';

function getBrowserStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage ?? null;
  } catch (error) {
    logStorageWarning('failed to access browser storage', error);
    return null;
  }
}

function logStorageWarning(context: string, error: unknown): void {
  const isDev = (import.meta as { env?: Record<string, unknown> }).env?.DEV === true;
  if (!isDev) return;
  const message = error instanceof Error ? error.message : String(error);
  console.debug(`[useApprovals] ${context}: ${message}`);
}

interface UseApprovalsOptions {
  send: (msg: Record<string, unknown>) => void;
}

export interface UseApprovalsReturn {
  pending: ApprovalRequest[];
  autoApprove: boolean;
  setAutoApprove: (v: boolean) => void;
  respond: (requestId: string, approved: boolean) => void;
}

export function useApprovals({ send }: UseApprovalsOptions): UseApprovalsReturn {
  const [pending, setPending] = useState<ApprovalRequest[]>([]);
  const [autoApprove, setAutoApproveState] = useState(() => {
    try {
      return getBrowserStorage()?.getItem(AUTO_APPROVE_KEY) === 'true';
    } catch (error) {
      logStorageWarning('failed to read auto-approve setting', error);
      return false;
    }
  });
  const respondedRef = useRef<Set<string>>(new Set());
  const autoApproveRef = useRef(autoApprove);

  const setAutoApprove = useCallback((v: boolean) => {
    setAutoApproveState(v);
    autoApproveRef.current = v;
    try {
      getBrowserStorage()?.setItem(AUTO_APPROVE_KEY, String(v));
    } catch (error) {
      logStorageWarning('failed to persist auto-approve setting', error);
    }
  }, []);

  // Keep ref in sync
  useEffect(() => { autoApproveRef.current = autoApprove; }, [autoApprove]);

  const respond = useCallback((requestId: string, approved: boolean) => {
    respondedRef.current.add(requestId);
    send({ type: 'approval.respond', payload: { requestId, approved } });
    setPending((prev) => prev.filter((a) => a.requestId !== requestId));
  }, [send]);

  const handleMessage = useCallback((msg: WSMessage) => {
    if (msg.type === 'approval.request') {
      const payload = (msg.payload ?? msg) as Record<string, unknown>;
      const requestId = (payload.requestId as string) ?? '';
      // Skip if already responded or already in pending
      if (!requestId || respondedRef.current.has(requestId)) return;

      // Auto-approve if enabled
      if (autoApproveRef.current) {
        respondedRef.current.add(requestId);
        send({ type: 'approval.respond', payload: { requestId, approved: true } });
        return;
      }

      const request: ApprovalRequest = {
        requestId,
        action: (payload.action as string) ?? '',
        details: (payload.details as Record<string, unknown>) ?? {},
        message: typeof payload.message === 'string' ? payload.message : undefined,
        deadlineAt:
          typeof payload.deadlineAt === 'number' ? payload.deadlineAt : undefined,
        slaMs: typeof payload.slaMs === 'number' ? payload.slaMs : undefined,
        escalateAt:
          typeof payload.escalateAt === 'number' ? payload.escalateAt : undefined,
        allowDelegatedResolution:
          typeof payload.allowDelegatedResolution === 'boolean'
            ? payload.allowDelegatedResolution
            : undefined,
        approverGroup:
          typeof payload.approverGroup === 'string'
            ? payload.approverGroup
            : undefined,
        requiredApproverRoles: Array.isArray(payload.requiredApproverRoles)
          ? payload.requiredApproverRoles.filter(
              (entry): entry is string => typeof entry === 'string',
            )
          : undefined,
        parentSessionId:
          typeof payload.parentSessionId === 'string'
            ? payload.parentSessionId
            : undefined,
        subagentSessionId:
          typeof payload.subagentSessionId === 'string'
            ? payload.subagentSessionId
            : undefined,
      };
      setPending((prev) => {
        if (prev.some((a) => a.requestId === requestId)) return prev;
        return [...prev, request];
      });
      return;
    }

    if (msg.type === 'approval.escalated') {
      const payload = (msg.payload ?? msg) as Record<string, unknown>;
      const requestId = (payload.requestId as string) ?? '';
      if (!requestId) return;
      setPending((prev) =>
        prev.map((request) =>
          request.requestId !== requestId
            ? request
            : {
                ...request,
                escalated: true,
                escalatedAt:
                  typeof payload.escalatedAt === 'number'
                    ? payload.escalatedAt
                    : request.escalatedAt,
                escalateToSessionId:
                  typeof payload.escalateToSessionId === 'string'
                    ? payload.escalateToSessionId
                    : request.escalateToSessionId,
                approverGroup:
                  typeof payload.approverGroup === 'string'
                    ? payload.approverGroup
                    : request.approverGroup,
                requiredApproverRoles: Array.isArray(payload.requiredApproverRoles)
                  ? payload.requiredApproverRoles.filter(
                      (entry): entry is string => typeof entry === 'string',
                    )
                  : request.requiredApproverRoles,
              },
        ),
      );
    }
  }, [send]);

  return { pending, autoApprove, setAutoApprove, respond, handleMessage } as UseApprovalsReturn & { handleMessage: (msg: WSMessage) => void };
}
