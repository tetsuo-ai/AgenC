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
import type { BackgroundRunControlAction } from '../../gateway/background-run-operator.js';
import { createProgram } from '../../idl.js';
import { OnChainTaskStatus, taskStatusToString } from '../../task/types.js';
import { findTaskPda, findEscrowPda } from '../../task/pda.js';
import { findProtocolPda } from '../../agent/pda.js';
import { lamportsToSol, toAnchorBytes } from '../../utils/encoding.js';
import { loadKeypairFromFile, getDefaultKeypairPath } from '../../types/wallet.js';
import { IDL } from '../../idl.js';
import { AgentStatus, agentStatusToString } from '../../agent/types.js';
import { getCapabilityNames } from '../../agent/capabilities.js';
import anchor, { AnchorProvider } from '@coral-xyz/anchor';
import { PublicKey, SystemProgram } from '@solana/web3.js';

export type SendFn = (response: ControlResponse) => void;
export interface HandlerRequestContext {
  /** Gateway-assigned websocket client id for this request. */
  clientId: string;
  /** Stable owner key for the connected web client. */
  ownerKey: string;
  /** Logical channel name for the request. */
  channel: string;
  /** Active mapped chat session for this client, if any. */
  activeSessionId?: string;
  /** Session ids owned by the current client. */
  listOwnedSessionIds(): string[];
  /** True when the provided session id is owned by the current client. */
  isSessionOwned(sessionId: string): boolean;
}

const SOLANA_NOT_CONFIGURED =
  'On-chain task operations require Solana connection — configure connection.rpcUrl in config';
const DESKTOP_MEMORY_LIMIT_RE = /^\d+(?:[bkmg])?$/i;
const DESKTOP_CPU_LIMIT_RE = /^(?:\d+(?:\.\d+)?|\.\d+)$/;

function parseDesktopResourceOverride(
  value: unknown,
  field: 'maxMemory' | 'maxCpu',
): { value?: string; error?: string } {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'string') {
    return { error: `${field} must be a string` };
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) return {};

  if (field === 'maxMemory') {
    if (!DESKTOP_MEMORY_LIMIT_RE.test(trimmed)) {
      return {
        error: 'maxMemory must look like 512m or 2g (plain integers default to GB)',
      };
    }
    const normalized = trimmed.toLowerCase();
    if (/^\d+$/.test(normalized)) {
      return { value: `${normalized}g` };
    }
    return { value: normalized };
  }

  if (!DESKTOP_CPU_LIMIT_RE.test(trimmed)) {
    return {
      error: 'maxCpu must be a positive number like 0.5 or 2.0',
    };
  }
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { error: 'maxCpu must be greater than 0' };
  }
  return { value: trimmed };
}

/** Create an AnchorProvider from a Connection + Keypair. */
function createWalletProvider(
  connection: import('@solana/web3.js').Connection,
  keypair: import('@solana/web3.js').Keypair,
): AnchorProvider {
  const wallet = {
    publicKey: keypair.publicKey,
    signTransaction: async <T extends import('@solana/web3.js').Transaction | import('@solana/web3.js').VersionedTransaction>(tx: T): Promise<T> => {
      if ('sign' in tx) (tx as import('@solana/web3.js').Transaction).sign(keypair);
      return tx;
    },
    signAllTransactions: async <T extends import('@solana/web3.js').Transaction | import('@solana/web3.js').VersionedTransaction>(txs: T[]): Promise<T[]> => {
      for (const tx of txs) {
        if ('sign' in tx) (tx as import('@solana/web3.js').Transaction).sign(keypair);
      }
      return txs;
    },
  };
  return new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
}

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
// Tasks handlers — on-chain Solana task operations
// ============================================================================

/**
 * Task account binary layout offsets (devnet program).
 * Layout: 8 (discriminator) + 32 (task_id) + 32 (creator) + 8 (capabilities)
 *       + 64 (description) + 8 (reward_amount)
 *       + 1 (max_workers) + 1 (current_workers) + 1 (status)
 */
const TASK_DISCRIMINATOR = Buffer.from([79, 34, 229, 55, 88, 90, 55, 84]);
const TASK_CREATOR_OFFSET = 40;
const TASK_DESCRIPTION_OFFSET = 80;
const TASK_REWARD_OFFSET = 144;
const TASK_CURRENT_WORKERS_OFFSET = 153;
const TASK_STATUS_OFFSET = 154;

