// src/runtime.ts
import { PublicKey as PublicKey6 } from "@solana/web3.js";
import { Program as Program2, AnchorProvider, Wallet } from "@coral-xyz/anchor";

// src/agent/manager.ts
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";

// src/types/config.ts
var Capability = {
  COMPUTE: 1n << 0n,
  INFERENCE: 1n << 1n,
  STORAGE: 1n << 2n,
  NETWORK: 1n << 3n,
  SENSOR: 1n << 4n,
  ACTUATOR: 1n << 5n,
  COORDINATOR: 1n << 6n,
  ARBITER: 1n << 7n,
  VALIDATOR: 1n << 8n,
  AGGREGATOR: 1n << 9n
};
var AgentStatus = /* @__PURE__ */ ((AgentStatus2) => {
  AgentStatus2[AgentStatus2["Inactive"] = 0] = "Inactive";
  AgentStatus2[AgentStatus2["Active"] = 1] = "Active";
  AgentStatus2[AgentStatus2["Busy"] = 2] = "Busy";
  AgentStatus2[AgentStatus2["Suspended"] = 3] = "Suspended";
  return AgentStatus2;
})(AgentStatus || {});
var TaskType = /* @__PURE__ */ ((TaskType3) => {
  TaskType3[TaskType3["Exclusive"] = 0] = "Exclusive";
  TaskType3[TaskType3["Collaborative"] = 1] = "Collaborative";
  TaskType3[TaskType3["Competitive"] = 2] = "Competitive";
  return TaskType3;
})(TaskType || {});
var TaskStatus = /* @__PURE__ */ ((TaskStatus3) => {
  TaskStatus3[TaskStatus3["Open"] = 0] = "Open";
  TaskStatus3[TaskStatus3["InProgress"] = 1] = "InProgress";
  TaskStatus3[TaskStatus3["PendingValidation"] = 2] = "PendingValidation";
  TaskStatus3[TaskStatus3["Completed"] = 3] = "Completed";
  TaskStatus3[TaskStatus3["Cancelled"] = 4] = "Cancelled";
  TaskStatus3[TaskStatus3["Disputed"] = 5] = "Disputed";
  return TaskStatus3;
})(TaskStatus || {});

// src/agent/manager.ts
var AgentManager = class {
  connection;
  wallet;
  program;
  agentId;
  logger;
  state = null;
  protocolPda;
  agentPda;
  protocolConfig = null;
  constructor(config) {
    this.connection = config.connection;
    this.wallet = config.wallet;
    this.program = config.program;
    this.agentId = config.agentId;
    this.logger = config.logger ?? console;
    const [protocolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("protocol")],
      config.program.programId
    );
    this.protocolPda = protocolPda;
    const [agentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), config.agentId],
      config.program.programId
    );
    this.agentPda = agentPda;
  }
  /**
   * Get the agent ID
   */
  getAgentId() {
    return this.agentId;
  }
  /**
   * Get the agent PDA
   */
  getAgentPda() {
    return this.agentPda;
  }
  /**
   * Get current agent state
   */
  getState() {
    return this.state;
  }
  /**
   * Check if agent is registered
   */
  isRegistered() {
    return this.state?.registered ?? false;
  }
  /**
   * Register agent on-chain
   */
  async register(config) {
    try {
      const existing = await this.fetchAgentAccount(this.agentPda);
      if (existing) {
        this.logger.info?.("Agent already registered", { agentId: this.agentId.toString("hex") });
        this.state = existing;
        return existing;
      }
    } catch {
    }
    this.logger.info?.("Registering agent", {
      agentId: this.agentId.toString("hex"),
      capabilities: config.capabilities.toString()
    });
    const stake = config.initialStake ?? 0n;
    await this.program.methods.registerAgent(
      Array.from(this.agentId),
      new BN(config.capabilities.toString()),
      config.endpoint ?? "",
      null,
      // delegatedSigner
      new BN(stake.toString())
    ).accountsPartial({
      agent: this.agentPda,
      protocolConfig: this.protocolPda,
      authority: this.wallet.publicKey,
      systemProgram: SystemProgram.programId
    }).signers([this.wallet]).rpc();
    this.state = await this.fetchAgentAccount(this.agentPda);
    if (!this.state) {
      throw new Error("Failed to fetch agent state after registration");
    }
    this.logger.info?.("Agent registered successfully", { pda: this.agentPda.toBase58() });
    return this.state;
  }
  /**
   * Deregister agent from protocol
   */
  async deregister() {
    if (!this.state) {
      throw new Error("Agent not registered");
    }
    if (this.state.activeTasks > 0) {
      throw new Error("Cannot deregister with active tasks");
    }
    this.logger.info?.("Deregistering agent", { agentId: this.state.agentId.toString("hex") });
    const stakeToReturn = this.state.stake;
    await this.program.methods.deregisterAgent().accountsPartial({
      agent: this.state.pda,
      protocolConfig: this.protocolPda,
      authority: this.wallet.publicKey,
      systemProgram: SystemProgram.programId
    }).signers([this.wallet]).rpc();
    this.logger.info?.("Agent deregistered", { stakeReturned: stakeToReturn.toString() });
    this.state = null;
    return stakeToReturn;
  }
  /**
   * Update agent status
   */
  async updateStatus(status) {
    if (!this.state) {
      throw new Error("Agent not registered");
    }
    this.logger.debug?.("Updating agent status", {
      from: AgentStatus[this.state.status],
      to: AgentStatus[status]
    });
    await this.program.methods.updateAgent(
      new BN(this.state.capabilities.toString()),
      status,
      this.state.endpoint,
      this.state.metadataUri
    ).accountsPartial({
      agent: this.state.pda,
      authority: this.wallet.publicKey
    }).signers([this.wallet]).rpc();
    this.state.status = status;
  }
  /**
   * Update agent capabilities
   */
  async updateCapabilities(capabilities) {
    if (!this.state) {
      throw new Error("Agent not registered");
    }
    this.logger.debug?.("Updating agent capabilities", {
      old: this.state.capabilities.toString(),
      new: capabilities.toString()
    });
    await this.program.methods.updateAgent(
      new BN(capabilities.toString()),
      this.state.status,
      this.state.endpoint,
      this.state.metadataUri
    ).accountsPartial({
      agent: this.state.pda,
      authority: this.wallet.publicKey
    }).signers([this.wallet]).rpc();
    this.state.capabilities = capabilities;
  }
  /**
   * Update agent endpoint
   */
  async updateEndpoint(endpoint) {
    if (!this.state) {
      throw new Error("Agent not registered");
    }
    if (endpoint.length > 128) {
      throw new Error("Endpoint must be <= 128 characters");
    }
    await this.program.methods.updateAgent(
      new BN(this.state.capabilities.toString()),
      this.state.status,
      endpoint,
      this.state.metadataUri
    ).accountsPartial({
      agent: this.state.pda,
      authority: this.wallet.publicKey
    }).signers([this.wallet]).rpc();
    this.state.endpoint = endpoint;
  }
  /**
   * Refresh agent state from on-chain
   */
  async refresh() {
    if (!this.state) {
      throw new Error("Agent not registered");
    }
    const updated = await this.fetchAgentAccount(this.state.pda);
    if (!updated) {
      throw new Error("Agent account not found");
    }
    this.state = updated;
    return this.state;
  }
  /**
   * Check if agent is rate limited for task creation
   */
  isRateLimited() {
    if (!this.state || !this.protocolConfig) {
      return false;
    }
    const now = Math.floor(Date.now() / 1e3);
    if (this.protocolConfig.taskCreationCooldown > 0) {
      const cooldownEnds = this.state.lastTaskCreated + this.protocolConfig.taskCreationCooldown;
      if (now < cooldownEnds) {
        return true;
      }
    }
    if (this.protocolConfig.maxTasksPer24h > 0) {
      const windowExpired = now - this.state.rateLimitWindowStart >= 86400;
      if (!windowExpired && this.state.taskCount24h >= this.protocolConfig.maxTasksPer24h) {
        return true;
      }
    }
    return false;
  }
  /**
   * Get rate limit budget
   */
  getRateLimitBudget() {
    if (!this.state || !this.protocolConfig) {
      return { tasksRemaining: 0, cooldownEnds: 0 };
    }
    const now = Math.floor(Date.now() / 1e3);
    let cooldownEnds = 0;
    if (this.protocolConfig.taskCreationCooldown > 0 && this.state.lastTaskCreated > 0) {
      cooldownEnds = this.state.lastTaskCreated + this.protocolConfig.taskCreationCooldown;
      if (cooldownEnds < now) cooldownEnds = 0;
    }
    let tasksRemaining = this.protocolConfig.maxTasksPer24h;
    if (this.protocolConfig.maxTasksPer24h > 0) {
      const windowExpired = now - this.state.rateLimitWindowStart >= 86400;
      if (!windowExpired) {
        tasksRemaining = Math.max(0, this.protocolConfig.maxTasksPer24h - this.state.taskCount24h);
      }
    }
    return { tasksRemaining, cooldownEnds };
  }
  /**
   * Load protocol configuration
   */
  async loadProtocolConfig() {
    try {
      const accounts = this.program.account;
      const config = await accounts["protocolConfig"].fetch(this.protocolPda);
      this.protocolConfig = {
        taskCreationCooldown: config.taskCreationCooldown.toNumber(),
        maxTasksPer24h: config.maxTasksPer24h,
        disputeInitiationCooldown: config.disputeInitiationCooldown.toNumber(),
        maxDisputesPer24h: config.maxDisputesPer24h
      };
      this.logger.debug?.("Loaded protocol config", this.protocolConfig);
    } catch (error) {
      this.logger.warn?.("Failed to load protocol config", { error });
    }
  }
  /**
   * Get agent's reputation score
   */
  getReputation() {
    return this.state?.reputation ?? 0;
  }
  /**
   * Get agent PDA
   */
  getPda() {
    return this.state?.pda ?? null;
  }
  /**
   * Fetch and parse agent account
   */
  async fetchAgentAccount(pda) {
    try {
      const accounts = this.program.account;
      const account = await accounts["agentRegistration"].fetch(pda);
      const status = account.status.inactive !== void 0 ? 0 /* Inactive */ : account.status.active !== void 0 ? 1 /* Active */ : account.status.busy !== void 0 ? 2 /* Busy */ : 3 /* Suspended */;
      return {
        pda,
        agentId: Buffer.from(account.agentId),
        authority: account.authority,
        capabilities: BigInt(account.capabilities.toString()),
        status,
        endpoint: account.endpoint,
        metadataUri: account.metadataUri,
        registeredAt: account.registeredAt.toNumber(),
        lastActive: account.lastActive.toNumber(),
        tasksCompleted: account.tasksCompleted.toNumber(),
        totalEarned: BigInt(account.totalEarned.toString()),
        reputation: account.reputation,
        activeTasks: account.activeTasks,
        stake: BigInt(account.stake.toString()),
        registered: true,
        lastTaskCreated: account.lastTaskCreated.toNumber(),
        lastDisputeInitiated: account.lastDisputeInitiated.toNumber(),
        taskCount24h: account.taskCount24h,
        disputeCount24h: account.disputeCount24h,
        rateLimitWindowStart: account.rateLimitWindowStart.toNumber()
      };
    } catch {
      return null;
    }
  }
};

