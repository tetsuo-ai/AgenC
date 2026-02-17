/**
 * WebChat subsystem query handlers.
 *
 * Each handler processes a specific dotted-namespace message type
 * (e.g. 'status.get', 'skills.list') and returns structured data
 * from the Gateway's subsystems.
 *
 * Handlers that need async operations (memory, approvals) return
 * void | Promise<void> — the plugin awaits the result.
 *
 * Events handlers (events.subscribe/unsubscribe) are handled directly
 * in the plugin because they need clientId for per-client tracking.
 *
 * @module
 */

import type { ControlResponse } from '../../gateway/types.js';
import type { WebChatDeps } from './types.js';

export type SendFn = (response: ControlResponse) => void;

const SOLANA_NOT_CONFIGURED =
  'On-chain task operations require Solana connection — configure connection.rpcUrl in config';

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
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): void {
  const skillName = payload?.skillName;
  if (!skillName || typeof skillName !== 'string') {
    send({ type: 'error', error: 'Missing skillName in payload', id });
    return;
  }
  const enabled = payload?.enabled;
  if (typeof enabled !== 'boolean') {
    send({ type: 'error', error: 'Missing enabled (boolean) in payload', id });
    return;
  }
  if (!deps.skillToggle) {
    send({ type: 'error', error: 'Skill toggle not available', id });
    return;
  }
  deps.skillToggle(skillName, enabled);
  // Re-send updated skill list
  send({
    type: 'skills.list',
    payload: deps.skills ?? [],
    id,
  });
}

// ============================================================================
// Tasks handlers (informative stubs — require Solana connection)
// ============================================================================

export function handleTasksList(
  _deps: WebChatDeps,
  _payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): void {
  send({ type: 'error', error: SOLANA_NOT_CONFIGURED, id });
}

export function handleTasksCreate(
  _deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): void {
  const params = payload?.params;
  if (!params || typeof params !== 'object') {
    send({ type: 'error', error: 'Missing params in payload', id });
    return;
  }
  send({ type: 'error', error: SOLANA_NOT_CONFIGURED, id });
}

export function handleTasksCancel(
  _deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): void {
  const taskId = payload?.taskId;
  if (!taskId || typeof taskId !== 'string') {
    send({ type: 'error', error: 'Missing taskId in payload', id });
    return;
  }
  send({ type: 'error', error: SOLANA_NOT_CONFIGURED, id });
}

// ============================================================================
// Memory handlers
// ============================================================================

export async function handleMemorySearch(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): Promise<void> {
  const query = payload?.query;
  if (!query || typeof query !== 'string') {
    send({ type: 'error', error: 'Missing query in payload', id });
    return;
  }
  if (!deps.memoryBackend) {
    send({ type: 'error', error: 'Memory backend not configured', id });
    return;
  }
  try {
    // Search across sessions matching the query as a prefix, or fall back to
    // querying all sessions for entries containing the search string.
    const sessions = await deps.memoryBackend.listSessions(query);
    let entries: Array<{ content: string; timestamp: number; role: string }> = [];

    if (sessions.length > 0) {
      // Gather recent entries from matching sessions
      for (const sid of sessions.slice(0, 10)) {
        const thread = await deps.memoryBackend.getThread(sid, 20);
        entries.push(
          ...thread.map((e) => ({ content: e.content, timestamp: e.timestamp, role: e.role })),
        );
      }
    } else {
      // Fall back: list all sessions and search entry content
      const allSessions = await deps.memoryBackend.listSessions();
      for (const sid of allSessions.slice(0, 20)) {
        const thread = await deps.memoryBackend.getThread(sid, 50);
        const matching = thread.filter((e) =>
          e.content.toLowerCase().includes(query.toLowerCase()),
        );
        entries.push(
          ...matching.map((e) => ({ content: e.content, timestamp: e.timestamp, role: e.role })),
        );
      }
    }

    // Sort by timestamp descending, limit to 50
    entries.sort((a, b) => b.timestamp - a.timestamp);
    entries = entries.slice(0, 50);

    send({ type: 'memory.results', payload: entries, id });
  } catch (err) {
    send({ type: 'error', error: `Memory search failed: ${(err as Error).message}`, id });
  }
}

export async function handleMemorySessions(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): Promise<void> {
  if (!deps.memoryBackend) {
    send({ type: 'error', error: 'Memory backend not configured', id });
    return;
  }
  try {
    const limit = typeof payload?.limit === 'number' ? payload.limit : 50;
    const sessions = await deps.memoryBackend.listSessions();
    const results: Array<{ id: string; messageCount: number; lastActiveAt: number }> = [];

    for (const sid of sessions.slice(0, limit)) {
      const thread = await deps.memoryBackend.getThread(sid);
      results.push({
        id: sid,
        messageCount: thread.length,
        lastActiveAt: thread.length > 0 ? thread[thread.length - 1].timestamp : 0,
      });
    }

    send({ type: 'memory.sessions', payload: results, id });
  } catch (err) {
    send({ type: 'error', error: `Memory sessions failed: ${(err as Error).message}`, id });
  }
}

// ============================================================================
// Approval handlers
// ============================================================================

export function handleApprovalRespond(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): void {
  const requestId = payload?.requestId;
  const approved = payload?.approved;
  if (!requestId || typeof requestId !== 'string') {
    send({ type: 'error', error: 'Missing requestId in payload', id });
    return;
  }
  if (typeof approved !== 'boolean') {
    send({ type: 'error', error: 'Missing approved (boolean) in payload', id });
    return;
  }
  if (!deps.approvalEngine) {
    send({ type: 'error', error: 'Approval engine not configured', id });
    return;
  }
  deps.approvalEngine.resolve(requestId, {
    requestId,
    disposition: approved ? 'yes' : 'no',
  });
  send({
    type: 'approval.respond',
    payload: { requestId, approved, acknowledged: true },
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
) => void | Promise<void>;

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
};
