/**
 * WebChat subsystem query handlers.
 *
 * Each handler processes a specific dotted-namespace message type
 * (e.g. 'status.get', 'skills.list') and returns structured data
 * from the Gateway's available APIs.
 *
 * For MVP, these are read-only proxies querying Gateway status/config.
 * Full subsystem integration (SkillRegistry, TaskOperations, MemoryBackend)
 * requires those subsystems to be wired into the Gateway — beyond this
 * issue's scope.
 *
 * @module
 */

import type { ControlResponse } from '../../gateway/types.js';
import type { WebChatDeps } from './types.js';

export type SendFn = (response: ControlResponse) => void;

// ============================================================================
// Status handlers
// ============================================================================

export function handleStatusGet(
  deps: WebChatDeps,
  _payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): void {
  const status = deps.gateway.getStatus();
  send({
    type: 'status.update',
    payload: {
      ...status,
      agentName: deps.gateway.config.agent?.name,
    },
    id,
  });
}

// ============================================================================
// Skills handlers
// ============================================================================

export function handleSkillsList(
  deps: WebChatDeps,
  _payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): void {
  send({
    type: 'skills.list',
    payload: deps.skills ?? [],
    id,
  });
}

export function handleSkillsToggle(
  _deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): void {
  const skillName = (payload as Record<string, unknown> | undefined)?.skillName;
  if (!skillName || typeof skillName !== 'string') {
    send({ type: 'error', error: 'Missing skillName in payload', id });
    return;
  }
  // MVP: Acknowledge but don't actually toggle
  send({
    type: 'skills.list',
    payload: [],
    id,
  });
}

// ============================================================================
// Tasks handlers
// ============================================================================

export function handleTasksList(
  _deps: WebChatDeps,
  _payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): void {
  // MVP: Return empty list — full TaskOperations integration pending
  send({
    type: 'tasks.list',
    payload: [],
    id,
  });
}

export function handleTasksCreate(
  _deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): void {
  const params = (payload as Record<string, unknown> | undefined)?.params;
  if (!params || typeof params !== 'object') {
    send({ type: 'error', error: 'Missing params in payload', id });
    return;
  }
  // MVP: Acknowledge
  send({
    type: 'tasks.list',
    payload: [],
    id,
  });
}

export function handleTasksCancel(
  _deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): void {
  const taskId = (payload as Record<string, unknown> | undefined)?.taskId;
  if (!taskId || typeof taskId !== 'string') {
    send({ type: 'error', error: 'Missing taskId in payload', id });
    return;
  }
  // MVP: Acknowledge
  send({
    type: 'tasks.list',
    payload: [],
    id,
  });
}

// ============================================================================
// Memory handlers
// ============================================================================

export function handleMemorySearch(
  _deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): void {
  const query = (payload as Record<string, unknown> | undefined)?.query;
  if (!query || typeof query !== 'string') {
    send({ type: 'error', error: 'Missing query in payload', id });
    return;
  }
  // MVP: Return empty results
  send({
    type: 'memory.results',
    payload: [],
    id,
  });
}

export function handleMemorySessions(
  _deps: WebChatDeps,
  _payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): void {
  // MVP: Return empty sessions
  send({
    type: 'memory.sessions',
    payload: [],
    id,
  });
}

// ============================================================================
// Approval handlers
// ============================================================================

export function handleApprovalRespond(
  _deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): void {
  const requestId = (payload as Record<string, unknown> | undefined)?.requestId;
  const approved = (payload as Record<string, unknown> | undefined)?.approved;
  if (!requestId || typeof requestId !== 'string') {
    send({ type: 'error', error: 'Missing requestId in payload', id });
    return;
  }
  if (typeof approved !== 'boolean') {
    send({ type: 'error', error: 'Missing approved (boolean) in payload', id });
    return;
  }
  // MVP: Acknowledge
  send({
    type: 'approval.respond' as string,
    payload: { requestId, approved, acknowledged: true },
    id,
  });
}

// ============================================================================
// Events handlers
// ============================================================================

export function handleEventsSubscribe(
  _deps: WebChatDeps,
  _payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): void {
  // MVP: Acknowledge subscription
  send({
    type: 'events.subscribed' as string,
    payload: { active: true },
    id,
  });
}

export function handleEventsUnsubscribe(
  _deps: WebChatDeps,
  _payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): void {
  // MVP: Acknowledge unsubscription
  send({
    type: 'events.unsubscribed' as string,
    payload: { active: false },
    id,
  });
}

// ============================================================================
// Handler map
// ============================================================================

export type HandlerFn = (
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
) => void;

/** Map of dotted-namespace message types to their handler functions. */
export const HANDLER_MAP: Readonly<Record<string, HandlerFn>> = {
  'status.get': handleStatusGet,
  'skills.list': handleSkillsList,
  'skills.toggle': handleSkillsToggle,
  'tasks.list': handleTasksList,
  'tasks.create': handleTasksCreate,
  'tasks.cancel': handleTasksCancel,
  'memory.search': handleMemorySearch,
  'memory.sessions': handleMemorySessions,
  'approval.respond': handleApprovalRespond,
  'events.subscribe': handleEventsSubscribe,
  'events.unsubscribe': handleEventsUnsubscribe,
};