// src/events/monitor.ts
import { PublicKey as PublicKey2 } from "@solana/web3.js";
import { BorshCoder, EventParser } from "@coral-xyz/anchor";
var EventMonitor = class {
  connection;
  programId;
  logger;
  handlers = /* @__PURE__ */ new Map();
  subscriptionId = null;
  eventParser = null;
  filter = null;
  reconnectAttempts = 0;
  maxReconnectAttempts;
  reconnectDelayMs;
  isConnected = false;
  constructor(config) {
    this.connection = config.connection;
    this.programId = config.programId;
    this.logger = config.logger ?? console;
    this.maxReconnectAttempts = config.maxReconnectAttempts ?? 10;
    this.reconnectDelayMs = config.reconnectDelayMs ?? 1e3;
    if (config.idl) {
      this.eventParser = new EventParser(config.programId, new BorshCoder(config.idl));
    }
    const eventTypes = [
      "agentRegistered",
      "agentUpdated",
      "agentDeregistered",
      "taskCreated",
      "taskClaimed",
      "taskCompleted",
      "taskCancelled",
      "stateUpdated",
      "disputeInitiated",
      "disputeVoteCast",
      "disputeResolved",
      "disputeExpired",
      "protocolInitialized",
      "rewardDistributed",
      "rateLimitHit",
      "migrationCompleted",
      "protocolVersionUpdated"
    ];
    for (const type of eventTypes) {
      this.handlers.set(type, /* @__PURE__ */ new Set());
    }
  }
  /**
   * Start listening for events
   */
  async connect() {
    if (this.isConnected) {
      this.logger.warn?.("EventMonitor already connected");
      return;
    }
    this.logger.info?.("Connecting to event stream");
    try {
      this.subscriptionId = this.connection.onLogs(
        this.programId,
        (logs) => this.handleLogs(logs),
        "confirmed"
      );
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.logger.info?.("EventMonitor connected", { subscriptionId: this.subscriptionId });
    } catch (error) {
      this.logger.error?.("Failed to connect to event stream", { error });
      await this.handleReconnect();
    }
  }
  /**
   * Stop listening for events
   */
  async disconnect() {
    if (!this.isConnected || this.subscriptionId === null) {
      return;
    }
    this.logger.info?.("Disconnecting from event stream");
    try {
      await this.connection.removeOnLogsListener(this.subscriptionId);
    } catch (error) {
      this.logger.warn?.("Error removing logs listener", { error });
    }
    this.subscriptionId = null;
    this.isConnected = false;
  }
  /**
   * Register an event handler
   */
  on(event, handler) {
    const handlers = this.handlers.get(event);
    if (handlers) {
      handlers.add(handler);
    }
    return () => this.off(event, handler);
  }
  /**
   * Unregister an event handler
   */
  off(event, handler) {
    const handlers = this.handlers.get(event);
    if (handlers) {
      handlers.delete(handler);
    }
  }
  /**
   * Register a one-time event handler
   */
  once(event, handler) {
    const wrapper = (data) => {
      this.off(event, wrapper);
      return handler(data);
    };
    this.on(event, wrapper);
  }
  /**
   * Register multiple handlers at once
   */
  registerHandlers(handlers) {
    const unsubscribes = [];
    for (const [event, handler] of Object.entries(handlers)) {
      if (handler) {
        const unsub = this.on(event, handler);
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
  setFilter(filter) {
    this.filter = filter;
  }
  /**
   * Subscribe to events for specific tasks
   */
  subscribeToTasks(taskIds) {
    this.filter = {
      ...this.filter,
      taskIds
    };
  }
  /**
   * Subscribe to events for specific agents
   */
  subscribeToAgents(agentIds) {
    this.filter = {
      ...this.filter,
      agentIds
    };
  }
  /**
   * Check if connected
   */
  isActive() {
    return this.isConnected;
  }
  /**
   * Handle incoming logs
   */
  handleLogs(logs) {
    if (logs.err) {
      return;
    }
    if (!this.eventParser) {
      return;
    }
    try {
      const events = this.eventParser.parseLogs(logs.logs);
      for (const event of events) {
        this.dispatchEvent(event.name, event.data);
      }
    } catch (error) {
      this.logger.debug?.("Failed to parse logs", { error, signature: logs.signature });
    }
  }
  /**
   * Dispatch event to handlers
   */
  dispatchEvent(name, data) {
    const eventType = this.toEventType(name);
    if (!eventType) {
      this.logger.debug?.("Unknown event type", { name });
      return;
    }
    const parsed = this.parseEventData(eventType, data);
    if (!parsed) {
      return;
    }
    if (!this.passesFilter(eventType, parsed)) {
      return;
    }
    const handlers = this.handlers.get(eventType);
    if (handlers) {
      for (const handler of handlers) {
        try {
          const result = handler(parsed);
          if (result instanceof Promise) {
            result.catch((error) => {
              this.logger.error?.("Event handler error", { eventType, error });
            });
          }
        } catch (error) {
          this.logger.error?.("Event handler error", { eventType, error });
        }
      }
    }
  }
  /**
   * Convert Anchor event name to EventType
   */
  toEventType(name) {
    const camelCase = name.charAt(0).toLowerCase() + name.slice(1);
    const validTypes = [
      "agentRegistered",
      "agentUpdated",
      "agentDeregistered",
      "taskCreated",
      "taskClaimed",
      "taskCompleted",
      "taskCancelled",
      "stateUpdated",
      "disputeInitiated",
      "disputeVoteCast",
      "disputeResolved",
      "disputeExpired",
      "protocolInitialized",
      "rewardDistributed",
      "rateLimitHit",
      "migrationCompleted",
      "protocolVersionUpdated"
    ];
    return validTypes.includes(camelCase) ? camelCase : null;
  }
  /**
   * Parse event data into typed structure
   */
  parseEventData(eventType, data) {
    try {
      const d = data;
      switch (eventType) {
        case "agentRegistered":
          return {
            agentId: Buffer.from(d.agentId),
            authority: new PublicKey2(d.authority),
            capabilities: BigInt(d.capabilities.toString()),
            endpoint: d.endpoint,
            stake: BigInt(d.stake.toString()),
            timestamp: d.timestamp.toNumber()
          };
        case "agentUpdated":
          return {
            agentId: Buffer.from(d.agentId),
            capabilities: BigInt(d.capabilities.toString()),
            status: d.status,
            endpoint: d.endpoint,
            timestamp: d.timestamp.toNumber()
          };
        case "agentDeregistered":
          return {
            agentId: Buffer.from(d.agentId),
            authority: new PublicKey2(d.authority),
            stakeReturned: BigInt(d.stakeReturned.toString()),
            timestamp: d.timestamp.toNumber()
          };
        case "taskCreated":
          return {
            taskId: Buffer.from(d.taskId),
            creator: new PublicKey2(d.creator),
            requiredCapabilities: BigInt(d.requiredCapabilities.toString()),
            rewardAmount: BigInt(d.rewardAmount.toString()),
            taskType: d.taskType,
            deadline: d.deadline.toNumber(),
            timestamp: d.timestamp.toNumber()
          };
        case "taskClaimed":
          return {
            taskId: Buffer.from(d.taskId),
            worker: new PublicKey2(d.worker),
            currentWorkers: d.currentWorkers,
            maxWorkers: d.maxWorkers,
            timestamp: d.timestamp.toNumber()
          };
        case "taskCompleted":
          return {
            taskId: Buffer.from(d.taskId),
            worker: new PublicKey2(d.worker),
            proofHash: Buffer.from(d.proofHash),
            rewardPaid: BigInt(d.rewardPaid.toString()),
            timestamp: d.timestamp.toNumber()
          };
        case "taskCancelled":
          return {
            taskId: Buffer.from(d.taskId),
            creator: new PublicKey2(d.creator),
            refundAmount: BigInt(d.refundAmount.toString()),
            timestamp: d.timestamp.toNumber()
          };
        case "stateUpdated":
          return {
            stateKey: Buffer.from(d.stateKey),
            updater: new PublicKey2(d.updater),
            version: BigInt(d.version.toString()),
            timestamp: d.timestamp.toNumber()
          };
        case "disputeInitiated":
          return {
            disputeId: Buffer.from(d.disputeId),
            taskId: Buffer.from(d.taskId),
            initiator: new PublicKey2(d.initiator),
            resolutionType: d.resolutionType,
            votingDeadline: d.votingDeadline.toNumber(),
            timestamp: d.timestamp.toNumber()
          };
        case "disputeVoteCast":
          return {
            disputeId: Buffer.from(d.disputeId),
            voter: new PublicKey2(d.voter),
            approved: d.approved,
            votesFor: BigInt(d.votesFor.toString()),
            votesAgainst: BigInt(d.votesAgainst.toString()),
            timestamp: d.timestamp.toNumber()
          };
        case "disputeResolved":
          return {
            disputeId: Buffer.from(d.disputeId),
            taskId: Buffer.from(d.taskId),
            resolutionType: d.resolutionType,
            votesFor: BigInt(d.votesFor.toString()),
            votesAgainst: BigInt(d.votesAgainst.toString()),
            timestamp: d.timestamp.toNumber()
          };
        case "disputeExpired":
          return {
            disputeId: Buffer.from(d.disputeId),
            taskId: Buffer.from(d.taskId),
            refundAmount: BigInt(d.refundAmount.toString()),
            timestamp: d.timestamp.toNumber()
          };
        case "protocolInitialized":
          return {
            authority: new PublicKey2(d.authority),
            treasury: new PublicKey2(d.treasury),
            disputeThreshold: d.disputeThreshold,
            protocolFeeBps: d.protocolFeeBps,
            timestamp: d.timestamp.toNumber()
          };
        case "rewardDistributed":
          return {
            taskId: Buffer.from(d.taskId),
            recipient: new PublicKey2(d.recipient),
            amount: BigInt(d.amount.toString()),
            protocolFee: BigInt(d.protocolFee.toString()),
            timestamp: d.timestamp.toNumber()
          };
        case "rateLimitHit":
          return {
            agentId: Buffer.from(d.agentId),
            actionType: d.actionType,
            limitType: d.limitType,
            currentCount: d.currentCount,
            maxCount: d.maxCount,
            cooldownRemaining: d.cooldownRemaining.toNumber(),
            timestamp: d.timestamp.toNumber()
          };
        case "migrationCompleted":
          return {
            fromVersion: d.fromVersion,
            toVersion: d.toVersion,
            accountsMigrated: d.accountsMigrated,
            timestamp: d.timestamp.toNumber()
          };
        case "protocolVersionUpdated":
          return {
            oldVersion: d.oldVersion,
            newVersion: d.newVersion,
            timestamp: d.timestamp.toNumber()
          };
        default:
          return null;
      }
    } catch (error) {
      this.logger.debug?.("Failed to parse event data", { eventType, error });
      return null;
    }
  }
  /**
   * Check if event passes filter
   */
  passesFilter(eventType, data) {
    if (!this.filter) {
      return true;
    }
    if (this.filter.eventTypes && !this.filter.eventTypes.includes(eventType)) {
      return false;
    }
    if (this.filter.taskIds && this.filter.taskIds.length > 0) {
      const taskId = data.taskId;
      if (taskId && !this.filter.taskIds.some((id) => id.equals(taskId))) {
        return false;
      }
    }
    if (this.filter.agentIds && this.filter.agentIds.length > 0) {
      const agentId = data.agentId;
      if (agentId && !this.filter.agentIds.some((id) => id.equals(agentId))) {
        return false;
      }
    }
    return true;
  }
  /**
   * Handle reconnection
   */
  async handleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error?.("Max reconnection attempts reached");
      return;
    }
    this.reconnectAttempts++;
    const delay = this.reconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1);
    this.logger.info?.("Attempting reconnection", {
      attempt: this.reconnectAttempts,
      maxAttempts: this.maxReconnectAttempts,
      delayMs: delay
    });
    await new Promise((resolve) => setTimeout(resolve, delay));
    await this.connect();
  }
};

// src/task/executor.ts
import { PublicKey as PublicKey3, SystemProgram as SystemProgram2 } from "@solana/web3.js";

// src/types/task.ts
var ExecutorState = /* @__PURE__ */ ((ExecutorState2) => {
  ExecutorState2["Idle"] = "idle";
  ExecutorState2["Discovering"] = "discovering";
  ExecutorState2["Evaluating"] = "evaluating";
  ExecutorState2["Claiming"] = "claiming";
  ExecutorState2["Executing"] = "executing";
  ExecutorState2["Proving"] = "proving";
  ExecutorState2["Submitting"] = "submitting";
  ExecutorState2["Error"] = "error";
  return ExecutorState2;
})(ExecutorState || {});
var Evaluators = {
  /**
   * Maximize reward amount
   */
  rewardMaximizer: {
    evaluate: async (task) => {
      return Number(task.rewardAmount);
    }
  },
  /**
   * Prefer urgent tasks (close to deadline)
   */
  urgencyEvaluator: {
    evaluate: async (task, ctx) => {
      if (task.deadline === 0) return 50;
      const timeLeft = task.deadline - ctx.timestamp;
      if (timeLeft < 0) return null;
      return Math.max(0, 100 - timeLeft / 3600);
    }
  },
  /**
   * Balanced evaluator considering reward and urgency
   */
  balanced: {
    evaluate: async (task, ctx) => {
      const rewardSol = Number(task.rewardAmount) / 1e9;
      const rewardScore = Math.min(70, rewardSol * 10);
      let urgencyScore = 15;
      if (task.deadline > 0) {
        const hoursLeft = (task.deadline - ctx.timestamp) / 3600;
        if (hoursLeft < 0) return null;
        urgencyScore = Math.min(30, Math.max(0, 30 - hoursLeft));
      }
      return rewardScore + urgencyScore;
    }
  },
  /**
   * Accept all tasks (no filtering)
   */
  acceptAll: {
    evaluate: async () => 1
  }
};