/** Parse a raw Task account buffer into the fields we need. */
function parseRawTaskAccount(data: Buffer): {
  status: OnChainTaskStatus;
  reward: bigint;
  creator: PublicKey;
  currentWorkers: number;
  description: string;
} {
  const statusByte = data[TASK_STATUS_OFFSET];
  const currentWorkers = data[TASK_CURRENT_WORKERS_OFFSET];
  const creator = new PublicKey(data.subarray(TASK_CREATOR_OFFSET, TASK_CREATOR_OFFSET + 32));
  // reward_amount is u64 little-endian at offset 144
  const rewardSlice = data.subarray(TASK_REWARD_OFFSET, TASK_REWARD_OFFSET + 8);
  const reward = rewardSlice.readBigUInt64LE(0);
  // description is 64 bytes at offset 80, trim trailing nulls
  const descBuf = data.subarray(TASK_DESCRIPTION_OFFSET, TASK_DESCRIPTION_OFFSET + 64);
  const nullIdx = descBuf.indexOf(0);
  const description = new TextDecoder().decode(descBuf.subarray(0, nullIdx === -1 ? 64 : nullIdx));
  return { status: statusByte as OnChainTaskStatus, reward, creator, currentWorkers, description };
}

/** Helper: send a refreshed task list to the client using raw getProgramAccounts. */
async function sendTaskList(deps: WebChatDeps, id: string | undefined, send: SendFn): Promise<void> {
  const connection = deps.connection!;
  const bs58 = await import('bs58');
  const programId = new PublicKey(IDL.address!);

  // Fetch Open and InProgress tasks in parallel using raw getProgramAccounts
  const makeFilter = (statusByte: number) => [
    { memcmp: { offset: 0, bytes: bs58.default.encode(TASK_DISCRIMINATOR) } },
    { memcmp: { offset: TASK_STATUS_OFFSET, bytes: bs58.default.encode(Buffer.from([statusByte])) } },
  ];

  const [openAccounts, inProgressAccounts] = await Promise.all([
    connection.getProgramAccounts(programId, { filters: makeFilter(OnChainTaskStatus.Open) }),
    connection.getProgramAccounts(programId, { filters: makeFilter(OnChainTaskStatus.InProgress) }),
  ]);

  const allAccounts = [...openAccounts, ...inProgressAccounts];
  const payload = allAccounts.map((acc) => {
    const task = parseRawTaskAccount(acc.account.data as Buffer);
    return {
      id: acc.pubkey.toBase58(),
      status: taskStatusToString(task.status),
      reward: lamportsToSol(task.reward),
      creator: task.creator.toBase58(),
      description: task.description,
      worker: task.currentWorkers > 0 ? `${task.currentWorkers} worker(s)` : undefined,
    };
  });
  send({ type: 'tasks.list', payload, id });
}

export async function handleTasksList(
  deps: WebChatDeps,
  _payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): Promise<void> {
  if (!deps.connection) {
    send({ type: 'error', error: SOLANA_NOT_CONFIGURED, id });
    return;
  }
  await safeAsync(send, id, 'error', 'Failed to list tasks', () => sendTaskList(deps, id, send));
}

