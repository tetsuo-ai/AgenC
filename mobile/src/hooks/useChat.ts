/**
 * Chat message handling hook.
 *
 * Manages the message list and provides send/receive helpers
 * that integrate with useRemoteGateway.
 */

import { useState, useCallback } from 'react';
import type { ChatMessage, ApprovalRequest } from '../types';

let messageCounter = 0;

function generateId(): string {
  return `msg_${Date.now()}_${++messageCounter}`;
}

interface UseChatResult {
  messages: ChatMessage[];
  approvalRequests: ApprovalRequest[];
  sendMessage: (content: string) => void;
  handleIncoming: (data: unknown) => void;
  clearMessages: () => void;
  respondToApproval: (id: string, approved: boolean) => void;
}

export function useChat(
  gatewaySend: (msg: Record<string, unknown>) => void,
): UseChatResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [approvalRequests, setApprovalRequests] = useState<ApprovalRequest[]>([]);

  const sendMessage = useCallback((content: string) => {
    const msg: ChatMessage = {
      id: generateId(),
      content,
      sender: 'user',
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, msg]);
    gatewaySend({ type: 'chat.message', payload: { content } });
  }, [gatewaySend]);

  const handleIncoming = useCallback((data: unknown) => {
    if (!data || typeof data !== 'object') return;
    const msg = data as Record<string, unknown>;

    if (msg.type === 'chat.response' && msg.payload && typeof msg.payload === 'object') {
      const payload = msg.payload as Record<string, unknown>;
      const chatMsg: ChatMessage = {
        id: typeof payload.id === 'string' ? payload.id : generateId(),
        content: typeof payload.content === 'string' ? payload.content : '',
        sender: 'agent',
        timestamp: typeof payload.timestamp === 'number' ? payload.timestamp : Date.now(),
      };
      setMessages((prev) => [...prev, chatMsg]);
    }

    if (msg.type === 'approval.request' && msg.payload && typeof msg.payload === 'object') {
      const payload = msg.payload as Record<string, unknown>;
      const request: ApprovalRequest = {
        id: typeof payload.id === 'string' ? payload.id : generateId(),
        tool: typeof payload.tool === 'string' ? payload.tool : 'unknown',
        args: typeof payload.args === 'object' && payload.args ? payload.args as Record<string, unknown> : {},
        reason: typeof payload.reason === 'string' ? payload.reason : '',
        timestamp: typeof payload.timestamp === 'number' ? payload.timestamp : Date.now(),
      };
      setApprovalRequests((prev) => [...prev, request]);
    }
  }, []);

  const respondToApproval = useCallback((id: string, approved: boolean) => {
    gatewaySend({ type: 'approval.response', payload: { id, approved } });
    setApprovalRequests((prev) => prev.filter((r) => r.id !== id));
  }, [gatewaySend]);

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  return { messages, approvalRequests, sendMessage, handleIncoming, clearMessages, respondToApproval };
}