// src/task/executor.ts
var DEFAULT_OPTIONS = {
  evaluator: Evaluators.balanced,
  filter: {},
  maxConcurrentTasks: 1,
  pollInterval: 5e3,
  taskTimeout: 3e5,
  // 5 minutes
  retryAttempts: 3,
  retryBaseDelayMs: 1e3,
  autoClaim: false
};
var TaskExecutor = class {
  connection;
  wallet;
  program;
  agentPda;
  agentManager;
  logger;
  options;
  state = "idle" /* Idle */;
  activeTasks = /* @__PURE__ */ new Map();
  taskHandler = null;
  _pollInterval = null;
  isRunning = false;
  listeners = [];
  protocolPda;
  // Stats
  completedCount = 0;
  failedCount = 0;
  pendingCount = 0;
  constructor(config) {
    this.connection = config.connection;
    this.wallet = config.wallet;
    this.program = config.program;
    this.agentPda = config.agentPda;
    this.agentManager = config.agentManager ?? null;
    this.logger = config.logger ?? console;
    this.options = {
      evaluator: config.evaluator ?? DEFAULT_OPTIONS.evaluator,
      filter: config.filter ?? DEFAULT_OPTIONS.filter,
      maxConcurrentTasks: config.maxConcurrentTasks ?? DEFAULT_OPTIONS.maxConcurrentTasks,
      pollInterval: config.pollInterval ?? DEFAULT_OPTIONS.pollInterval,
      taskTimeout: config.taskTimeout ?? DEFAULT_OPTIONS.taskTimeout,
      retryAttempts: config.retryAttempts ?? DEFAULT_OPTIONS.retryAttempts,
      retryBaseDelayMs: config.retryBaseDelayMs ?? DEFAULT_OPTIONS.retryBaseDelayMs,
      autoClaim: config.autoClaim ?? DEFAULT_OPTIONS.autoClaim
    };
    const [protocolPda] = PublicKey3.findProgramAddressSync(
      [Buffer.from("protocol")],
      config.program.programId
    );
    this.protocolPda = protocolPda;
  }
  /**
   * Set the task evaluator
   */
  setEvaluator(evaluator) {
    this.options.evaluator = evaluator;
  }
  /**
   * Get executor statistics
   */
  getStats() {
    return {
      pending: this.pendingCount,
      executing: this.activeTasks.size,
      completed: this.completedCount,
      failed: this.failedCount
    };
  }
  /**
   * Create a default agent state when agentManager is not available
   */
  createDefaultAgentState() {
    return {
      pda: this.agentPda,
      agentId: Buffer.alloc(32),
      authority: this.wallet.publicKey,
      capabilities: 0n,
      status: 1 /* Active */,
      endpoint: "",
      metadataUri: "",
      stake: 0n,
      activeTasks: 0,
      tasksCompleted: 0,
      totalEarned: 0n,
      reputation: 0,
      registered: true,
      registeredAt: Date.now(),
      lastActive: Date.now(),
      lastTaskCreated: 0,
      lastDisputeInitiated: 0,
      taskCount24h: 0,
      disputeCount24h: 0,
      rateLimitWindowStart: 0
    };
  }
  /**
   * Register task handler
   */
  onTask(handler) {
    this.taskHandler = handler;
  }
  /**
   * Register event listener
   */
  on(listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
  /**
   * Start the executor
   */
  async start() {
    if (this.isRunning) {
      throw new Error("TaskExecutor already running");
    }
    if (!this.taskHandler) {
      throw new Error("No task handler registered. Call onTask() first.");
    }
    const agentState = this.agentManager?.getState() ?? this.createDefaultAgentState();
    if (!agentState?.registered) {
      throw new Error("Agent not registered");
    }
    this.isRunning = true;
    this.emit({
      type: "started",
      agentId: agentState.agentId,
      mode: "autonomous",
      timestamp: Date.now()
    });
    this.logger.info("TaskExecutor started", { pollIntervalMs: this.options.pollInterval });
    this._pollInterval = setInterval(
      () => this.poll().catch((e) => this.handleError(e)),
      this.options.pollInterval
    );
    await this.poll().catch((e) => this.handleError(e));
  }
  /**
   * Stop the executor
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }
    this.logger.info("Stopping TaskExecutor");
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
    for (const [taskId, { abortController }] of this.activeTasks) {
      this.logger.warn("Aborting active task", { taskId });
      abortController.abort();
    }
    this.isRunning = false;
    this.state = "idle" /* Idle */;
    const agentState = this.agentManager?.getState() ?? this.createDefaultAgentState();
    this.emit({
      type: "stopped",
      agentId: agentState?.agentId ?? Buffer.alloc(32),
      completedCount: 0,
      // TODO: track this
      failedCount: 0,
      timestamp: Date.now()
    });
  }
  /**
   * Get current executor state
   */
  getState() {
    return this.state;
  }
  /**
   * Get active task count
   */
  getActiveTaskCount() {
    return this.activeTasks.size;
  }
  /**
   * Poll for available tasks
   */
  async poll() {
    if (!this.isRunning) return;
    if (this.activeTasks.size >= this.options.maxConcurrentTasks) {
      return;
    }
    if (this.agentManager?.isRateLimited() ?? false) {
      this.logger.debug("Rate limited, skipping poll");
      return;
    }
    this.state = "discovering" /* Discovering */;
    try {
      const tasks = await this.discoverTasks();
      if (tasks.length === 0) {
        this.state = "idle" /* Idle */;
        return;
      }
      this.state = "evaluating" /* Evaluating */;
      const selected = await this.selectBestTask(tasks);
      if (!selected) {
        this.state = "idle" /* Idle */;
        return;
      }
      this.emit({
        type: "taskFound",
        taskId: selected.taskId,
        rewardAmount: selected.rewardAmount,
        deadline: selected.deadline
      });
      if (this.options.autoClaim) {
        await this.claimAndExecute(selected);
      }
    } catch (error) {
      this.state = "error" /* Error */;
      throw error;
    }
  }
  /**
   * Discover available tasks
   */
  async discoverTasks() {
    const agentState = this.agentManager?.getState() ?? this.createDefaultAgentState();
    if (!agentState) {
      return [];
    }
    const accounts = this.program.account;
    const taskAccounts = await accounts["task"].all([
      {
        memcmp: {
          offset: 8 + 32 + 32 + 8 + 64 + 32 + 8 + 1 + 1,
          // offset to status field
          bytes: Buffer.from([0]).toString("base64")
          // TaskStatus::Open = 0
        }
      }
    ]);
    const tasks = [];
    for (const { publicKey, account } of taskAccounts) {
      const task = this.parseTask(publicKey, account);
      if ((task.requiredCapabilities & agentState.capabilities) !== task.requiredCapabilities) {
        continue;
      }
      if (!this.matchesFilter(task)) {
        continue;
      }
      if (this.activeTasks.has(task.taskId.toString("hex"))) {
        continue;
      }
      tasks.push(task);
    }
    this.logger.debug("Discovered tasks", { count: tasks.length });
    return tasks;
  }
  /**
   * Select the best task based on evaluator
   */
  async selectBestTask(tasks) {
    const agentState = this.agentManager?.getState() ?? this.createDefaultAgentState();
    if (!agentState) {
      return null;
    }
    const context = {
      agent: agentState,
      recentTasks: [],
      // TODO: get from memory store
      timestamp: Math.floor(Date.now() / 1e3),
      activeTaskCount: this.activeTasks.size,
      rateLimitBudget: this.agentManager?.getRateLimitBudget() ?? { tasksRemaining: 100, cooldownEnds: 0 }
    };
    let bestTask = null;
    let bestScore = -Infinity;
    for (const task of tasks) {
      const score = await this.options.evaluator.evaluate(task, context);
      if (score !== null && score > bestScore) {
        bestScore = score;
        bestTask = task;
      }
    }
    if (bestTask) {
      this.logger.debug("Selected task", {
        taskId: bestTask.taskId.toString("hex"),
        score: bestScore,
        reward: bestTask.rewardAmount.toString()
      });
    }
    return bestTask;
  }
  /**
   * Claim and execute a task
   */
  async claimAndExecute(task) {
    if (!this.taskHandler) {
      throw new Error("No task handler registered");
    }
    const agentState = this.agentManager?.getState() ?? this.createDefaultAgentState();
    if (!agentState) {
      throw new Error("Agent not registered");
    }
    const taskIdHex = task.taskId.toString("hex");
    this.state = "claiming" /* Claiming */;
    const claim = await this.claimTask(task, agentState);
    this.emit({
      type: "taskClaimed",
      taskId: task.taskId,
      claimPda: claim.address
    });
    const abortController = new AbortController();
    this.activeTasks.set(taskIdHex, { task, claim, abortController });
    this.state = "executing" /* Executing */;
    this.emit({
      type: "taskExecuting",
      taskId: task.taskId,
      startedAt: Date.now()
    });
    try {
      const result = await this.executeWithRetry(task, claim, agentState, abortController.signal);
      this.state = "submitting" /* Submitting */;
      const txSignature = await this.submitCompletion(task, claim, result);
      this.emit({
        type: "taskCompleted",
        taskId: task.taskId,
        txSignature,
        rewardPaid: task.rewardAmount
        // TODO: get actual from event
      });
      this.logger.info("Task completed", { taskId: taskIdHex, txSignature });
    } catch (error) {
      this.emit({
        type: "taskFailed",
        taskId: task.taskId,
        error
      });
      throw error;
    } finally {
      this.activeTasks.delete(taskIdHex);
      this.state = "idle" /* Idle */;
    }
  }
  /**
   * Claim a task on-chain
   */
  async claimTask(task, agentState) {
    this.logger.debug("Claiming task", { taskId: task.taskId.toString("hex") });
    const [claimPda] = PublicKey3.findProgramAddressSync(
      [Buffer.from("claim"), task.address.toBuffer(), agentState.pda.toBuffer()],
      this.program.programId
    );
    await this.program.methods.claimTask().accountsPartial({
      task: task.address,
      claim: claimPda,
      worker: agentState.pda,
      protocolConfig: this.protocolPda,
      authority: this.wallet.publicKey,
      systemProgram: SystemProgram2.programId
    }).signers([this.wallet]).rpc();
    const accounts = this.program.account;
    const claimAccount = await accounts["taskClaim"].fetch(claimPda);
    return this.parseClaim(claimPda, claimAccount);
  }
  /**
   * Execute task handler with retry logic
   */
  async executeWithRetry(task, claim, agentState, signal) {
    let lastError = null;
    for (let attempt = 0; attempt < this.options.retryAttempts; attempt++) {
      if (signal.aborted) {
        throw new Error("Task execution aborted");
      }
      try {
        const context = {
          agent: agentState,
          claim,
          log: this.logger,
          signal
        };
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error("Task execution timeout")), this.options.taskTimeout);
        });
        const result = await Promise.race([
          this.taskHandler(task, context),
          timeoutPromise
        ]);
        return result;
      } catch (error) {
        lastError = error;
        this.logger.warn("Task execution failed, retrying", {
          taskId: task.taskId.toString("hex"),
          attempt: attempt + 1,
          maxAttempts: this.options.retryAttempts,
          error: lastError.message
        });
        if (attempt < this.options.retryAttempts - 1) {
          const delay = this.options.retryBaseDelayMs * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError;
  }
  /**
   * Submit task completion on-chain
   */
  async submitCompletion(task, claim, result) {
    const agentState = this.agentManager?.getState() ?? this.createDefaultAgentState();
    if (!agentState) {
      throw new Error("Agent not registered");
    }
    const isPrivate = task.constraintHash !== null && !task.constraintHash.every((b) => b === 0);
    if (isPrivate) {
      throw new Error(
        "Private task completion requires ZK proof generation. Use ProofEngine to generate proof first."
      );
    }
    const [escrowPda] = PublicKey3.findProgramAddressSync(
      [Buffer.from("escrow"), task.address.toBuffer()],
      this.program.programId
    );
    const accounts = this.program.account;
    const protocolConfig = await accounts["protocolConfig"].fetch(this.protocolPda);
    const treasury = protocolConfig.treasury;
    const resultHash = result.resultData ?? Buffer.alloc(32);
    const resultData = result.resultData ?? Buffer.alloc(64);
    const txSignature = await this.program.methods.completeTask(Array.from(resultHash.subarray(0, 32)), Array.from(resultData.subarray(0, 64))).accountsPartial({
      task: task.address,
      claim: claim.address,
      escrow: escrowPda,
      worker: agentState.pda,
      protocolConfig: this.protocolPda,
      treasury,
      authority: this.wallet.publicKey,
      systemProgram: SystemProgram2.programId
    }).signers([this.wallet]).rpc();
    return txSignature;
  }
  /**
   * Check if task matches filter
   */
  matchesFilter(task) {
    const f = this.options.filter;
    if (f.minReward !== void 0 && task.rewardAmount < f.minReward) {
      return false;
    }
    if (f.maxReward !== void 0 && task.rewardAmount > f.maxReward) {
      return false;
    }
    if (f.taskTypes && !f.taskTypes.includes(task.taskType)) {
      return false;
    }
    if (f.maxDeadline !== void 0 && task.deadline > 0 && task.deadline > f.maxDeadline) {
      return false;
    }
    if (f.minDeadline !== void 0 && task.deadline > 0 && task.deadline < f.minDeadline) {
      return false;
    }
    const hasConstraint = task.constraintHash !== null && !task.constraintHash.every((b) => b === 0);
    if (f.privateOnly && !hasConstraint) {
      return false;
    }
    if (f.publicOnly && hasConstraint) {
      return false;
    }
    if (f.custom && !f.custom(task)) {
      return false;
    }
    return true;
  }
  /**
   * Parse task account to OnChainTask
   */
  parseTask(address, account) {
    const a = account;
    const status = a.status.open !== void 0 ? 0 : a.status.inProgress !== void 0 ? 1 : a.status.pendingValidation !== void 0 ? 2 : a.status.completed !== void 0 ? 3 : a.status.cancelled !== void 0 ? 4 : 5;
    const taskType = a.taskType.exclusive !== void 0 ? 0 : a.taskType.collaborative !== void 0 ? 1 : 2;
    const constraintHash = Buffer.from(a.constraintHash);
    const hasConstraint = !constraintHash.every((b) => b === 0);
    return {
      address,
      taskId: Buffer.from(a.taskId),
      creator: a.creator,
      requiredCapabilities: BigInt(a.requiredCapabilities.toString()),
      description: Buffer.from(a.description),
      constraintHash: hasConstraint ? constraintHash : null,
      rewardAmount: BigInt(a.rewardAmount.toString()),
      maxWorkers: a.maxWorkers,
      currentWorkers: a.currentWorkers,
      status,
      taskType,
      createdAt: a.createdAt.toNumber(),
      deadline: a.deadline.toNumber(),
      completedAt: a.completedAt.toNumber(),
      escrow: a.escrow,
      result: Buffer.from(a.result),
      completions: a.completions,
      requiredCompletions: a.requiredCompletions
    };
  }
  /**
   * Parse claim account to TaskClaim
   */
  parseClaim(address, account) {
    const a = account;
    return {
      address,
      task: a.task,
      worker: a.worker,
      claimedAt: a.claimedAt.toNumber(),
      expiresAt: a.expiresAt.toNumber(),
      completedAt: a.completedAt.toNumber(),
      proofHash: Buffer.from(a.proofHash),
      resultData: Buffer.from(a.resultData),
      isCompleted: a.isCompleted,
      isValidated: a.isValidated,
      rewardPaid: BigInt(a.rewardPaid.toString())
    };
  }
  /**
   * Emit runtime event
   */
  emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error("Event listener error", { error });
      }
    }
  }
  /**
   * Handle error
   */
  handleError(error) {
    this.logger.error("TaskExecutor error", { error: error.message });
    this.emit({ type: "error", error, context: "TaskExecutor" });
    this.state = "idle" /* Idle */;
  }
};