export async function handleTasksCreate(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): Promise<void> {
  const params = payload?.params;
  if (!params || typeof params !== 'object') {
    send({ type: 'error', error: 'Missing params in payload', id });
    return;
  }
  if (!deps.connection) {
    send({ type: 'error', error: SOLANA_NOT_CONFIGURED, id });
    return;
  }

  const keypairPath = deps.gateway.config.connection?.keypairPath ?? getDefaultKeypairPath();
  try {
    const keypair = await loadKeypairFromFile(keypairPath);
    const provider = createWalletProvider(deps.connection, keypair);
    const program = createProgram(provider);
    const creator = keypair.publicKey;

    const descStr = typeof (params as Record<string, unknown>).description === 'string'
      ? (params as Record<string, unknown>).description as string
      : 'Task from WebUI';
    const rewardInput = typeof (params as Record<string, unknown>).reward === 'number'
      ? (params as Record<string, unknown>).reward as number
      : 0;
    // Treat reward as SOL (UI label) and convert to lamports.
    const rewardLamports = BigInt(Math.max(Math.round(rewardInput * 1_000_000_000), 10_000_000));

    // Generate random 32-byte task ID
    const taskId = new Uint8Array(32);
    crypto.getRandomValues(taskId);

    // Pad description to 64 bytes
    const descBytes = new Uint8Array(64);
    const encoded = new TextEncoder().encode(descStr.slice(0, 64));
    descBytes.set(encoded);

    // Derive PDAs
    const taskPda = findTaskPda(creator, taskId, program.programId);
    const escrowPda = findEscrowPda(taskPda, program.programId);
    const protocolPda = findProtocolPda(program.programId);

    const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

    // Devnet program: 7 args (no constraintHash, minReputation, rewardMint);
    // canonical IDL types expect 10, so we use `as any` to bypass arity check.
    await (program.methods as any)
      .createTask(
        toAnchorBytes(taskId),
        new anchor.BN('1'),                        // requiredCapabilities
        toAnchorBytes(descBytes),
        new anchor.BN(rewardLamports.toString()),   // reward
        1,                                          // maxWorkers
        new anchor.BN(deadline),                    // deadline
        0,                                          // taskType: exclusive
      )
      .accountsPartial({
        task: taskPda,
        escrow: escrowPda,
        protocolConfig: protocolPda,
        creator,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Auto-refresh task list after creation
    await sendTaskList(deps, id, send);
    deps.broadcastEvent?.('task.created', { taskPda: taskPda.toBase58(), description: descStr });
  } catch (err) {
    send({ type: 'error', error: `Failed to create task: ${(err as Error).message}`, id });
  }
}

export async function handleTasksCancel(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): Promise<void> {
  const taskId = payload?.taskId;
  if (!taskId || typeof taskId !== 'string') {
    send({ type: 'error', error: 'Missing taskId in payload', id });
    return;
  }
  if (!deps.connection) {
    send({ type: 'error', error: SOLANA_NOT_CONFIGURED, id });
    return;
  }

  const keypairPath = deps.gateway.config.connection?.keypairPath ?? getDefaultKeypairPath();
  try {
    const keypair = await loadKeypairFromFile(keypairPath);
    const provider = createWalletProvider(deps.connection, keypair);
    const program = createProgram(provider);
    const taskPda = new PublicKey(taskId);

    const escrowPda = findEscrowPda(taskPda, program.programId);

    // Devnet cancel_task: only 4 accounts (task, escrow, creator, system_program)
    await program.methods
      .cancelTask()
      .accountsPartial({
        authority: keypair.publicKey,
        task: taskPda,
        escrow: escrowPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Auto-refresh task list after cancellation
    await sendTaskList(deps, id, send);
    deps.broadcastEvent?.('task.cancelled', { taskPda: taskId });
  } catch (err) {
    send({ type: 'error', error: `Failed to cancel task: ${(err as Error).message}`, id });
  }
}

// ============================================================================
// Memory handlers
// ============================================================================

export async function handleMemorySearch(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  request: HandlerRequestContext,
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
    const sessions = request.listOwnedSessionIds();
    if (sessions.length === 0) {
      send({ type: 'memory.results', payload: [], id });
      return;
    }
    let entries: Array<{ content: string; timestamp: number; role: string }> = [];

    const lowerQuery = query.toLowerCase();
    for (const sid of sessions.slice(0, 20)) {
      const thread = await deps.memoryBackend.getThread(sid, 50);
      const sidMatches = sid.toLowerCase().includes(lowerQuery);
      if (sidMatches) {
        entries.push(
          ...thread.slice(-20).map((e) => ({ content: e.content, timestamp: e.timestamp, role: e.role })),
        );
        continue;
      }
      const matching = thread.filter((e) => e.content.toLowerCase().includes(lowerQuery));
      entries.push(
        ...matching.map((e) => ({ content: e.content, timestamp: e.timestamp, role: e.role })),
      );
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
  request: HandlerRequestContext,
): Promise<void> {
  if (!deps.memoryBackend) {
    send({ type: 'error', error: 'Memory backend not configured', id });
    return;
  }
  try {
    const limit = typeof payload?.limit === 'number' ? payload.limit : 50;
    const sessions = request.listOwnedSessionIds();
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

export async function handleApprovalRespond(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  request: HandlerRequestContext,
): Promise<void> {
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
  const resolved = await deps.approvalEngine.resolve(requestId, {
    requestId,
    disposition: approved ? 'yes' : 'no',
    approvedBy: request.ownerKey,
    resolver: {
      actorId: request.ownerKey,
      sessionId: request.activeSessionId,
      channel: request.channel,
      resolvedAt: Date.now(),
    },
  });
  if (!resolved) {
    send({
      type: 'error',
      error: `Approval response rejected for request ${requestId}`,
      id,
    });
    return;
  }
  send({
    type: 'approval.respond',
    payload: { requestId, approved, acknowledged: true },
    id,
  });
}

export async function handlePolicySimulate(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  request: HandlerRequestContext,
): Promise<void> {
  if (!deps.policyPreview) {
    send({ type: 'error', error: 'Policy simulation is not configured', id });
    return;
  }
  const toolName = typeof payload?.toolName === 'string' ? payload.toolName.trim() : '';
  if (!toolName) {
    send({ type: 'error', error: 'Missing toolName in payload', id });
    return;
  }
  const targetSessionId =
    typeof payload?.sessionId === 'string' && payload.sessionId.length > 0
      ? payload.sessionId
      : request.activeSessionId;
  if (!targetSessionId) {
    send({ type: 'error', error: 'No active session available for policy simulation', id });
    return;
  }
  if (!request.isSessionOwned(targetSessionId)) {
    send({ type: 'error', error: 'Session is not owned by the current web client', id });
    return;
  }
  const args =
    payload?.args && typeof payload.args === 'object' && !Array.isArray(payload.args)
      ? (payload.args as Record<string, unknown>)
      : {};
  const result = await deps.policyPreview({
    sessionId: targetSessionId,
    toolName,
    args,
  });
  send({
    type: 'policy.simulate',
    payload: result,
    id,
  });
}

// ============================================================================
// Agents handlers — on-chain registered agents
// ============================================================================

/**
 * Agent account discriminator (first 8 bytes).
 * The struct contains variable-length Borsh strings (endpoint, metadata_uri)
 * so we parse sequentially rather than using fixed offsets.
 */
const AGENT_ACCT_DISCRIMINATOR = Buffer.from([130, 53, 100, 103, 121, 77, 148, 19]);
/** Minimum byte length for an agent account (all variable-length strings empty). */
const AGENT_ACCT_MIN_LENGTH = 132;

/** Parse agent data from a raw Borsh-serialized account buffer. */
function parseRawAgentAccount(data: Buffer): {
  agentId: string;
  authority: string;
  capabilities: bigint;
  status: AgentStatus;
  reputation: number;
  tasksCompleted: bigint;
  stake: bigint;
  endpoint: string;
  metadataUri: string;
  registeredAt: bigint;
  lastActive: bigint;
  totalEarned: bigint;
  activeTasks: number;
} | null {
  if (data.length < AGENT_ACCT_MIN_LENGTH) {
    console.warn(`[parseRawAgentAccount] data too short: ${data.length} bytes (min ${AGENT_ACCT_MIN_LENGTH})`);
    return null;
  }
  let off = 8; // skip discriminator

  // agent_id: [u8; 32]
  const agentId = data.subarray(off, off + 32);
  off += 32;

  // authority: Pubkey (32 bytes)
  const authority = new PublicKey(data.subarray(off, off + 32));
  off += 32;

  // capabilities: u64 LE
  const capabilities = data.readBigUInt64LE(off);
  off += 8;

  // status: u8 enum
  const status = data[off] as AgentStatus;
  off += 1;

  // endpoint: Borsh String (u32 len prefix + variable bytes)
  const endpointLen = data.readUInt32LE(off);
  off += 4;
  const endpoint = data.subarray(off, off + endpointLen).toString('utf8');
  off += endpointLen;

  // metadata_uri: Borsh String (u32 len prefix + variable bytes)
  const metadataUriLen = data.readUInt32LE(off);
  off += 4;
  const metadataUri = data.subarray(off, off + metadataUriLen).toString('utf8');
  off += metadataUriLen;

  // registered_at: i64
  const registeredAt = data.readBigInt64LE(off);
  off += 8;

  // last_active: i64
  const lastActive = data.readBigInt64LE(off);
  off += 8;

  // tasks_completed: u64
  const tasksCompleted = data.readBigUInt64LE(off);
  off += 8;

  // total_earned: u64
  const totalEarned = data.readBigUInt64LE(off);
  off += 8;

  // reputation: u16
  const reputation = data.readUInt16LE(off);
  off += 2;

  // active_tasks: u8
  const activeTasks = data[off];
  off += 1;

  // stake: u64
  const stake = data.readBigUInt64LE(off);

  return {
    agentId: Buffer.from(agentId).toString('hex').slice(0, 16),
    authority: authority.toBase58(),
    capabilities,
    status,
    reputation,
    tasksCompleted,
    stake,
    endpoint,
    metadataUri,
    registeredAt,
    lastActive,
    totalEarned,
    activeTasks,
  };
}

export async function handleAgentsList(
  deps: WebChatDeps,
  _payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): Promise<void> {
  if (!deps.connection) {
    send({ type: 'agents.list', payload: [], id });
    return;
  }

  try {
    const bs58 = await import('bs58');
    const programId = new PublicKey(IDL.address!);

    // Fetch all agent registration accounts
    const accounts = await deps.connection.getProgramAccounts(programId, {
      filters: [
        { memcmp: { offset: 0, bytes: bs58.default.encode(AGENT_ACCT_DISCRIMINATOR) } },
      ],
    });

    const payload = accounts.map((acc) => {
      try {
        const agent = parseRawAgentAccount(acc.account.data as Buffer);
        if (!agent) return null;
        return {
          pda: acc.pubkey.toBase58(),
          agentId: agent.agentId,
          authority: agent.authority,
          capabilities: getCapabilityNames(agent.capabilities),
          status: agentStatusToString(agent.status),
          reputation: agent.reputation,
          tasksCompleted: Number(agent.tasksCompleted),
          stake: lamportsToSol(agent.stake),
          endpoint: agent.endpoint ? agent.endpoint : undefined,
          metadataUri: agent.metadataUri ? agent.metadataUri : undefined,
          registeredAt: agent.registeredAt ? Number(agent.registeredAt) : undefined,
          lastActive: agent.lastActive ? Number(agent.lastActive) : undefined,
          totalEarned: lamportsToSol(agent.totalEarned),
          activeTasks: agent.activeTasks,
        };
      } catch (err) {
        console.warn(
          `[handleAgentsList] failed to parse agent account ${acc.pubkey.toBase58()} (${acc.account.data.length} bytes): ${(err as Error).message}`,
        );
        return null;
      }
    }).filter((a): a is NonNullable<typeof a> => a !== null);

    send({ type: 'agents.list', payload, id });
  } catch (err) {
    send({ type: 'error', error: `Failed to list agents: ${(err as Error).message}`, id });
  }
}

// ============================================================================
// Desktop sandbox handlers
// ============================================================================

export async function handleDesktopList(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  request: HandlerRequestContext,
): Promise<void> {
  if (!deps.desktopManager) {
    send({ type: 'desktop.list', payload: [], id });
    return;
  }
  await safeAsync(send, id, 'desktop.error', 'Failed to list sandboxes', async () => {
    const ownedSessions = request.listOwnedSessionIds();
    const maxEntries = typeof payload?.limit === 'number' ? payload.limit : 50;
    const seen = new Set<string>();
    const sandboxes = [];
    for (const sessionId of ownedSessions) {
      const handle = deps.desktopManager!.getHandleBySession(sessionId);
      if (!handle || seen.has(handle.containerId)) continue;
      seen.add(handle.containerId);
      sandboxes.push({
        containerId: handle.containerId,
        sessionId: handle.sessionId,
        status: handle.status,
        createdAt: handle.createdAt,
        lastActivityAt: handle.lastActivityAt,
        vncUrl: `http://localhost:${handle.vncHostPort}/vnc.html`,
        uptimeMs: Date.now() - handle.createdAt,
        maxMemory: handle.maxMemory,
        maxCpu: handle.maxCpu,
      });
      if (sandboxes.length >= maxEntries) break;
    }
    send({ type: 'desktop.list', payload: sandboxes, id });
  });
}

export async function handleDesktopCreate(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  request: HandlerRequestContext,
): Promise<void> {
  if (!deps.desktopManager) {
    send({ type: 'desktop.error', error: 'Desktop sandbox manager not available — enable desktop in config', id });
    return;
  }
  const requestedSessionId =
    typeof payload?.sessionId === 'string' && payload.sessionId.length > 0
      ? payload.sessionId
      : undefined;
  if (requestedSessionId && !request.isSessionOwned(requestedSessionId)) {
    send({ type: 'desktop.error', error: 'Not authorized for target session', id });
    return;
  }
  const sessionId = requestedSessionId ?? request.activeSessionId;
  if (!sessionId) {
    send({ type: 'desktop.error', error: 'Missing sessionId in payload', id });
    return;
  }
  const parsedMemory = parseDesktopResourceOverride(payload?.maxMemory, 'maxMemory');
  if (parsedMemory.error) {
    send({ type: 'desktop.error', error: parsedMemory.error, id });
    return;
  }
  const parsedCpu = parseDesktopResourceOverride(payload?.maxCpu, 'maxCpu');
  if (parsedCpu.error) {
    send({ type: 'desktop.error', error: parsedCpu.error, id });
    return;
  }

  await safeAsync(send, id, 'desktop.error', 'Failed to create sandbox', async () => {
    const handle = await deps.desktopManager!.getOrCreate(sessionId, {
      maxMemory: parsedMemory.value,
      maxCpu: parsedCpu.value,
    });
    send({
      type: 'desktop.created',
      payload: {
        containerId: handle.containerId,
        sessionId: handle.sessionId,
        status: handle.status,
        vncUrl: `http://localhost:${handle.vncHostPort}/vnc.html`,
        apiPort: handle.apiHostPort,
        vncPort: handle.vncHostPort,
        createdAt: handle.createdAt,
        maxMemory: handle.maxMemory,
        maxCpu: handle.maxCpu,
      },
      id,
    });
  });
}

export async function handleDesktopAttach(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  request: HandlerRequestContext,
): Promise<void> {
  if (!deps.desktopManager) {
    send({ type: 'desktop.error', error: 'Desktop sandbox manager not available — enable desktop in config', id });
    return;
  }
  const containerId = payload?.containerId;
  if (!containerId || typeof containerId !== 'string') {
    send({ type: 'desktop.error', error: 'Missing containerId in payload', id });
    return;
  }
  const sessionId = payload?.sessionId;
  if (!sessionId || typeof sessionId !== 'string') {
    send({ type: 'desktop.error', error: 'Missing sessionId in payload', id });
    return;
  }
  if (!request.isSessionOwned(sessionId)) {
    send({ type: 'desktop.error', error: 'Not authorized for target session', id });
    return;
  }
  const ownsContainer = request
    .listOwnedSessionIds()
    .some((sid) => deps.desktopManager!.getHandleBySession(sid)?.containerId === containerId);
  if (!ownsContainer) {
    send({ type: 'desktop.error', error: 'Not authorized for target container', id });
    return;
  }

  await safeAsync(send, id, 'desktop.error', 'Failed to attach sandbox', async () => {
    deps.onDesktopSessionRebound?.(sessionId);
    const handle = deps.desktopManager!.assignSession(containerId, sessionId);
    send({
      type: 'desktop.attached',
      payload: {
        containerId: handle.containerId,
        sessionId,
        status: handle.status,
        vncUrl: `http://localhost:${handle.vncHostPort}/vnc.html`,
      },
      id,
    });
  });
}

export async function handleDesktopDestroy(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  request: HandlerRequestContext,
): Promise<void> {
  if (!deps.desktopManager) {
    send({ type: 'desktop.error', error: 'Desktop sandbox manager not available — enable desktop in config', id });
    return;
  }
  const containerId = payload?.containerId;
  if (!containerId || typeof containerId !== 'string') {
    send({ type: 'desktop.error', error: 'Missing containerId in payload', id });
    return;
  }
  const ownsContainer = request
    .listOwnedSessionIds()
    .some((sid) => deps.desktopManager!.getHandleBySession(sid)?.containerId === containerId);
  if (!ownsContainer) {
    send({ type: 'desktop.error', error: 'Not authorized for target container', id });
    return;
  }
  await safeAsync(send, id, 'desktop.error', 'Failed to destroy sandbox', async () => {
    await deps.desktopManager!.destroy(containerId);
    send({ type: 'desktop.destroyed', payload: { containerId }, id });
  });
}

function resolveOwnedRunSessionId(
  payload: Record<string, unknown> | undefined,
  request: HandlerRequestContext,
): string | undefined {
  const explicit =
    typeof payload?.sessionId === 'string' && payload.sessionId.length > 0
      ? payload.sessionId
      : undefined;
  if (explicit) {
    return request.isSessionOwned(explicit) ? explicit : undefined;
  }
  return request.activeSessionId && request.isSessionOwned(request.activeSessionId)
    ? request.activeSessionId
    : undefined;
}

export async function handleRunsList(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  request: HandlerRequestContext,
): Promise<void> {
  if (!deps.listBackgroundRuns) {
    send({ type: 'error', error: 'Background run operator API not available', id });
    return;
  }
  const explicitSessionId =
    typeof payload?.sessionId === 'string' && payload.sessionId.length > 0
      ? payload.sessionId
      : undefined;
  if (explicitSessionId && !request.isSessionOwned(explicitSessionId)) {
    send({ type: 'error', error: 'Not authorized for target run session', id });
    return;
  }
  const sessionIds = explicitSessionId
    ? [explicitSessionId]
    : request.listOwnedSessionIds();
  await safeAsync(send, id, 'error', 'Failed to list background runs', async () => {
    const runs = await deps.listBackgroundRuns!(sessionIds);
    send({ type: 'runs.list', payload: runs, id });
  });
}

export async function handleRunInspect(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  request: HandlerRequestContext,
): Promise<void> {
  if (!deps.inspectBackgroundRun) {
    send({ type: 'error', error: 'Background run operator API not available', id });
    return;
  }
  const sessionId = resolveOwnedRunSessionId(payload, request);
  if (!sessionId) {
    send({ type: 'error', error: 'Missing or unauthorized run sessionId', id });
    return;
  }
  await safeAsync(send, id, 'error', 'Failed to inspect background run', async () => {
    const detail = await deps.inspectBackgroundRun!(sessionId);
    if (!detail) {
      send({ type: 'error', error: `Background run "${sessionId}" not found`, id });
      return;
    }
    send({ type: 'run.inspect', payload: detail, id });
  });
}

export async function handleRunControl(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  request: HandlerRequestContext,
): Promise<void> {
  if (!deps.controlBackgroundRun) {
    send({ type: 'error', error: 'Background run operator API not available', id });
    return;
  }
  if (!payload || typeof payload !== 'object') {
    send({ type: 'error', error: 'Missing run control payload', id });
    return;
  }
  const sessionId =
    typeof payload.sessionId === 'string' && payload.sessionId.length > 0
      ? payload.sessionId
      : request.activeSessionId;
  if (!sessionId || !request.isSessionOwned(sessionId)) {
    send({ type: 'error', error: 'Missing or unauthorized run sessionId', id });
    return;
  }
  const action = {
    ...payload,
    sessionId,
  } as BackgroundRunControlAction;
  await safeAsync(send, id, 'error', 'Failed to control background run', async () => {
    const detail = await deps.controlBackgroundRun!({
      action,
      actor: request.ownerKey,
      channel: request.channel,
    });
    if (!detail) {
      send({ type: 'error', error: `Background run "${sessionId}" not found`, id });
      return;
    }
    send({ type: 'run.updated', payload: detail, id });
  });
}

export async function handleObservabilitySummary(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
): Promise<void> {
  if (!deps.getObservabilitySummary) {
    send({ type: 'error', error: 'Observability API not available', id });
    return;
  }
  const windowMs =
    typeof payload?.windowMs === 'number' && Number.isFinite(payload.windowMs)
      ? payload.windowMs
      : undefined;
  await safeAsync(send, id, 'error', 'Failed to load observability summary', async () => {
    const summary = await deps.getObservabilitySummary!(windowMs);
    if (!summary) {
      send({ type: 'error', error: 'Observability summary unavailable', id });
      return;
    }
    send({ type: 'observability.summary', payload: summary, id });
  });
}

export async function handleObservabilityTraces(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  request: HandlerRequestContext,
): Promise<void> {
  if (!deps.listObservabilityTraces) {
    send({ type: 'error', error: 'Observability API not available', id });
    return;
  }
  const sessionId =
    typeof payload?.sessionId === 'string' && payload.sessionId.length > 0
      ? payload.sessionId
      : undefined;
  if (sessionId && !request.isSessionOwned(sessionId)) {
    send({ type: 'error', error: 'Not authorized for target session trace data', id });
    return;
  }
  await safeAsync(send, id, 'error', 'Failed to list observability traces', async () => {
    const traces = await deps.listObservabilityTraces!({
      limit:
        typeof payload?.limit === 'number' && Number.isFinite(payload.limit)
          ? payload.limit
          : undefined,
      offset:
        typeof payload?.offset === 'number' && Number.isFinite(payload.offset)
          ? payload.offset
          : undefined,
      search: typeof payload?.search === 'string' ? payload.search : undefined,
      status:
        payload?.status === 'open' ||
        payload?.status === 'completed' ||
        payload?.status === 'error' ||
        payload?.status === 'all'
          ? payload.status
          : undefined,
      sessionId,
    });
    send({ type: 'observability.traces', payload: traces ?? [], id });
  });
}

export async function handleObservabilityTrace(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  request: HandlerRequestContext,
): Promise<void> {
  if (!deps.getObservabilityTrace) {
    send({ type: 'error', error: 'Observability API not available', id });
    return;
  }
  const traceId = typeof payload?.traceId === 'string' ? payload.traceId.trim() : '';
  if (!traceId) {
    send({ type: 'error', error: 'Missing traceId in payload', id });
    return;
  }
  await safeAsync(send, id, 'error', 'Failed to inspect observability trace', async () => {
    const detail = await deps.getObservabilityTrace!(traceId);
    if (!detail) {
      send({ type: 'error', error: `Observability trace "${traceId}" not found`, id });
      return;
    }
    if (
      detail.summary.sessionId &&
      !request.isSessionOwned(detail.summary.sessionId)
    ) {
      send({ type: 'error', error: 'Not authorized for target session trace data', id });
      return;
    }
    send({ type: 'observability.trace', payload: detail, id });
  });
}

export async function handleObservabilityArtifact(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  request: HandlerRequestContext,
): Promise<void> {
  if (!deps.getObservabilityArtifact || !deps.getObservabilityTrace) {
    send({ type: 'error', error: 'Observability API not available', id });
    return;
  }
  const traceId = typeof payload?.traceId === 'string' ? payload.traceId.trim() : '';
  const path = typeof payload?.path === 'string' ? payload.path.trim() : '';
  if (!traceId || !path) {
    send({ type: 'error', error: 'Missing traceId or path in payload', id });
    return;
  }
  await safeAsync(send, id, 'error', 'Failed to read trace artifact', async () => {
    const detail = await deps.getObservabilityTrace!(traceId);
    if (!detail) {
      send({ type: 'error', error: `Observability trace "${traceId}" not found`, id });
      return;
    }
    if (
      detail.summary.sessionId &&
      !request.isSessionOwned(detail.summary.sessionId)
    ) {
      send({ type: 'error', error: 'Not authorized for target session trace data', id });
      return;
    }
    const allowed = detail.events.some((event) => event.artifact?.path === path);
    if (!allowed) {
      send({ type: 'error', error: 'Artifact does not belong to the requested trace', id });
      return;
    }
    const artifact = await deps.getObservabilityArtifact!(path);
    if (!artifact) {
      send({ type: 'error', error: `Trace artifact "${path}" not found`, id });
      return;
    }
    send({ type: 'observability.artifact', payload: artifact, id });
  });
}

export async function handleObservabilityLogs(
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  request: HandlerRequestContext,
): Promise<void> {
  if (!deps.getObservabilityLogTail || !deps.getObservabilityTrace) {
    send({ type: 'error', error: 'Observability API not available', id });
    return;
  }
  const traceId = typeof payload?.traceId === 'string' ? payload.traceId.trim() : '';
  if (!traceId) {
    send({ type: 'error', error: 'Missing traceId in payload', id });
    return;
  }
  const detail = await deps.getObservabilityTrace(traceId);
  if (!detail) {
    send({ type: 'error', error: `Observability trace "${traceId}" not found`, id });
    return;
  }
  if (
    detail.summary.sessionId &&
    !request.isSessionOwned(detail.summary.sessionId)
  ) {
    send({ type: 'error', error: 'Not authorized for target session trace data', id });
    return;
  }
  await safeAsync(send, id, 'error', 'Failed to read daemon logs', async () => {
    const logs = await deps.getObservabilityLogTail!({
      lines:
        typeof payload?.lines === 'number' && Number.isFinite(payload.lines)
          ? payload.lines
          : undefined,
      traceId,
    });
    if (!logs) {
      send({ type: 'error', error: 'Daemon logs unavailable', id });
      return;
    }
    send({ type: 'observability.logs', payload: logs, id });
  });
}

// ============================================================================
// Shared handler utilities
// ============================================================================

/** Wrap an async handler body in try/catch with consistent error response. */
async function safeAsync(
  send: SendFn,
  id: string | undefined,
  errorType: string,
  errorPrefix: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    send({ type: errorType, error: `${errorPrefix}: ${(err as Error).message}`, id });
  }
}

// ============================================================================
// Handler map
// ============================================================================

export type HandlerFn = (
  deps: WebChatDeps,
  payload: Record<string, unknown> | undefined,
  id: string | undefined,
  send: SendFn,
  request: HandlerRequestContext,
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
  'policy.simulate': handlePolicySimulate,
  'runs.list': handleRunsList,
  'run.inspect': handleRunInspect,
  'run.control': handleRunControl,
  'observability.summary': handleObservabilitySummary,
  'observability.traces': handleObservabilityTraces,
  'observability.trace': handleObservabilityTrace,
  'observability.artifact': handleObservabilityArtifact,
  'observability.logs': handleObservabilityLogs,
  'agents.list': handleAgentsList,
  'desktop.list': handleDesktopList,
  'desktop.create': handleDesktopCreate,
  'desktop.attach': handleDesktopAttach,
  'desktop.destroy': handleDesktopDestroy,
};
