import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApprovalRequest, WSMessage } from '../types';

const AUTO_APPROVE_KEY = 'agenc-auto-approve';

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
    try { return localStorage.getItem(AUTO_APPROVE_KEY) === 'true'; } catch { return false; }
  });
  const respondedRef = useRef<Set<string>>(new Set());
  const autoApproveRef = useRef(autoApprove);

  const setAutoApprove = useCallback((v: boolean) => {
    setAutoApproveState(v);
    autoApproveRef.current = v;
    try { localStorage.setItem(AUTO_APPROVE_KEY, String(v)); } catch {}
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
      };
      setPending((prev) => {
        if (prev.some((a) => a.requestId === requestId)) return prev;
        return [...prev, request];
      });
    }
  }, [send]);

  return { pending, autoApprove, setAutoApprove, respond, handleMessage } as UseApprovalsReturn & { handleMessage: (msg: WSMessage) => void };
}