// src/tools/registry.ts
var ToolRegistry = class {
  tools = /* @__PURE__ */ new Map();
  config;
  activeExecutions = 0;
  constructor(config = {}) {
    this.config = {
      sandbox: config.sandbox ?? { enabled: false },
      defaultTimeout: config.defaultTimeout ?? 3e4,
      maxConcurrent: config.maxConcurrent ?? 10
    };
  }
  /**
   * Register a tool
   */
  register(tool) {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool '${tool.name}' is already registered`);
    }
    this.validateTool(tool);
    this.tools.set(tool.name, {
      ...tool,
      registeredAt: Date.now(),
      executionCount: 0,
      totalExecutionTime: 0
    });
  }
  /**
   * Register multiple tools at once
   */
  registerAll(tools) {
    for (const tool of tools) {
      this.register(tool);
    }
  }
  /**
   * Unregister a tool
   */
  unregister(name) {
    return this.tools.delete(name);
  }
  /**
   * Get a tool by name
   */
  get(name) {
    const registered = this.tools.get(name);
    if (!registered) return void 0;
    const { registeredAt, executionCount, totalExecutionTime, lastError, ...tool } = registered;
    return tool;
  }
  /**
   * Check if a tool exists
   */
  has(name) {
    return this.tools.has(name);
  }
  /**
   * List all registered tools
   */
  list() {
    return Array.from(this.tools.values()).map(
      ({ registeredAt, executionCount, totalExecutionTime, lastError, ...tool }) => tool
    );
  }
  /**
   * Get tools in MCP format
   */
  toMCPFormat() {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: "object",
        properties: tool.inputSchema.properties,
        required: tool.inputSchema.required
      }
    }));
  }
  /**
   * Execute a tool call
   */
  async execute(call) {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return {
        toolCallId: call.id,
        success: false,
        error: `Tool '${call.name}' not found`
      };
    }
    if (this.activeExecutions >= this.config.maxConcurrent) {
      return {
        toolCallId: call.id,
        success: false,
        error: "Too many concurrent tool executions"
      };
    }
    this.activeExecutions++;
    const startTime = Date.now();
    try {
      const validationError = this.validateInput(tool, call.input);
      if (validationError) {
        return {
          toolCallId: call.id,
          success: false,
          error: validationError
        };
      }
      const result = await this.executeWithTimeout(
        tool,
        call.input,
        this.config.defaultTimeout
      );
      tool.executionCount++;
      tool.totalExecutionTime += Date.now() - startTime;
      return {
        toolCallId: call.id,
        success: true,
        output: result
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      tool.lastError = errorMessage;
      return {
        toolCallId: call.id,
        success: false,
        error: errorMessage
      };
    } finally {
      this.activeExecutions--;
    }
  }
  /**
   * Execute multiple tool calls
   */
  async executeAll(calls) {
    return Promise.all(calls.map((call) => this.execute(call)));
  }
  /**
   * Get tool statistics
   */
  getStats(name) {
    const tool = this.tools.get(name);
    if (!tool) return void 0;
    return {
      executionCount: tool.executionCount,
      avgExecutionTime: tool.executionCount > 0 ? tool.totalExecutionTime / tool.executionCount : 0,
      lastError: tool.lastError
    };
  }
  /**
   * Clear all registered tools
   */
  clear() {
    this.tools.clear();
  }
  /**
   * Validate a tool definition
   */
  validateTool(tool) {
    if (!tool.name || typeof tool.name !== "string") {
      throw new Error("Tool must have a valid name");
    }
    if (!tool.description || typeof tool.description !== "string") {
      throw new Error("Tool must have a valid description");
    }
    if (typeof tool.execute !== "function") {
      throw new Error("Tool must have an execute function");
    }
    if (!tool.inputSchema || typeof tool.inputSchema !== "object") {
      throw new Error("Tool must have a valid inputSchema");
    }
  }
  /**
   * Validate input against tool schema
   */
  validateInput(tool, input) {
    if (typeof input !== "object" || input === null) {
      return "Input must be an object";
    }
    const inputObj = input;
    const required = tool.inputSchema.required ?? [];
    for (const field of required) {
      if (!(field in inputObj)) {
        return `Missing required field: ${field}`;
      }
    }
    return null;
  }
  /**
   * Execute a tool with timeout
   */
  async executeWithTimeout(tool, input, timeout) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Tool execution timed out after ${timeout}ms`));
      }, timeout);
      Promise.resolve(tool.execute(input)).then((result) => {
        clearTimeout(timeoutId);
        resolve(result);
      }).catch((error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
    });
  }
};

// src/tools/builtin/index.ts
var httpFetch = {
  name: "http_fetch",
  description: "Make HTTP requests to external APIs",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch"
      },
      method: {
        type: "string",
        enum: ["GET", "POST", "PUT", "DELETE", "PATCH"],
        description: "HTTP method"
      },
      headers: {
        type: "object",
        description: "Request headers"
      },
      body: {
        type: "string",
        description: "Request body (for POST/PUT/PATCH)"
      },
      timeout: {
        type: "number",
        description: "Request timeout in milliseconds"
      }
    },
    required: ["url"]
  },
  execute: async (input) => {
    const { url, method = "GET", headers = {}, body, timeout = 3e4 } = input;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? body : void 0,
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      const contentType = response.headers.get("content-type") ?? "";
      let data;
      if (contentType.includes("application/json")) {
        data = await response.json();
      } else {
        data = await response.text();
      }
      const responseHeaders = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      return {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        data
      };
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }
};
var jsonParse = {
  name: "json_parse",
  description: "Parse a JSON string into an object",
  inputSchema: {
    type: "object",
    properties: {
      json: {
        type: "string",
        description: "The JSON string to parse"
      }
    },
    required: ["json"]
  },
  execute: async (input) => {
    const { json } = input;
    return JSON.parse(json);
  }
};
var jsonStringify = {
  name: "json_stringify",
  description: "Convert an object to a JSON string",
  inputSchema: {
    type: "object",
    properties: {
      data: {
        type: "object",
        description: "The data to stringify"
      },
      pretty: {
        type: "boolean",
        description: "Whether to format with indentation"
      }
    },
    required: ["data"]
  },
  execute: async (input) => {
    const { data, pretty = false } = input;
    return JSON.stringify(data, null, pretty ? 2 : void 0);
  }
};
var base64Encode = {
  name: "base64_encode",
  description: "Encode a string to base64",
  inputSchema: {
    type: "object",
    properties: {
      data: {
        type: "string",
        description: "The string to encode"
      }
    },
    required: ["data"]
  },
  execute: async (input) => {
    const { data } = input;
    return Buffer.from(data).toString("base64");
  }
};
var base64Decode = {
  name: "base64_decode",
  description: "Decode a base64 string",
  inputSchema: {
    type: "object",
    properties: {
      data: {
        type: "string",
        description: "The base64 string to decode"
      }
    },
    required: ["data"]
  },
  execute: async (input) => {
    const { data } = input;
    return Buffer.from(data, "base64").toString("utf-8");
  }
};
var computeHash = {
  name: "compute_hash",
  description: "Compute a hash of the input data",
  inputSchema: {
    type: "object",
    properties: {
      data: {
        type: "string",
        description: "The data to hash"
      },
      algorithm: {
        type: "string",
        enum: ["sha256", "sha512", "sha1", "md5"],
        description: "Hash algorithm to use"
      }
    },
    required: ["data"]
  },
  execute: async (input) => {
    const { data, algorithm = "sha256" } = input;
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const algorithmMap = {
      sha256: "SHA-256",
      sha512: "SHA-512",
      sha1: "SHA-1",
      md5: "MD5"
      // Note: MD5 may not be supported in all environments
    };
    const hashBuffer = await crypto.subtle.digest(
      algorithmMap[algorithm] ?? "SHA-256",
      dataBuffer
    );
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }
};
var randomNumber = {
  name: "random_number",
  description: "Generate a random number",
  inputSchema: {
    type: "object",
    properties: {
      min: {
        type: "number",
        description: "Minimum value (inclusive)"
      },
      max: {
        type: "number",
        description: "Maximum value (inclusive)"
      },
      integer: {
        type: "boolean",
        description: "Whether to return an integer"
      }
    },
    required: []
  },
  execute: async (input) => {
    const { min = 0, max = 1, integer = false } = input;
    const value = Math.random() * (max - min) + min;
    return integer ? Math.floor(value) : value;
  }
};
var currentTime = {
  name: "current_time",
  description: "Get the current timestamp",
  inputSchema: {
    type: "object",
    properties: {
      format: {
        type: "string",
        enum: ["unix", "unix_ms", "iso", "utc"],
        description: "Output format"
      }
    },
    required: []
  },
  execute: async (input) => {
    const { format = "unix" } = input;
    const now = /* @__PURE__ */ new Date();
    switch (format) {
      case "unix":
        return Math.floor(now.getTime() / 1e3);
      case "unix_ms":
        return now.getTime();
      case "iso":
        return now.toISOString();
      case "utc":
        return now.toUTCString();
      default:
        return now.getTime();
    }
  }
};
var sleep = {
  name: "sleep",
  description: "Wait for a specified duration",
  inputSchema: {
    type: "object",
    properties: {
      ms: {
        type: "number",
        description: "Duration to wait in milliseconds"
      }
    },
    required: ["ms"]
  },
  execute: async (input) => {
    const { ms } = input;
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { slept: ms };
  }
};
var builtinTools = [
  httpFetch,
  jsonParse,
  jsonStringify,
  base64Encode,
  base64Decode,
  computeHash,
  randomNumber,
  currentTime,
  sleep
];

// src/memory/store.ts
var DefaultMemoryStore = class {
  backend;
  summarizer;
  constructor(config) {
    this.backend = config.backend;
    this.summarizer = config.summarizer;
  }
  // === Conversation ===
  async addMessage(message) {
    await this.backend.addMessage(message);
  }
  async getMessages(limit) {
    return this.backend.getMessages(limit);
  }
  async summarize() {
    const messages = await this.getMessages();
    if (messages.length === 0) {
      return "";
    }
    if (this.summarizer) {
      return this.summarizer.summarize(messages);
    }
    const roleCount = {};
    let totalLength = 0;
    for (const msg of messages) {
      roleCount[msg.role] = (roleCount[msg.role] || 0) + 1;
      totalLength += msg.content.length;
    }
    return `Conversation with ${messages.length} messages (${Object.entries(roleCount).map(([r, c]) => `${c} ${r}`).join(", ")}). Total length: ${totalLength} characters.`;
  }
  async clearConversation() {
    await this.backend.clearConversation();
  }
  // === Task Context ===
  async setCurrentTask(task) {
    await this.backend.setCurrentTask(task);
  }
  async getCurrentTask() {
    return this.backend.getCurrentTask();
  }
  async addTaskResult(taskId, taskAddress, result, txSignature, rewardReceived) {
    const entry = {
      taskId,
      taskAddress,
      result,
      txSignature,
      completedAt: Date.now(),
      rewardReceived
    };
    await this.backend.addTaskResult(entry);
  }
  async getTaskHistory(limit) {
    return this.backend.getTaskHistory(limit);
  }
  async getTaskResult(taskId) {
    return this.backend.getTaskResult(taskId);
  }
  // === Key-Value Store ===
  async set(namespace, key, value) {
    await this.backend.set(namespace, key, value);
  }
  async get(namespace, key) {
    return this.backend.get(namespace, key);
  }
  async delete(namespace, key) {
    await this.backend.delete(namespace, key);
  }
  async keys(namespace) {
    return this.backend.keys(namespace);
  }
  // === Persistence ===
  async save() {
    await this.backend.save();
  }
  async load() {
    await this.backend.load();
  }
  async clear() {
    await this.backend.clear();
  }
  // === Stats ===
  async getStats() {
    const messages = await this.getMessages();
    const taskHistory = await this.getTaskHistory();
    let totalChars = 0;
    for (const msg of messages) {
      totalChars += msg.content.length;
    }
    const tokenCount = Math.ceil(totalChars / 4);
    const sizeBytes = JSON.stringify({ messages, taskHistory }).length;
    return {
      messageCount: messages.length,
      tokenCount,
      taskHistoryCount: taskHistory.length,
      sizeBytes
    };
  }
};

