/**
 * EventMonitor - Real-time subscription to AgenC protocol events
 *
 * Subscribes to all 17 protocol events via WebSocket and dispatches
 * to registered handlers.
 */

import { Connection, PublicKey, Logs } from '@solana/web3.js';
import { BorshCoder, EventParser, Program } from '@coral-xyz/anchor';
import type { Logger } from '../types/config';
import type {
  EventType,
  EventMap,
  EventHandler,
  EventHandlers,
  AgentRegisteredEvent,
  AgentUpdatedEvent,
  AgentDeregisteredEvent,
  TaskCreatedEvent,
  TaskClaimedEvent,
  TaskCompletedEvent,
  TaskCancelledEvent,
  StateUpdatedEvent,
  DisputeInitiatedEvent,
  DisputeVoteCastEvent,
  DisputeResolvedEvent,
  DisputeExpiredEvent,
  ProtocolInitializedEvent,
  RewardDistributedEvent,
  RateLimitHitEvent,
  MigrationCompletedEvent,
  ProtocolVersionUpdatedEvent,
} from '../types/events';

/**
 * Event filter configuration
 */
export interface EventFilter {
  /** Only events for specific task IDs */
  taskIds?: Buffer[];
  /** Only events for specific agent IDs */
  agentIds?: Buffer[];
  /** Only specific event types */
  eventTypes?: EventType[];
}

/**
 * EventMonitor configuration
 */
export interface EventMonitorConfig {
  /** Solana connection */
  connection: Connection;
  /** Program ID to monitor */
  programId: PublicKey;
  /** Program IDL for event parsing (optional) */
  idl?: object;
  /** Optional logger */
  logger?: Logger;
  /** Maximum reconnection attempts */
  maxReconnectAttempts?: number;
  /** Reconnection delay in ms */
  reconnectDelayMs?: number;
}

/**
 * EventMonitor handles WebSocket subscriptions to protocol events
 */
export class EventMonitor {
  private connection: Connection;
  private programId: PublicKey;
  private logger: Logger;
  private handlers: Map<EventType, Set<EventHandler<EventType>>> = new Map();
  private subscriptionId: number | null = null;
  private eventParser: EventParser | null = null;
  private filter: EventFilter | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts: number;
  private reconnectDelayMs: number;
  private isConnected = false;

  constructor(config: EventMonitorConfig) {
    this.connection = config.connection;
    this.programId = config.programId;
    this.logger = config.logger ?? console;
    this.maxReconnectAttempts = config.maxReconnectAttempts ?? 10;
    this.reconnectDelayMs = config.reconnectDelayMs ?? 1000;

    // Create event parser if IDL is provided
    if (config.idl) {
      this.eventParser = new EventParser(config.programId, new BorshCoder(config.idl as any));
    }

    // Initialize handler sets for all event types
    const eventTypes: EventType[] = [
      'agentRegistered',
      'agentUpdated',
      'agentDeregistered',
      'taskCreated',
      'taskClaimed',
      'taskCompleted',
      'taskCancelled',
      'stateUpdated',
      'disputeInitiated',
      'disputeVoteCast',
      'disputeResolved',
      'disputeExpired',
      'protocolInitialized',
      'rewardDistributed',
      'rateLimitHit',
      'migrationCompleted',
      'protocolVersionUpdated',
    ];

    for (const type of eventTypes) {
      this.handlers.set(type, new Set());
    }
  }

  /**
   * Start listening for events
   */
  async connect(): Promise<void> {
    if (this.isConnected) {
      this.logger.warn?.('EventMonitor already connected');
      return;
    }

    this.logger.info?.('Connecting to event stream');

    try {
      this.subscriptionId = this.connection.onLogs(
        this.programId,
        (logs) => this.handleLogs(logs),
        'confirmed'
      );

      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.logger.info?.('EventMonitor connected', { subscriptionId: this.subscriptionId });
    } catch (error) {
      this.logger.error?.('Failed to connect to event stream', { error });
      await this.handleReconnect();
    }
  }

  /**
   * Stop listening for events
   */
  async disconnect(): Promise<void> {
    if (!this.isConnected || this.subscriptionId === null) {
      return;
    }

    this.logger.info?.('Disconnecting from event stream');

    try {
      await this.connection.removeOnLogsListener(this.subscriptionId);
    } catch (error) {
      this.logger.warn?.('Error removing logs listener', { error });
    }

    this.subscriptionId = null;
    this.isConnected = false;
  }

