import { useCallback, useState } from 'react';
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

  const respond = useCallback((requestId: string, approved: boolean) => {
    send({ type: 'approval.respond', payload: { requestId, approved } });
    setPending((prev) => prev.filter((a) => a.requestId !== requestId));
  }, [send]);

  const handleMessage = useCallback((msg: WSMessage) => {
    if (msg.type === 'approval.request') {
      const payload = (msg.payload ?? msg) as Record<string, unknown>;
      const request: ApprovalRequest = {
        requestId: (payload.requestId as string) ?? '',
        action: (payload.action as string) ?? '',
        details: (payload.details as Record<string, unknown>) ?? {},
      };
      setPending((prev) => [...prev, request]);
    }
  }, []);

  return { pending, respond, handleMessage } as UseApprovalsReturn & { handleMessage: (msg: WSMessage) => void };
}