// src/memory/backends/inmemory.ts
var InMemoryBackend = class {
  messages = [];
  currentTask = null;
  taskHistory = [];
  kvStore = /* @__PURE__ */ new Map();
  maxMessages;
  maxTaskHistory;
  constructor(config = {}) {
    this.maxMessages = config.maxMessages ?? 1e3;
    this.maxTaskHistory = config.maxTaskHistory ?? 100;
  }
  // === Conversation ===
  async addMessage(message) {
    this.messages.push(message);
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages);
    }
  }
  async getMessages(limit) {
    if (limit === void 0) {
      return [...this.messages];
    }
    return this.messages.slice(-limit);
  }
  async clearConversation() {
    this.messages = [];
  }
  // === Task Context ===
  async setCurrentTask(task) {
    this.currentTask = task;
  }
  async getCurrentTask() {
    return this.currentTask;
  }
  async addTaskResult(entry) {
    this.taskHistory.push(entry);
    if (this.taskHistory.length > this.maxTaskHistory) {
      this.taskHistory = this.taskHistory.slice(-this.maxTaskHistory);
    }
  }
  async getTaskHistory(limit) {
    if (limit === void 0) {
      return [...this.taskHistory];
    }
    return this.taskHistory.slice(-limit);
  }
  async getTaskResult(taskId) {
    const taskIdHex = taskId.toString("hex");
    return this.taskHistory.find(
      (entry) => entry.taskId.toString("hex") === taskIdHex
    ) ?? null;
  }
  // === Key-Value Store ===
  async set(namespace, key, value) {
    if (!this.kvStore.has(namespace)) {
      this.kvStore.set(namespace, /* @__PURE__ */ new Map());
    }
    this.kvStore.get(namespace).set(key, value);
  }
  async get(namespace, key) {
    const ns = this.kvStore.get(namespace);
    if (!ns) return null;
    return ns.get(key) ?? null;
  }
  async delete(namespace, key) {
    const ns = this.kvStore.get(namespace);
    if (ns) {
      ns.delete(key);
    }
  }
  async keys(namespace) {
    const ns = this.kvStore.get(namespace);
    if (!ns) return [];
    return Array.from(ns.keys());
  }
  // === Persistence (no-op for in-memory) ===
  async save() {
  }
  async load() {
  }
  async clear() {
    this.messages = [];
    this.currentTask = null;
    this.taskHistory = [];
    this.kvStore.clear();
  }
  // === Utilities ===
  /**
   * Export all data (for debugging or migration)
   */
  export() {
    const kvStoreObj = {};
    for (const [ns, map] of this.kvStore.entries()) {
      kvStoreObj[ns] = Object.fromEntries(map.entries());
    }
    return {
      messages: [...this.messages],
      currentTask: this.currentTask,
      taskHistory: [...this.taskHistory],
      kvStore: kvStoreObj
    };
  }
  /**
   * Import data (for debugging or migration)
   */
  import(data) {
    if (data.messages) {
      this.messages = [...data.messages];
    }
    if (data.currentTask !== void 0) {
      this.currentTask = data.currentTask;
    }
    if (data.taskHistory) {
      this.taskHistory = [...data.taskHistory];
    }
    if (data.kvStore) {
      this.kvStore.clear();
      for (const [ns, obj] of Object.entries(data.kvStore)) {
        this.kvStore.set(ns, new Map(Object.entries(obj)));
      }
    }
  }
};

// src/memory/backends/file.ts
import { promises as fs } from "fs";
import * as path from "path";
import { PublicKey as PublicKey4 } from "@solana/web3.js";
var FileBackend = class {
  messages = [];
  currentTask = null;
  taskHistory = [];
  kvStore = /* @__PURE__ */ new Map();
  directory;
  maxMessages;
  maxTaskHistory;
  autoSave;
  dirty = false;
  constructor(config) {
    this.directory = config.directory;
    this.maxMessages = config.maxMessages ?? 1e3;
    this.maxTaskHistory = config.maxTaskHistory ?? 100;
    this.autoSave = config.autoSave ?? false;
  }
  get filePath() {
    return path.join(this.directory, "memory.json");
  }
  async maybeSave() {
    if (this.autoSave && this.dirty) {
      await this.save();
    }
  }
  // === Conversation ===
  async addMessage(message) {
    this.messages.push(message);
    this.dirty = true;
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages);
    }
    await this.maybeSave();
  }
  async getMessages(limit) {
    if (limit === void 0) {
      return [...this.messages];
    }
    return this.messages.slice(-limit);
  }
  async clearConversation() {
    this.messages = [];
    this.dirty = true;
    await this.maybeSave();
  }
  // === Task Context ===
  async setCurrentTask(task) {
    this.currentTask = task;
    this.dirty = true;
    await this.maybeSave();
  }
  async getCurrentTask() {
    return this.currentTask;
  }
  async addTaskResult(entry) {
    this.taskHistory.push(entry);
    this.dirty = true;
    if (this.taskHistory.length > this.maxTaskHistory) {
      this.taskHistory = this.taskHistory.slice(-this.maxTaskHistory);
    }
    await this.maybeSave();
  }
  async getTaskHistory(limit) {
    if (limit === void 0) {
      return [...this.taskHistory];
    }
    return this.taskHistory.slice(-limit);
  }
  async getTaskResult(taskId) {
    const taskIdHex = taskId.toString("hex");
    return this.taskHistory.find(
      (entry) => entry.taskId.toString("hex") === taskIdHex
    ) ?? null;
  }
  // === Key-Value Store ===
  async set(namespace, key, value) {
    if (!this.kvStore.has(namespace)) {
      this.kvStore.set(namespace, /* @__PURE__ */ new Map());
    }
    this.kvStore.get(namespace).set(key, value);
    this.dirty = true;
    await this.maybeSave();
  }
  async get(namespace, key) {
    const ns = this.kvStore.get(namespace);
    if (!ns) return null;
    return ns.get(key) ?? null;
  }
  async delete(namespace, key) {
    const ns = this.kvStore.get(namespace);
    if (ns) {
      ns.delete(key);
      this.dirty = true;
      await this.maybeSave();
    }
  }
  async keys(namespace) {
    const ns = this.kvStore.get(namespace);
    if (!ns) return [];
    return Array.from(ns.keys());
  }
  // === Persistence ===
  async save() {
    const kvStoreObj = {};
    for (const [ns, map] of this.kvStore.entries()) {
      kvStoreObj[ns] = Object.fromEntries(map.entries());
    }
    const serializableTaskHistory = this.taskHistory.map((entry) => ({
      ...entry,
      taskId: entry.taskId.toString("hex"),
      taskAddress: entry.taskAddress.toBase58(),
      rewardReceived: entry.rewardReceived.toString()
    }));
    let serializableCurrentTask = null;
    if (this.currentTask) {
      serializableCurrentTask = {
        ...this.currentTask,
        address: this.currentTask.address.toBase58(),
        taskId: this.currentTask.taskId.toString("hex"),
        creator: this.currentTask.creator.toBase58(),
        escrow: this.currentTask.escrow.toBase58(),
        rewardAmount: this.currentTask.rewardAmount.toString(),
        requiredCapabilities: this.currentTask.requiredCapabilities.toString(),
        description: this.currentTask.description.toString("hex"),
        constraintHash: this.currentTask.constraintHash?.toString("hex") ?? null,
        result: this.currentTask.result.toString("hex")
      };
    }
    const data = {
      messages: this.messages,
      currentTask: serializableCurrentTask,
      taskHistory: serializableTaskHistory,
      kvStore: kvStoreObj
    };
    await fs.mkdir(this.directory, { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), "utf-8");
    this.dirty = false;
  }
  async load() {
    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      const data = JSON.parse(content);
      this.messages = data.messages ?? [];
      this.taskHistory = (data.taskHistory ?? []).map((entry) => ({
        ...entry,
        taskId: Buffer.from(entry.taskId, "hex"),
        taskAddress: new PublicKey4(entry.taskAddress),
        rewardReceived: BigInt(entry.rewardReceived)
      }));
      if (data.currentTask) {
        this.currentTask = data.currentTask;
      } else {
        this.currentTask = null;
      }
      this.kvStore.clear();
      if (data.kvStore) {
        for (const [ns, obj] of Object.entries(data.kvStore)) {
          this.kvStore.set(ns, new Map(Object.entries(obj)));
        }
      }
      this.dirty = false;
    } catch (error) {
      this.messages = [];
      this.currentTask = null;
      this.taskHistory = [];
      this.kvStore.clear();
      this.dirty = false;
    }
  }
  async clear() {
    this.messages = [];
    this.currentTask = null;
    this.taskHistory = [];
    this.kvStore.clear();
    this.dirty = true;
    try {
      await fs.unlink(this.filePath);
    } catch {
    }
  }
};

// src/proof/engine.ts
var FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
function generateSalt() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let salt = 0n;
  for (const byte of bytes) {
    salt = salt << 8n | BigInt(byte);
  }
  return salt % FIELD_MODULUS;
}
var ProofEngine = class {
  config;
  cache = /* @__PURE__ */ new Map();
  pendingCount = 0;
  completedCount = 0;
  failedCount = 0;
  totalGenerationTime = 0;
  toolsAvailable = null;
  constructor(config = {}) {
    this.config = {
      circuitPath: config.circuitPath ?? "./circuits/task_completion",
      hashHelperPath: config.hashHelperPath ?? "./circuits/hash_helper",
      cacheProofs: config.cacheProofs ?? true,
      maxCacheSize: config.maxCacheSize ?? 100,
      timeout: config.timeout ?? 3e5
    };
  }
  /**
   * Check if required tools (nargo, sunspot) are available
   */
  async checkTools() {
    if (this.toolsAvailable) {
      return this.toolsAvailable;
    }
    const sdk = await import("@agenc/sdk");
    const status = sdk.checkToolsAvailable();
    this.toolsAvailable = status;
    return status;
  }
  /**
   * Require tools to be available, throws with installation instructions if not
   */
  async requireTools() {
    const { requireTools } = await import("@agenc/sdk");
    requireTools(true);
  }
  /**
   * Generate a ZK proof for task completion
   */
  async generateProof(request) {
    const salt = request.salt ?? generateSalt();
    const cacheKey = this.getCacheKey(request, salt);
    if (this.config.cacheProofs) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return { ...cached.proof, cached: true };
      }
    }
    this.pendingCount++;
    try {
      const { generateProof } = await import("@agenc/sdk");
      const result = await generateProof({
        taskPda: request.taskPda,
        agentPubkey: request.agentPubkey,
        output: request.output,
        salt,
        circuitPath: this.config.circuitPath,
        hashHelperPath: this.config.hashHelperPath
      });
      const output = {
        proof: result.proof,
        publicWitness: result.publicWitness,
        constraintHash: result.constraintHash,
        outputCommitment: result.outputCommitment,
        expectedBinding: result.expectedBinding,
        proofSize: result.proofSize,
        generationTime: result.generationTime,
        cached: false
      };
      this.completedCount++;
      this.totalGenerationTime += result.generationTime;
      if (this.config.cacheProofs) {
        this.addToCache(cacheKey, output);
      }
      return output;
    } catch (error) {
      this.failedCount++;
      throw error;
    } finally {
      this.pendingCount--;
    }
  }
  /**
   * Verify a proof locally
   */
  async verifyProof(proof, publicWitness) {
    const { verifyProofLocally } = await import("@agenc/sdk");
    return verifyProofLocally(proof, publicWitness, this.config.circuitPath);
  }
  /**
   * Compute hashes via the hash_helper circuit
   */
  async computeHashes(taskPda, agentPubkey, output, salt) {
    const { computeHashesViaNargo } = await import("@agenc/sdk");
    return computeHashesViaNargo(
      taskPda,
      agentPubkey,
      output,
      salt,
      this.config.hashHelperPath
    );
  }
  /**
   * Get proof generation status
   */
  getStatus() {
    return {
      pending: this.pendingCount,
      completed: this.completedCount,
      failed: this.failedCount,
      totalGenerationTime: this.totalGenerationTime,
      averageGenerationTime: this.completedCount > 0 ? this.totalGenerationTime / this.completedCount : 0
    };
  }
  /**
   * Clear the proof cache
   */
  clearCache() {
    this.cache.clear();
  }
  /**
   * Get cache statistics
   */
  getCacheStats() {
    return {
      size: this.cache.size,
      maxSize: this.config.maxCacheSize
    };
  }
  getCacheKey(request, salt) {
    return [
      request.taskPda.toBase58(),
      request.agentPubkey.toBase58(),
      request.output.map((o) => o.toString()).join(","),
      salt.toString()
    ].join(":");
  }
  addToCache(key, proof) {
    while (this.cache.size >= this.config.maxCacheSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, {
      proof,
      createdAt: Date.now()
    });
  }
};
function createProofEngine(config) {
  return new ProofEngine(config);
}