  /**
   * Register an event handler
   */
  on<T extends EventType>(event: T, handler: EventHandler<T>): () => void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      handlers.add(handler as EventHandler<EventType>);
    }

    // Return unsubscribe function
    return () => this.off(event, handler);
  }

  /**
   * Unregister an event handler
   */
  off<T extends EventType>(event: T, handler: EventHandler<T>): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      handlers.delete(handler as EventHandler<EventType>);
    }
  }

  /**
   * Register a one-time event handler
   */
  once<T extends EventType>(event: T, handler: EventHandler<T>): void {
    const wrapper: EventHandler<T> = (data) => {
      this.off(event, wrapper);
      return handler(data);
    };
    this.on(event, wrapper);
  }

  /**
   * Register multiple handlers at once
   */
  registerHandlers(handlers: Partial<EventHandlers>): () => void {
    const unsubscribes: (() => void)[] = [];

    for (const [event, handler] of Object.entries(handlers)) {
      if (handler) {
        const unsub = this.on(event as EventType, handler as EventHandler<EventType>);
        unsubscribes.push(unsub);
      }
    }

    return () => {
      for (const unsub of unsubscribes) {
        unsub();
      }
    };
  }

  /**
   * Set event filter
   */
  setFilter(filter: EventFilter | null): void {
    this.filter = filter;
  }

  /**
   * Subscribe to events for specific tasks
   */
  subscribeToTasks(taskIds: Buffer[]): void {
    this.filter = {
      ...this.filter,
      taskIds,
    };
  }

  /**
   * Subscribe to events for specific agents
   */
  subscribeToAgents(agentIds: Buffer[]): void {
    this.filter = {
      ...this.filter,
      agentIds,
    };
  }

  /**
   * Check if connected
   */
  isActive(): boolean {
    return this.isConnected;
  }

  /**
   * Handle incoming logs
   */
  private handleLogs(logs: Logs): void {
    if (logs.err) {
      // Transaction failed, skip
      return;
    }

    if (!this.eventParser) {
      // No event parser available, skip
      return;
    }

    try {
      const events = this.eventParser.parseLogs(logs.logs);

      for (const event of events) {
        this.dispatchEvent(event.name, event.data);
      }
    } catch (error) {
      this.logger.debug?.('Failed to parse logs', { error, signature: logs.signature });
    }
  }

  /**
   * Dispatch event to handlers
   */
  private dispatchEvent(name: string, data: unknown): void {
    // Convert event name to camelCase (Anchor events are PascalCase)
    const eventType = this.toEventType(name);
    if (!eventType) {
      this.logger.debug?.('Unknown event type', { name });
      return;
    }

    // Parse event data
    const parsed = this.parseEventData(eventType, data);
    if (!parsed) {
      return;
    }

    // Apply filters
    if (!this.passesFilter(eventType, parsed)) {
      return;
    }

    // Dispatch to handlers
    const handlers = this.handlers.get(eventType);
    if (handlers) {
      for (const handler of handlers) {
        try {
          const result = handler(parsed as EventMap[typeof eventType]);
          if (result instanceof Promise) {
            result.catch((error) => {
              this.logger.error?.('Event handler error', { eventType, error });
            });
          }
        } catch (error) {
          this.logger.error?.('Event handler error', { eventType, error });
        }
      }
    }
  }

  /**
   * Convert Anchor event name to EventType
   */
  private toEventType(name: string): EventType | null {
    // Anchor events are PascalCase, we use camelCase
    const camelCase = name.charAt(0).toLowerCase() + name.slice(1);
    const validTypes: EventType[] = [
      'agentRegistered',
      'agentUpdated',
      'agentDeregistered',
      'taskCreated',
      'taskClaimed',
      'taskCompleted',
      'taskCancelled',
      'stateUpdated',
      'disputeInitiated',
      'disputeVoteCast',
      'disputeResolved',
      'disputeExpired',
      'protocolInitialized',
      'rewardDistributed',
      'rateLimitHit',
      'migrationCompleted',
      'protocolVersionUpdated',
    ];

    return validTypes.includes(camelCase as EventType) ? (camelCase as EventType) : null;
  }

  /**
   * Parse event data into typed structure
   */
  private parseEventData(eventType: EventType, data: unknown): EventMap[EventType] | null {
    try {
      const d = data as Record<string, unknown>;

      switch (eventType) {
        case 'agentRegistered':
          return {
            agentId: Buffer.from(d.agentId as number[]),
            authority: new PublicKey(d.authority as string),
            capabilities: BigInt((d.capabilities as { toString: () => string }).toString()),
            endpoint: d.endpoint as string,
            stake: BigInt((d.stake as { toString: () => string }).toString()),
            timestamp: (d.timestamp as { toNumber: () => number }).toNumber(),
          } as AgentRegisteredEvent;

        case 'agentUpdated':
          return {
            agentId: Buffer.from(d.agentId as number[]),
            capabilities: BigInt((d.capabilities as { toString: () => string }).toString()),
            status: d.status as number,
            endpoint: d.endpoint as string,
            timestamp: (d.timestamp as { toNumber: () => number }).toNumber(),
          } as AgentUpdatedEvent;

        case 'agentDeregistered':
          return {
            agentId: Buffer.from(d.agentId as number[]),
            authority: new PublicKey(d.authority as string),
            stakeReturned: BigInt((d.stakeReturned as { toString: () => string }).toString()),
            timestamp: (d.timestamp as { toNumber: () => number }).toNumber(),
          } as AgentDeregisteredEvent;

        case 'taskCreated':
          return {
            taskId: Buffer.from(d.taskId as number[]),
            creator: new PublicKey(d.creator as string),
            requiredCapabilities: BigInt((d.requiredCapabilities as { toString: () => string }).toString()),
            rewardAmount: BigInt((d.rewardAmount as { toString: () => string }).toString()),
            taskType: d.taskType as number,
            deadline: (d.deadline as { toNumber: () => number }).toNumber(),
            timestamp: (d.timestamp as { toNumber: () => number }).toNumber(),
          } as TaskCreatedEvent;

        case 'taskClaimed':
          return {
            taskId: Buffer.from(d.taskId as number[]),
            worker: new PublicKey(d.worker as string),
            currentWorkers: d.currentWorkers as number,
            maxWorkers: d.maxWorkers as number,
            timestamp: (d.timestamp as { toNumber: () => number }).toNumber(),
          } as TaskClaimedEvent;

        case 'taskCompleted':
          return {
            taskId: Buffer.from(d.taskId as number[]),
            worker: new PublicKey(d.worker as string),
            proofHash: Buffer.from(d.proofHash as number[]),
            rewardPaid: BigInt((d.rewardPaid as { toString: () => string }).toString()),
            timestamp: (d.timestamp as { toNumber: () => number }).toNumber(),
          } as TaskCompletedEvent;

        case 'taskCancelled':
          return {
            taskId: Buffer.from(d.taskId as number[]),
            creator: new PublicKey(d.creator as string),
            refundAmount: BigInt((d.refundAmount as { toString: () => string }).toString()),
            timestamp: (d.timestamp as { toNumber: () => number }).toNumber(),
          } as TaskCancelledEvent;

        case 'stateUpdated':
          return {
            stateKey: Buffer.from(d.stateKey as number[]),
            updater: new PublicKey(d.updater as string),
            version: BigInt((d.version as { toString: () => string }).toString()),
            timestamp: (d.timestamp as { toNumber: () => number }).toNumber(),
          } as StateUpdatedEvent;

        case 'disputeInitiated':
          return {
            disputeId: Buffer.from(d.disputeId as number[]),
            taskId: Buffer.from(d.taskId as number[]),
            initiator: new PublicKey(d.initiator as string),
            resolutionType: d.resolutionType as number,
            votingDeadline: (d.votingDeadline as { toNumber: () => number }).toNumber(),
            timestamp: (d.timestamp as { toNumber: () => number }).toNumber(),
          } as DisputeInitiatedEvent;

        case 'disputeVoteCast':
          return {
            disputeId: Buffer.from(d.disputeId as number[]),
            voter: new PublicKey(d.voter as string),
            approved: d.approved as boolean,
            votesFor: BigInt((d.votesFor as { toString: () => string }).toString()),
            votesAgainst: BigInt((d.votesAgainst as { toString: () => string }).toString()),
            timestamp: (d.timestamp as { toNumber: () => number }).toNumber(),
          } as DisputeVoteCastEvent;

        case 'disputeResolved':
          return {
            disputeId: Buffer.from(d.disputeId as number[]),
            taskId: Buffer.from(d.taskId as number[]),
            resolutionType: d.resolutionType as number,
            votesFor: BigInt((d.votesFor as { toString: () => string }).toString()),
            votesAgainst: BigInt((d.votesAgainst as { toString: () => string }).toString()),
            timestamp: (d.timestamp as { toNumber: () => number }).toNumber(),
          } as DisputeResolvedEvent;

        case 'disputeExpired':
          return {
            disputeId: Buffer.from(d.disputeId as number[]),
            taskId: Buffer.from(d.taskId as number[]),
            refundAmount: BigInt((d.refundAmount as { toString: () => string }).toString()),
            timestamp: (d.timestamp as { toNumber: () => number }).toNumber(),
          } as DisputeExpiredEvent;

        case 'protocolInitialized':
          return {
            authority: new PublicKey(d.authority as string),
            treasury: new PublicKey(d.treasury as string),
            disputeThreshold: d.disputeThreshold as number,
            protocolFeeBps: d.protocolFeeBps as number,
            timestamp: (d.timestamp as { toNumber: () => number }).toNumber(),
          } as ProtocolInitializedEvent;

        case 'rewardDistributed':
          return {
            taskId: Buffer.from(d.taskId as number[]),
            recipient: new PublicKey(d.recipient as string),
            amount: BigInt((d.amount as { toString: () => string }).toString()),
            protocolFee: BigInt((d.protocolFee as { toString: () => string }).toString()),
            timestamp: (d.timestamp as { toNumber: () => number }).toNumber(),
          } as RewardDistributedEvent;

        case 'rateLimitHit':
          return {
            agentId: Buffer.from(d.agentId as number[]),
            actionType: d.actionType as number,
            limitType: d.limitType as number,
            currentCount: d.currentCount as number,
            maxCount: d.maxCount as number,
            cooldownRemaining: (d.cooldownRemaining as { toNumber: () => number }).toNumber(),
            timestamp: (d.timestamp as { toNumber: () => number }).toNumber(),
          } as RateLimitHitEvent;

        case 'migrationCompleted':
          return {
            fromVersion: d.fromVersion as number,
            toVersion: d.toVersion as number,
            accountsMigrated: d.accountsMigrated as number,
            timestamp: (d.timestamp as { toNumber: () => number }).toNumber(),
          } as MigrationCompletedEvent;

        case 'protocolVersionUpdated':
          return {
            oldVersion: d.oldVersion as number,
            newVersion: d.newVersion as number,
            timestamp: (d.timestamp as { toNumber: () => number }).toNumber(),
          } as ProtocolVersionUpdatedEvent;

        default:
          return null;
      }
    } catch (error) {
      this.logger.debug?.('Failed to parse event data', { eventType, error });
      return null;
    }
  }

  /**
   * Check if event passes filter
   */
  private passesFilter(eventType: EventType, data: EventMap[EventType]): boolean {
    if (!this.filter) {
      return true;
    }

    // Check event type filter
    if (this.filter.eventTypes && !this.filter.eventTypes.includes(eventType)) {
      return false;
    }

    // Check task ID filter
    if (this.filter.taskIds && this.filter.taskIds.length > 0) {
      const taskId = (data as { taskId?: Buffer }).taskId;
      if (taskId && !this.filter.taskIds.some((id) => id.equals(taskId))) {
        return false;
      }
    }

    // Check agent ID filter
    if (this.filter.agentIds && this.filter.agentIds.length > 0) {
      const agentId = (data as { agentId?: Buffer }).agentId;
      if (agentId && !this.filter.agentIds.some((id) => id.equals(agentId))) {
        return false;
      }
    }

    return true;
  }

  /**
   * Handle reconnection
   */
  private async handleReconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error?.('Max reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1);

    this.logger.info?.('Attempting reconnection', {
      attempt: this.reconnectAttempts,
      maxAttempts: this.maxReconnectAttempts,
      delayMs: delay,
    });

    await new Promise((resolve) => setTimeout(resolve, delay));
    await this.connect();
  }
}
