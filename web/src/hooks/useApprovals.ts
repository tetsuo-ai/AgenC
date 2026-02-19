import { useCallback, useRef, useState } from 'react';
import type { ApprovalRequest, WSMessage } from '../types';

interface UseApprovalsOptions {
  send: (msg: Record<string, unknown>) => void;
}

export interface UseApprovalsReturn {
  pending: ApprovalRequest[];
  respond: (requestId: string, approved: boolean) => void;
}

export function useApprovals({ send }: UseApprovalsOptions): UseApprovalsReturn {
  const [pending, setPending] = useState<ApprovalRequest[]>([]);
  const respondedRef = useRef<Set<string>>(new Set());

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
  }, []);

  return { pending, respond, handleMessage } as UseApprovalsReturn & { handleMessage: (msg: WSMessage) => void };
}