// src/dispute/handler.ts
import { PublicKey as PublicKey5, SystemProgram as SystemProgram3 } from "@solana/web3.js";
var DisputeStatus = /* @__PURE__ */ ((DisputeStatus2) => {
  DisputeStatus2["Active"] = "active";
  DisputeStatus2["Resolved"] = "resolved";
  DisputeStatus2["Expired"] = "expired";
  return DisputeStatus2;
})(DisputeStatus || {});
var ResolutionType = /* @__PURE__ */ ((ResolutionType2) => {
  ResolutionType2[ResolutionType2["RefundCreator"] = 0] = "RefundCreator";
  ResolutionType2[ResolutionType2["PayWorker"] = 1] = "PayWorker";
  ResolutionType2[ResolutionType2["Split"] = 2] = "Split";
  ResolutionType2[ResolutionType2["Arbitration"] = 3] = "Arbitration";
  return ResolutionType2;
})(ResolutionType || {});
var DisputeHandler = class {
  connection;
  program;
  wallet;
  agentPda;
  activeDisputes = /* @__PURE__ */ new Map();
  voteRecords = /* @__PURE__ */ new Map();
  stats = {
    initiated: 0,
    votedOn: 0,
    resolved: 0,
    expired: 0,
    wonAsInitiator: 0,
    lostAsInitiator: 0
  };
  eventHandlers = {};
  constructor(config) {
    this.connection = config.connection;
    this.program = config.program;
    this.wallet = config.wallet;
    this.agentPda = config.agentPda;
  }
  /**
   * Set event handlers
   */
  setEventHandlers(handlers) {
    this.eventHandlers = { ...this.eventHandlers, ...handlers };
  }
  /**
   * Initiate a dispute for a task
   */
  async initiateDispute(taskPda, resolutionType, evidence) {
    const disputeId = this.generateDisputeId();
    const [disputePda] = PublicKey5.findProgramAddressSync(
      [Buffer.from("dispute"), disputeId],
      this.program.programId
    );
    const [protocolPda] = PublicKey5.findProgramAddressSync(
      [Buffer.from("protocol")],
      this.program.programId
    );
    try {
      const tx = await this.program.methods.initiateDispute(
        Array.from(disputeId),
        resolutionType,
        evidence ?? ""
      ).accounts({
        initiator: this.wallet.publicKey,
        agent: this.agentPda,
        task: taskPda,
        dispute: disputePda,
        protocol: protocolPda,
        systemProgram: SystemProgram3.programId
      }).signers([this.wallet]).rpc();
      this.stats.initiated++;
      return {
        disputePda,
        txSignature: tx
      };
    } catch (error) {
      throw new Error(`Failed to initiate dispute: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  /**
   * Vote on a dispute (requires ARBITER capability)
   */
  async voteOnDispute(disputePda, approve) {
    const [votePda] = PublicKey5.findProgramAddressSync(
      [Buffer.from("vote"), disputePda.toBytes(), this.wallet.publicKey.toBytes()],
      this.program.programId
    );
    try {
      const tx = await this.program.methods.voteDispute(approve).accounts({
        voter: this.wallet.publicKey,
        agent: this.agentPda,
        dispute: disputePda,
        vote: votePda,
        systemProgram: SystemProgram3.programId
      }).signers([this.wallet]).rpc();
      this.stats.votedOn++;
      return {
        txSignature: tx
      };
    } catch (error) {
      throw new Error(`Failed to vote on dispute: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  /**
   * Resolve a dispute (after voting deadline)
   */
  async resolveDispute(disputePda, taskPda, escrowPda, workerPda, workerClaimPda) {
    const [protocolPda] = PublicKey5.findProgramAddressSync(
      [Buffer.from("protocol")],
      this.program.programId
    );
    try {
      const protocol = await this.program.account.protocolConfig.fetch(protocolPda);
      const tx = await this.program.methods.resolveDispute().accountsPartial({
        resolver: this.wallet.publicKey,
        dispute: disputePda,
        task: taskPda,
        escrow: escrowPda,
        protocol: protocolPda,
        treasury: protocol.treasury,
        worker: workerPda ?? null,
        workerClaim: workerClaimPda ?? null,
        systemProgram: SystemProgram3.programId
      }).signers([this.wallet]).rpc();
      this.stats.resolved++;
      const dispute = await this.program.account.dispute.fetch(disputePda);
      return {
        txSignature: tx,
        resolution: dispute.resolution
      };
    } catch (error) {
      throw new Error(`Failed to resolve dispute: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  /**
   * Expire a dispute that has passed its deadline without resolution
   */
  async expireDispute(disputePda, taskPda, escrowPda) {
    try {
      const task = await this.program.account.task.fetch(taskPda);
      const tx = await this.program.methods.expireDispute().accounts({
        dispute: disputePda,
        task: taskPda,
        escrow: escrowPda,
        creator: task.creator,
        systemProgram: SystemProgram3.programId
      }).rpc();
      this.stats.expired++;
      const refundAmount = BigInt(task.reward.toString());
      return {
        txSignature: tx,
        refundAmount
      };
    } catch (error) {
      throw new Error(`Failed to expire dispute: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  /**
   * Fetch a dispute's current state
   */
  async getDispute(disputePda) {
    try {
      const dispute = await this.program.account.dispute.fetch(disputePda);
      return {
        disputeId: Buffer.from(dispute.disputeId),
        taskId: Buffer.from(dispute.taskId),
        initiator: dispute.initiator,
        resolutionType: dispute.resolutionType,
        votingDeadline: dispute.votingDeadline.toNumber(),
        votesFor: BigInt(dispute.votesFor.toString()),
        votesAgainst: BigInt(dispute.votesAgainst.toString()),
        status: dispute.resolved ? "resolved" /* Resolved */ : Date.now() / 1e3 > dispute.votingDeadline.toNumber() ? "expired" /* Expired */ : "active" /* Active */,
        resolved: dispute.resolved,
        resolution: dispute.resolved ? dispute.resolution : void 0
      };
    } catch {
      return null;
    }
  }
  /**
   * Get all active disputes for a task
   */
  async getDisputesForTask(taskPda) {
    try {
      const disputes = await this.program.account.dispute.all([
        {
          memcmp: {
            offset: 8,
            // After discriminator
            bytes: taskPda.toBase58()
          }
        }
      ]);
      return disputes.map((d) => ({
        disputeId: Buffer.from(d.account.disputeId),
        taskId: Buffer.from(d.account.taskId),
        initiator: d.account.initiator,
        resolutionType: d.account.resolutionType,
        votingDeadline: d.account.votingDeadline.toNumber(),
        votesFor: BigInt(d.account.votesFor.toString()),
        votesAgainst: BigInt(d.account.votesAgainst.toString()),
        status: d.account.resolved ? "resolved" /* Resolved */ : Date.now() / 1e3 > d.account.votingDeadline.toNumber() ? "expired" /* Expired */ : "active" /* Active */,
        resolved: d.account.resolved,
        resolution: d.account.resolved ? d.account.resolution : void 0
      }));
    } catch {
      return [];
    }
  }
  /**
   * Check if the agent has already voted on a dispute
   */
  async hasVoted(disputePda) {
    const [votePda] = PublicKey5.findProgramAddressSync(
      [Buffer.from("vote"), disputePda.toBytes(), this.wallet.publicKey.toBytes()],
      this.program.programId
    );
    try {
      await this.program.account.disputeVote.fetch(votePda);
      return true;
    } catch {
      return false;
    }
  }
  /**
   * Get dispute statistics
   */
  getStats() {
    return { ...this.stats };
  }
  /**
   * Handle a dispute initiated event
   */
  handleDisputeInitiated(event) {
    const dispute = {
      disputeId: event.disputeId,
      taskId: event.taskId,
      initiator: event.initiator,
      resolutionType: event.resolutionType,
      votingDeadline: event.votingDeadline,
      votesFor: 0n,
      votesAgainst: 0n,
      status: "active" /* Active */,
      resolved: false
    };
    this.activeDisputes.set(event.disputeId.toString("hex"), dispute);
    if (event.initiator.equals(this.wallet.publicKey)) {
      this.stats.initiated++;
    }
    this.eventHandlers.onInitiated?.(event);
  }
  /**
   * Handle a dispute vote cast event
   */
  handleDisputeVoteCast(event) {
    const disputeKey = event.disputeId.toString("hex");
    const dispute = this.activeDisputes.get(disputeKey);
    if (dispute) {
      dispute.votesFor = event.votesFor;
      dispute.votesAgainst = event.votesAgainst;
    }
    const records = this.voteRecords.get(disputeKey) ?? [];
    records.push({
      disputeId: event.disputeId,
      voter: event.voter,
      approved: event.approved,
      votedAt: event.timestamp
    });
    this.voteRecords.set(disputeKey, records);
    if (event.voter.equals(this.wallet.publicKey)) {
      this.stats.votedOn++;
    }
    this.eventHandlers.onVoteCast?.(event);
  }
  /**
   * Handle a dispute resolved event
   */
  handleDisputeResolved(event) {
    const disputeKey = event.disputeId.toString("hex");
    const dispute = this.activeDisputes.get(disputeKey);
    if (dispute) {
      dispute.status = "resolved" /* Resolved */;
      dispute.resolved = true;
      dispute.resolution = event.resolutionType;
      dispute.votesFor = event.votesFor;
      dispute.votesAgainst = event.votesAgainst;
      if (dispute.initiator.equals(this.wallet.publicKey)) {
        const initiatorWon = event.resolutionType === dispute.resolutionType;
        if (initiatorWon) {
          this.stats.wonAsInitiator++;
        } else {
          this.stats.lostAsInitiator++;
        }
      }
    }
    this.stats.resolved++;
    this.eventHandlers.onResolved?.(event);
  }
  /**
   * Handle a dispute expired event
   */
  handleDisputeExpired(event) {
    const disputeKey = event.disputeId.toString("hex");
    const dispute = this.activeDisputes.get(disputeKey);
    if (dispute) {
      dispute.status = "expired" /* Expired */;
    }
    this.stats.expired++;
    this.eventHandlers.onExpired?.(event);
  }
  /**
   * Generate a unique dispute ID
   */
  generateDisputeId() {
    const id = Buffer.alloc(32);
    const timestamp = BigInt(Date.now());
    const random = crypto.getRandomValues(new Uint8Array(24));
    for (let i = 0; i < 8; i++) {
      id[i] = Number(timestamp >> BigInt(8 * (7 - i)) & 0xffn);
    }
    id.set(random, 8);
    return id;
  }
};
function createDisputeHandler(config) {
  return new DisputeHandler(config);
}

// src/llm/adapters/base.ts
var BaseLLMAdapter = class {
  config;
  messages = [];
  systemPrompt = null;
  constructor(config) {
    this.config = {
      defaultTemperature: 0.7,
      defaultMaxTokens: 4096,
      timeout: 6e4,
      maxRetries: 3,
      ...config
    };
  }
  /**
   * Set the system prompt
   */
  setSystemPrompt(prompt) {
    this.systemPrompt = prompt;
  }
  /**
   * Add a message to the conversation
   */
  addMessage(message) {
    this.messages.push(message);
  }
  /**
   * Get all messages
   */
  getMessages() {
    return [...this.messages];
  }
  /**
   * Clear conversation history
   */
  clearContext() {
    this.messages = [];
  }
  /**
   * Get the model name
   */
  getModel() {
    return this.config.model ?? "unknown";
  }
  /**
   * Estimate token count (rough approximation)
   */
  countTokens(text) {
    return Math.ceil(text.length / 4);
  }
  /**
   * Build messages array for API call
   */
  buildMessages(prompt) {
    const messages = [];
    if (this.systemPrompt) {
      messages.push({ role: "system", content: this.systemPrompt });
    }
    messages.push(...this.messages);
    messages.push({ role: "user", content: prompt });
    return messages;
  }
  /**
   * Convert tools to API format
   */
  toolsToAPIFormat(tools) {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: "object",
        properties: tool.inputSchema.properties,
        required: tool.inputSchema.required
      }
    }));
  }
  /**
   * Make HTTP request with retry
   */
  async fetchWithRetry(url, options, retries = this.config.maxRetries ?? 3) {
    let lastError = null;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);
        const response = await fetch(url, {
          ...options,
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (response.ok) {
          return response;
        }
        if (response.status === 429) {
          const retryAfter = response.headers.get("retry-after");
          const delay = retryAfter ? parseInt(retryAfter) * 1e3 : 1e3 * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      } catch (error) {
        lastError = error;
        if (attempt < retries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1e3 * Math.pow(2, attempt)));
        }
      }
    }
    throw lastError ?? new Error("Request failed");
  }
};

