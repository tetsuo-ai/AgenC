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

const SOLANA_NOT_CONFIGURED =
  'On-chain task operations require Solana connection — configure connection.rpcUrl in config';

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
  try {
    await sendTaskList(deps, id, send);
  } catch (err) {
    send({ type: 'error', error: `Failed to list tasks: ${(err as Error).message}`, id });
  }
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

    // Devnet program: 7 args (no constraintHash, minReputation, rewardMint)
    await program.methods
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
        creator: keypair.publicKey,
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
// Agents handlers — on-chain registered agents
// ============================================================================

/**
 * Agent account discriminator (first 8 bytes).
 * The struct contains variable-length Borsh strings (endpoint, metadata_uri)
 * so we parse sequentially rather than using fixed offsets.
 */
const AGENT_ACCT_DISCRIMINATOR = Buffer.from([130, 53, 100, 103, 121, 77, 148, 19]);

/** Parse minimal agent data from a raw Borsh-serialized account buffer. */
function parseRawAgentAccount(data: Buffer): {
  agentId: string;
  authority: string;
  capabilities: bigint;
  status: AgentStatus;
  reputation: number;
  tasksCompleted: bigint;
  stake: bigint;
} {
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
  off += 4 + endpointLen;

  // metadata_uri: Borsh String (u32 len prefix + variable bytes)
  const metadataUriLen = data.readUInt32LE(off);
  off += 4 + metadataUriLen;

  // registered_at: i64
  off += 8;

  // last_active: i64
  off += 8;

  // tasks_completed: u64
  const tasksCompleted = data.readBigUInt64LE(off);
  off += 8;

  // total_earned: u64
  off += 8;

  // reputation: u16
  const reputation = data.readUInt16LE(off);
  off += 2;

  // active_tasks: u8
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
        return {
          pda: acc.pubkey.toBase58(),
          agentId: agent.agentId,
          authority: agent.authority,
          capabilities: getCapabilityNames(agent.capabilities),
          status: agentStatusToString(agent.status),
          reputation: agent.reputation,
          tasksCompleted: Number(agent.tasksCompleted),
          stake: lamportsToSol(agent.stake),
        };
      } catch {
        // Skip accounts that fail to parse
        return null;
      }
    }).filter((a): a is NonNullable<typeof a> => a !== null);

    send({ type: 'agents.list', payload, id });
  } catch (err) {
    send({ type: 'error', error: `Failed to list agents: ${(err as Error).message}`, id });
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
  'agents.list': handleAgentsList,
};