// src/llm/adapters/anthropic.ts
var DEFAULT_MODEL = "claude-sonnet-4-20250514";
var DEFAULT_BASE_URL = "https://api.anthropic.com";
var ANTHROPIC_VERSION = "2023-06-01";
var AnthropicAdapter = class extends BaseLLMAdapter {
  apiKey;
  baseUrl;
  anthropicVersion;
  constructor(config) {
    super({
      ...config,
      model: config.model ?? DEFAULT_MODEL
    });
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.anthropicVersion = config.anthropicVersion ?? ANTHROPIC_VERSION;
  }
  getContextWindow() {
    const model = this.config.model ?? "";
    if (model.includes("opus")) return 2e5;
    if (model.includes("sonnet")) return 2e5;
    if (model.includes("haiku")) return 2e5;
    return 2e5;
  }
  async complete(prompt, options) {
    const response = await this.callAPI(prompt, options);
    return this.extractTextContent(response.content);
  }
  async *stream(prompt, options) {
    const messages = this.buildAnthropicMessages(prompt);
    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": this.anthropicVersion
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        max_tokens: options?.maxTokens ?? this.config.defaultMaxTokens,
        temperature: options?.temperature ?? this.config.defaultTemperature,
        stream: true,
        ...this.systemPrompt && { system: this.systemPrompt }
      })
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${error}`);
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("No response body");
    }
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") continue;
          try {
            const event = JSON.parse(data);
            if (event.type === "content_block_delta" && event.delta?.text) {
              yield event.delta.text;
            }
          } catch {
          }
        }
      }
    }
  }
  async completeWithTools(prompt, tools, options) {
    const anthropicTools = this.convertTools(tools);
    const response = await this.callAPI(prompt, {
      ...options,
      tools
    }, anthropicTools);
    return this.convertResponse(response);
  }
  async callAPI(prompt, options, tools) {
    const messages = this.buildAnthropicMessages(prompt);
    const body = {
      model: this.config.model,
      messages,
      max_tokens: options?.maxTokens ?? this.config.defaultMaxTokens,
      temperature: options?.temperature ?? this.config.defaultTemperature
    };
    if (this.systemPrompt) {
      body.system = this.systemPrompt;
    }
    if (tools && tools.length > 0) {
      body.tools = tools;
      if (options?.toolChoice) {
        if (options.toolChoice === "auto") {
          body.tool_choice = { type: "auto" };
        } else if (options.toolChoice === "required") {
          body.tool_choice = { type: "any" };
        } else if (options.toolChoice === "none") {
          delete body.tools;
        } else if (typeof options.toolChoice === "object") {
          body.tool_choice = { type: "tool", name: options.toolChoice.name };
        }
      }
    }
    if (options?.stopSequences) {
      body.stop_sequences = options.stopSequences;
    }
    const response = await this.fetchWithRetry(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": this.anthropicVersion
      },
      body: JSON.stringify(body)
    });
    return await response.json();
  }
  buildAnthropicMessages(prompt) {
    const messages = [];
    for (const msg of this.messages) {
      if (msg.role === "system") {
        continue;
      }
      if (msg.role === "tool") {
        messages.push({
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: msg.toolCallId ?? "",
            content: msg.content
          }]
        });
      } else if (msg.role === "assistant" && msg.toolCalls) {
        const content = [];
        if (msg.content) {
          content.push({ type: "text", text: msg.content });
        }
        for (const tc of msg.toolCalls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.input
          });
        }
        messages.push({ role: "assistant", content });
      } else {
        messages.push({
          role: msg.role === "user" ? "user" : "assistant",
          content: msg.content
        });
      }
    }
    messages.push({ role: "user", content: prompt });
    return messages;
  }
  convertTools(tools) {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: "object",
        properties: tool.inputSchema.properties,
        required: tool.inputSchema.required
      }
    }));
  }
  extractTextContent(content) {
    return content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
  }
  convertResponse(response) {
    const content = this.extractTextContent(response.content);
    const toolCalls = response.content.filter((block) => block.type === "tool_use").map((block) => ({
      id: block.id ?? "",
      name: block.name ?? "",
      input: block.input
    }));
    let finishReason = "stop";
    if (response.stop_reason === "tool_use") {
      finishReason = "tool_calls";
    } else if (response.stop_reason === "max_tokens") {
      finishReason = "length";
    }
    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : void 0,
      finishReason,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens
      },
      model: response.model
    };
  }
};

// src/llm/adapters/ollama.ts
var DEFAULT_BASE_URL2 = "http://localhost:11434";
var OllamaAdapter = class extends BaseLLMAdapter {
  baseUrl;
  constructor(config) {
    super(config);
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL2;
  }
  getContextWindow() {
    const model = (this.config.model ?? "").toLowerCase();
    if (model.includes("llama3")) return 8192;
    if (model.includes("mistral")) return 8192;
    if (model.includes("codellama")) return 16384;
    if (model.includes("mixtral")) return 32768;
    return 4096;
  }
  async complete(prompt, options) {
    const messages = this.buildOllamaMessages(prompt);
    const response = await this.fetchWithRetry(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        stream: false,
        options: {
          temperature: options?.temperature ?? this.config.defaultTemperature,
          num_predict: options?.maxTokens ?? this.config.defaultMaxTokens,
          ...options?.stopSequences && { stop: options.stopSequences }
        }
      })
    });
    const data = await response.json();
    return data.message.content;
  }
  async *stream(prompt, options) {
    const messages = this.buildOllamaMessages(prompt);
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        stream: true,
        options: {
          temperature: options?.temperature ?? this.config.defaultTemperature,
          num_predict: options?.maxTokens ?? this.config.defaultMaxTokens
        }
      })
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama API error: ${error}`);
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("No response body");
    }
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) {
          try {
            const chunk = JSON.parse(line);
            if (chunk.message?.content) {
              yield chunk.message.content;
            }
          } catch {
          }
        }
      }
    }
  }
  async completeWithTools(prompt, tools, options) {
    const messages = this.buildOllamaMessages(prompt);
    const ollamaTools = this.convertTools(tools);
    const response = await this.fetchWithRetry(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        tools: ollamaTools,
        stream: false,
        options: {
          temperature: options?.temperature ?? this.config.defaultTemperature,
          num_predict: options?.maxTokens ?? this.config.defaultMaxTokens
        }
      })
    });
    const data = await response.json();
    return this.convertResponse(data);
  }
  buildOllamaMessages(prompt) {
    const messages = [];
    if (this.systemPrompt) {
      messages.push({ role: "system", content: this.systemPrompt });
    }
    for (const msg of this.messages) {
      if (msg.role === "tool") {
        messages.push({
          role: "user",
          content: `Tool result for ${msg.name ?? "tool"}: ${msg.content}`
        });
      } else if (msg.role === "system") {
        messages.push({ role: "system", content: msg.content });
      } else if (msg.role === "assistant") {
        messages.push({ role: "assistant", content: msg.content });
      } else {
        messages.push({ role: "user", content: msg.content });
      }
    }
    messages.push({ role: "user", content: prompt });
    return messages;
  }
  convertTools(tools) {
    return tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: "object",
          properties: tool.inputSchema.properties,
          required: tool.inputSchema.required
        }
      }
    }));
  }
  convertResponse(response) {
    const toolCalls = [];
    if (response.message.tool_calls) {
      for (let i = 0; i < response.message.tool_calls.length; i++) {
        const tc = response.message.tool_calls[i];
        toolCalls.push({
          id: `call_${i}`,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments)
        });
      }
    }
    const promptTokens = response.prompt_eval_count ?? 0;
    const completionTokens = response.eval_count ?? 0;
    return {
      content: response.message.content,
      toolCalls: toolCalls.length > 0 ? toolCalls : void 0,
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens
      },
      model: response.model
    };
  }
  /**
   * Check if Ollama is running
   */
  async isAvailable() {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }
  /**
   * List available models
   */
  async listModels() {
    const response = await fetch(`${this.baseUrl}/api/tags`);
    if (!response.ok) {
      throw new Error("Failed to list models");
    }
    const data = await response.json();
    return data.models.map((m) => m.name);
  }
  /**
   * Pull a model
   */
  async pullModel(model) {
    const response = await fetch(`${this.baseUrl}/api/pull`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ name: model })
    });
    if (!response.ok) {
      throw new Error(`Failed to pull model: ${model}`);
    }
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }
  }
};

// src/llm/adapters/grok.ts
var DEFAULT_MODEL2 = "grok-2";
var DEFAULT_BASE_URL3 = "https://api.x.ai/v1";
var GrokAdapter = class extends BaseLLMAdapter {
  apiKey;
  baseUrl;
  constructor(config) {
    super({
      ...config,
      model: config.model ?? DEFAULT_MODEL2
    });
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL3;
  }
  getContextWindow() {
    const model = this.config.model;
    if (model === "grok-2") return 131072;
    if (model === "grok-2-mini") return 131072;
    if (model === "grok-beta") return 131072;
    return 131072;
  }
  async complete(prompt, options) {
    const response = await this.callAPI(prompt, options);
    return response.choices[0]?.message.content ?? "";
  }
  async *stream(prompt, options) {
    const messages = this.buildOpenAIMessages(prompt);
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        max_tokens: options?.maxTokens ?? this.config.defaultMaxTokens,
        temperature: options?.temperature ?? this.config.defaultTemperature,
        stream: true,
        ...options?.stopSequences && { stop: options.stopSequences }
      })
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Grok API error: ${error}`);
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("No response body");
    }
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") continue;
          try {
            const event = JSON.parse(data);
            const content = event.choices?.[0]?.delta?.content;
            if (content) {
              yield content;
            }
          } catch {
          }
        }
      }
    }
  }
  async completeWithTools(prompt, tools, options) {
    const openaiTools = this.convertTools(tools);
    const response = await this.callAPI(prompt, options, openaiTools);
    return this.convertResponse(response);
  }
  async callAPI(prompt, options, tools) {
    const messages = this.buildOpenAIMessages(prompt);
    const body = {
      model: this.config.model,
      messages,
      max_tokens: options?.maxTokens ?? this.config.defaultMaxTokens,
      temperature: options?.temperature ?? this.config.defaultTemperature
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      if (options?.toolChoice) {
        if (options.toolChoice === "auto") {
          body.tool_choice = "auto";
        } else if (options.toolChoice === "required") {
          body.tool_choice = "required";
        } else if (options.toolChoice === "none") {
          body.tool_choice = "none";
        } else if (typeof options.toolChoice === "object") {
          body.tool_choice = {
            type: "function",
            function: { name: options.toolChoice.name }
          };
        }
      }
    }
    if (options?.stopSequences) {
      body.stop = options.stopSequences;
    }
    if (options?.responseFormat === "json") {
      body.response_format = { type: "json_object" };
    }
    const response = await this.fetchWithRetry(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(body)
    });
    return await response.json();
  }
  buildOpenAIMessages(prompt) {
    const messages = [];
    if (this.systemPrompt) {
      messages.push({ role: "system", content: this.systemPrompt });
    }
    for (const msg of this.messages) {
      if (msg.role === "tool") {
        messages.push({
          role: "tool",
          content: msg.content,
          tool_call_id: msg.toolCallId ?? ""
        });
      } else if (msg.role === "assistant" && msg.toolCalls) {
        messages.push({
          role: "assistant",
          content: msg.content || null,
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input)
            }
          }))
        });
      } else {
        messages.push({
          role: msg.role,
          content: msg.content
        });
      }
    }
    messages.push({ role: "user", content: prompt });
    return messages;
  }
  convertTools(tools) {
    return tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: "object",
          properties: tool.inputSchema.properties,
          required: tool.inputSchema.required
        }
      }
    }));
  }
  convertResponse(response) {
    const choice = response.choices[0];
    const toolCalls = [];
    if (choice?.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let input;
        try {
          input = JSON.parse(tc.function.arguments);
        } catch {
          input = tc.function.arguments;
        }
        toolCalls.push({
          id: tc.id,
          name: tc.function.name,
          input
        });
      }
    }
    return {
      content: choice?.message.content ?? "",
      toolCalls: toolCalls.length > 0 ? toolCalls : void 0,
      finishReason: choice?.finish_reason ?? "stop",
      usage: {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens
      },
      model: response.model
    };
  }
};

// src/runtime.ts
var AgentRuntime = class {
  connection;
  wallet;
  program;
  mode;
  // Components
  agentManager;
  eventMonitor;
  taskExecutor;
  toolRegistry;
  memoryStore;
  proofEngine;
  disputeHandler;
  llm;
  // State
  running = false;
  agentState = null;
  listeners = [];
  constructor(config) {
    this.connection = config.connection;
    this.wallet = config.wallet;
    this.mode = config.mode ?? "autonomous";
    const provider = new AnchorProvider(
      config.connection,
      new Wallet(config.wallet),
      { commitment: "confirmed" }
    );
    this.program = new Program2(config.idl, provider);
    const [agentPda] = PublicKey6.findProgramAddressSync(
      [Buffer.from("agent"), config.agentId],
      config.programId
    );
    this.agentManager = new AgentManager({
      connection: config.connection,
      program: this.program,
      wallet: config.wallet,
      agentId: config.agentId
    });
    this.eventMonitor = new EventMonitor({
      connection: config.connection,
      programId: config.programId,
      idl: config.idl
    });
    if (config.eventFilter) {
      this.eventMonitor.setFilter({
        taskIds: config.eventFilter.taskIds,
        agentIds: config.eventFilter.agentIds,
        eventTypes: config.eventFilter.eventTypes
      });
    }
    this.taskExecutor = new TaskExecutor({
      connection: config.connection,
      program: this.program,
      wallet: config.wallet,
      agentPda,
      evaluator: config.taskEvaluator,
      pollInterval: config.pollInterval,
      maxConcurrentTasks: config.maxConcurrentTasks
    });
    if (config.taskHandler) {
      this.taskExecutor.onTask(config.taskHandler);
    }
    this.toolRegistry = new ToolRegistry(config.tools);
    this.toolRegistry.registerAll(builtinTools);
    const memoryBackend = config.memoryBackend ?? new InMemoryBackend();
    this.memoryStore = new DefaultMemoryStore({
      backend: memoryBackend,
      ...config.memory
    });
    this.proofEngine = new ProofEngine(config.proof);
    this.disputeHandler = new DisputeHandler({
      connection: config.connection,
      program: this.program,
      wallet: config.wallet,
      agentPda
    });
    this.llm = config.llm ?? null;
    this.setupEventForwarding();
  }
  /**
   * Start the runtime
   */
  async start() {
    if (this.running) {
      throw new Error("Runtime is already running");
    }
    await this.memoryStore.load();
    this.agentState = await this.agentManager.getState();
    await this.eventMonitor.connect();
    if (this.mode === "autonomous" || this.mode === "assisted") {
      await this.taskExecutor.start();
    }
    this.running = true;
    this.emit({
      type: "started",
      agentId: this.agentManager.getAgentId(),
      mode: this.mode,
      timestamp: Date.now()
    });
  }
  /**
   * Stop the runtime
   */
  async stop() {
    if (!this.running) {
      return;
    }
    await this.taskExecutor.stop();
    await this.eventMonitor.disconnect();
    await this.memoryStore.save();
    const stats = this.taskExecutor.getStats();
    this.running = false;
    this.emit({
      type: "stopped",
      agentId: this.agentManager.getAgentId(),
      completedCount: stats.completed,
      failedCount: stats.failed,
      timestamp: Date.now()
    });
  }
  /**
   * Register the agent on-chain
   */
  async register(config) {
    this.agentState = await this.agentManager.register(config);
    return this.agentState;
  }
  /**
   * Deregister the agent
   */
  async deregister() {
    const stakeReturned = await this.agentManager.deregister();
    this.agentState = null;
    return stakeReturned;
  }
  /**
   * Set the task handler
   */
  onTask(handler) {
    this.taskExecutor.onTask(handler);
  }
  /**
   * Set the task evaluator
   */
  setEvaluator(evaluator) {
    this.taskExecutor.setEvaluator(evaluator);
  }
  /**
   * Register a tool
   */
  registerTool(tool) {
    this.toolRegistry.register(tool);
  }
  /**
   * Register multiple tools
   */
  registerTools(tools) {
    this.toolRegistry.registerAll(tools);
  }
  /**
   * Set the LLM adapter
   */
  setLLM(llm) {
    this.llm = llm;
  }
  /**
   * Add a runtime event listener
   */
  on(listener) {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) {
        this.listeners.splice(index, 1);
      }
    };
  }
  /**
   * Subscribe to on-chain events
   */
  onEvent(eventType, handler) {
    return this.eventMonitor.on(eventType, handler);
  }
  /**
   * Get runtime status
   */
  async getStatus() {
    const taskStats = this.taskExecutor.getStats();
    const proofStats = this.proofEngine.getStatus();
    const memoryStats = await this.memoryStore.getStats();
    return {
      running: this.running,
      mode: this.mode,
      agentState: this.agentState,
      taskCount: {
        pending: taskStats.pending,
        executing: taskStats.executing,
        completed: taskStats.completed,
        failed: taskStats.failed
      },
      proofStats: {
        pending: proofStats.pending,
        completed: proofStats.completed,
        failed: proofStats.failed
      },
      memoryStats: {
        messageCount: memoryStats.messageCount,
        taskHistoryCount: memoryStats.taskHistoryCount
      }
    };
  }
  // === Component Accessors ===
  getAgentManager() {
    return this.agentManager;
  }
  getEventMonitor() {
    return this.eventMonitor;
  }
  getTaskExecutor() {
    return this.taskExecutor;
  }
  getToolRegistry() {
    return this.toolRegistry;
  }
  getMemoryStore() {
    return this.memoryStore;
  }
  getProofEngine() {
    return this.proofEngine;
  }
  getDisputeHandler() {
    return this.disputeHandler;
  }
  getLLM() {
    return this.llm;
  }
  // === Private Methods ===
  setupEventForwarding() {
    this.taskExecutor.on((event) => {
      this.emit(event);
    });
    this.eventMonitor.on("disputeInitiated", (event) => {
      this.disputeHandler.handleDisputeInitiated(event);
    });
    this.eventMonitor.on("disputeVoteCast", (event) => {
      this.disputeHandler.handleDisputeVoteCast(event);
    });
    this.eventMonitor.on("disputeResolved", (event) => {
      this.disputeHandler.handleDisputeResolved(event);
    });
    this.eventMonitor.on("disputeExpired", (event) => {
      this.disputeHandler.handleDisputeExpired(event);
    });
    this.eventMonitor.on("taskCreated", async () => {
      if (this.running && (this.mode === "autonomous" || this.mode === "assisted")) {
        try {
          await this.taskExecutor.discoverTasks();
        } catch {
        }
      }
    });
  }
  emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("Error in runtime event listener:", error);
      }
    }
  }
};
function createRuntime(config) {
  return new AgentRuntime(config);
}
function createAnthropicLLM(config) {
  return new AnthropicAdapter({
    ...config,
    model: config.model
  });
}
function createOllamaLLM(config) {
  return new OllamaAdapter(config);
}
function createGrokLLM(config) {
  return new GrokAdapter({
    ...config,
    model: config.model
  });
}

// src/agent.ts
import { PublicKey as PublicKey7, SystemProgram as SystemProgram4 } from "@solana/web3.js";
import { BN as BN2 } from "@coral-xyz/anchor";

// src/types.ts
var Capabilities = {
  COMPUTE: 1 << 0,
  STORAGE: 1 << 1,
  INFERENCE: 1 << 2,
  NETWORK: 1 << 3,
  COORDINATOR: 1 << 4,
  ARBITER: 1 << 7
};

// src/agent.ts
var DEFAULT_POLL_INTERVAL_MS = 5e3;
var DEFAULT_MAX_CONCURRENT = 1;
var DEFAULT_RETRY_ATTEMPTS = 3;
var DEFAULT_RETRY_BASE_DELAY_MS = 1e3;
var Agent = class {
  config;
  options;
  state;
  taskHandler = null;
  listeners = [];
  pollInterval = null;
  protocolPda;
  constructor(config, options = {}) {
    this.config = config;
    this.options = {
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      maxConcurrentTasks: options.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT,
      autoClaim: options.autoClaim ?? false,
      taskFilter: options.taskFilter,
      retryAttempts: options.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS,
      retryBaseDelayMs: options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS
    };
    const [agentPda] = PublicKey7.findProgramAddressSync(
      [Buffer.from("agent"), config.agentId],
      config.program.programId
    );
    const [protocolPda] = PublicKey7.findProgramAddressSync(
      [Buffer.from("protocol")],
      config.program.programId
    );
    this.protocolPda = protocolPda;
    this.state = {
      pda: agentPda,
      registered: false,
      running: false,
      activeTasks: /* @__PURE__ */ new Map(),
      completedCount: 0,
      failedCount: 0
    };
  }
  /**
   * Get agent's PDA address
   */
  get pda() {
    return this.state.pda;
  }
  /**
   * Check if agent is running
   */
  get isRunning() {
    return this.state.running;
  }
  /**
   * Get current agent state
   */
  getState() {
    return { ...this.state };
  }
  /**
   * Register task handler
   */
  onTask(handler) {
    this.taskHandler = handler;
  }
  /**
   * Register event listener
   */
  on(listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
  emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        console.error("Event listener error:", e);
      }
    }
  }
  /**
   * Register agent on-chain (if not already registered)
   */
  async register() {
    try {
      const accounts = this.config.program.account;
      await accounts["agentRegistration"].fetch(this.state.pda);
      this.state.registered = true;
      return;
    } catch {
    }
    const stake = this.config.stake ?? 0;
    await this.config.program.methods.registerAgent(
      Array.from(this.config.agentId),
      new BN2(this.config.capabilities),
      this.config.endpoint ?? "",
      null,
      // delegatedSigner
      new BN2(stake)
    ).accountsPartial({
      agent: this.state.pda,
      protocolConfig: this.protocolPda,
      authority: this.config.wallet.publicKey,
      systemProgram: SystemProgram4.programId
    }).signers([this.config.wallet]).rpc();
    this.state.registered = true;
  }
  /**
   * Start the agent runtime
   */
  async start() {
    if (this.state.running) {
      throw new Error("Agent is already running");
    }
    if (!this.taskHandler) {
      throw new Error("No task handler registered. Call onTask() first.");
    }
    await this.register();
    this.state.running = true;
    this.emit({ type: "started", agentId: this.config.agentId });
    const pollInterval = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollInterval = setInterval(
      () => this.pollTasks().catch(this.handleError.bind(this)),
      pollInterval
    );
    await this.pollTasks().catch(this.handleError.bind(this));
  }
  /**
   * Stop the agent runtime
   */
  async stop() {
    if (!this.state.running) {
      return;
    }
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.state.running = false;
    this.emit({ type: "stopped", agentId: this.config.agentId });
  }
  /**
   * Poll for available tasks
   */
  async pollTasks() {
    if (!this.state.running) return;
    const maxConcurrent = this.options.maxConcurrentTasks ?? 1;
    if (this.state.activeTasks.size >= maxConcurrent) {
      return;
    }
    const tasks = await this.fetchOpenTasks();
    for (const task of tasks) {
      if (this.options.taskFilter && !this.options.taskFilter(task)) {
        continue;
      }
      if ((task.requiredCapabilities & this.config.capabilities) !== task.requiredCapabilities) {
        continue;
      }
      if (this.state.activeTasks.has(task.address.toBase58())) {
        continue;
      }
      this.emit({ type: "taskFound", task });
      if (this.options.autoClaim) {
        try {
          await this.claimAndExecute(task);
        } catch (e) {
          this.handleError(e);
        }
        if (this.state.activeTasks.size >= (this.options.maxConcurrentTasks ?? 1)) {
          break;
        }
      }
    }
  }
  /**
   * Fetch open tasks from on-chain
   */
  async fetchOpenTasks() {
    const accounts = this.config.program.account;
    const taskAccounts = await accounts["task"].all([
      {
        memcmp: {
          offset: 8 + 32,
          // discriminator + creator
          bytes: Buffer.from([0 /* Open */]).toString("base64")
        }
      }
    ]);
    return taskAccounts.map((t) => this.parseTask(t.publicKey, t.account));
  }
  /**
   * Parse on-chain task account to OnChainTask
   */
  parseTask(address, account) {
    return {
      address,
      taskId: Buffer.from(account.taskId),
      creator: account.creator,
      requiredCapabilities: account.requiredCapabilities.toNumber(),
      description: Buffer.from(account.description).toString("utf8").replace(/\0/g, ""),
      rewardLamports: account.rewardAmount.toNumber(),
      maxWorkers: account.maxWorkers,
      currentWorkers: account.currentWorkers,
      deadline: account.deadline.toNumber(),
      taskType: this.parseTaskType(account.taskType),
      constraintHash: account.constraintHash && !Buffer.alloc(32).equals(Buffer.from(account.constraintHash)) ? Buffer.from(account.constraintHash) : null,
      status: this.parseTaskStatus(account.status)
    };
  }
  parseTaskType(taskType) {
    if ("exclusive" in taskType) return 0 /* Exclusive */;
    if ("collaborative" in taskType) return 1 /* Collaborative */;
    if ("competitive" in taskType) return 2 /* Competitive */;
    return 0 /* Exclusive */;
  }
  parseTaskStatus(status) {
    if ("open" in status) return 0 /* Open */;
    if ("inProgress" in status) return 1 /* InProgress */;
    if ("completed" in status) return 2 /* Completed */;
    if ("cancelled" in status) return 3 /* Cancelled */;
    if ("disputed" in status) return 4 /* Disputed */;
    return 0 /* Open */;
  }
  /**
   * Claim a task and execute
   */
  async claimAndExecute(task) {
    if (!this.taskHandler) {
      throw new Error("No task handler registered");
    }
    const [claimPda] = PublicKey7.findProgramAddressSync(
      [Buffer.from("claim"), task.address.toBuffer(), this.state.pda.toBuffer()],
      this.config.program.programId
    );
    await this.config.program.methods.claimTask().accountsPartial({
      task: task.address,
      claim: claimPda,
      worker: this.state.pda,
      protocolConfig: this.protocolPda,
      authority: this.config.wallet.publicKey,
      systemProgram: SystemProgram4.programId
    }).signers([this.config.wallet]).rpc();
    this.state.activeTasks.set(task.address.toBase58(), task);
    this.emit({ type: "taskClaimed", task, claimPda });
    try {
      const result = await this.executeWithRetry(task);
      await this.completeTask(task, result);
    } catch (e) {
      this.state.failedCount++;
      this.state.activeTasks.delete(task.address.toBase58());
      this.emit({ type: "taskFailed", task, error: e });
      throw e;
    }
  }
  /**
   * Execute task handler with retry logic
   */
  async executeWithRetry(task) {
    let lastError = null;
    const attempts = this.options.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
    const baseDelay = this.options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.taskHandler(task);
      } catch (e) {
        lastError = e;
        if (attempt < attempts - 1) {
          const delay = baseDelay * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError;
  }
  /**
   * Complete a task with result
   */
  async completeTask(task, result) {
    const [claimPda] = PublicKey7.findProgramAddressSync(
      [Buffer.from("claim"), task.address.toBuffer(), this.state.pda.toBuffer()],
      this.config.program.programId
    );
    const [escrowPda] = PublicKey7.findProgramAddressSync(
      [Buffer.from("escrow"), task.address.toBuffer()],
      this.config.program.programId
    );
    const accounts = this.config.program.account;
    const protocolConfig = await accounts["protocolConfig"].fetch(this.protocolPda);
    const treasury = protocolConfig.treasury;
    const isPrivateTask = task.constraintHash !== null;
    let txSignature;
    if (isPrivateTask) {
      throw new Error(
        "Private task completion requires ZK proof generation. Use generateProof() from @agenc/sdk and submit via completeTaskPrivate()."
      );
    } else {
      const resultHash = result.resultData ?? Buffer.alloc(32);
      const resultData = result.resultData ?? Buffer.alloc(128);
      txSignature = await this.config.program.methods.completeTask(Array.from(resultHash), Array.from(resultData)).accountsPartial({
        task: task.address,
        claim: claimPda,
        escrow: escrowPda,
        worker: this.state.pda,
        protocolConfig: this.protocolPda,
        treasury,
        authority: this.config.wallet.publicKey,
        systemProgram: SystemProgram4.programId
      }).signers([this.config.wallet]).rpc();
    }
    this.state.completedCount++;
    this.state.activeTasks.delete(task.address.toBase58());
    this.emit({ type: "taskCompleted", task, txSignature });
  }
  handleError(error) {
    this.emit({ type: "error", error });
    console.error("[Agent Error]", error.message);
  }
};

// src/index.ts
var VERSION = "1.0.0";
export {
  Agent,
  AgentManager,
  AgentRuntime,
  AgentStatus,
  AnthropicAdapter,
  BaseLLMAdapter,
  Capability as Capabilities,
  Capability,
  DefaultMemoryStore,
  DisputeHandler,
  DisputeStatus,
  Evaluators,
  EventMonitor,
  ExecutorState,
  FileBackend,
  GrokAdapter,
  InMemoryBackend,
  OllamaAdapter,
  ProofEngine,
  ResolutionType,
  TaskExecutor,
  TaskStatus,
  TaskType,
  ToolRegistry,
  VERSION,
  base64Decode,
  base64Encode,
  Evaluators as builtinEvaluators,
  builtinTools,
  computeHash,
  createAnthropicLLM,
  createDisputeHandler,
  createGrokLLM,
  createOllamaLLM,
  createProofEngine,
  createRuntime,
  currentTime,
  generateSalt,
  httpFetch,
  jsonParse,
  jsonStringify,
  randomNumber,
  sleep
};
