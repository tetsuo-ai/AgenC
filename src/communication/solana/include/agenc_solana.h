/**
 * @file agenc_solana.h
 * @brief AgenC Framework Integration for Solana Communication
 *
 * This module provides the integration layer between the AgenC framework
 * and the Solana blockchain communication system. It implements the
 * AgenC Communication Module interface using Solana as the transport layer.
 *
 * Designed for:
 * - Multi-agent coordination on edge devices
 * - Trustless task distribution and payment
 * - Decentralized state synchronization
 * - Low-latency message routing
 *
 * @note Thread-safe: All public functions are thread-safe
 * @note Memory: Uses AgenC MemoryStrategy for allocations
 */

#ifndef AGENC_SOLANA_H_
#define AGENC_SOLANA_H_

#include "solana_comm.h"

#ifdef __cplusplus
extern "C" {
#endif

/*============================================================================
 * AgenC Communication Module Interface
 *
 * These types mirror the AgenC framework's communication module interface.
 * They provide a unified abstraction over different transport mechanisms.
 *============================================================================*/

/**
 * @brief Message routing mode
 */
typedef enum AgencRoutingMode {
    AGENC_ROUTE_ONCHAIN = 0,    /**< Route via Solana transactions */
    AGENC_ROUTE_OFFCHAIN,        /**< Route via direct P2P connection */
    AGENC_ROUTE_HYBRID,          /**< Prefer P2P, fallback to on-chain */
    AGENC_ROUTE_BROADCAST,       /**< Broadcast to all subscribed agents */
} AgencRoutingMode;

/**
 * @brief Agent coordination message
 */
typedef struct AgencMessage {
    /** Message identifier */
    uint64_t id;

    /** Sender agent ID */
    uint8_t sender[32];

    /** Recipient agent ID (zeros for broadcast) */
    uint8_t recipient[32];

    /** Message type identifier */
    uint16_t type;

    /** Routing mode */
    AgencRoutingMode routing;

    /** Message payload */
    uint8_t *payload;
    size_t payload_size;

    /** Timestamp */
    int64_t timestamp;

    /** Signature for authentication */
    SolanaSignature signature;

    /** Transaction ID (if on-chain) */
    SolanaSignature tx_signature;
} AgencMessage;

/**
 * @brief Task handle for coordination
 */
typedef struct AgencTask {
    /** Task identifier */
    uint8_t id[32];

    /** Task PDA on Solana */
    SolanaPubkey pda;

    /** Current status */
    TaskStatus status;

    /** Task data */
    TaskData data;

    /** Local tracking */
    bool is_claimed;
    bool is_completed;
    int64_t claimed_at;
    int64_t completed_at;
} AgencTask;

/**
 * @brief Agent handle
 */
typedef struct AgencAgent {
    /** Agent identifier */
    uint8_t id[32];

    /** Agent PDA on Solana */
    SolanaPubkey pda;

    /** Registration data */
    AgentRegistration registration;

    /** Communication strategy */
    SolanaCommStrategy *comm;

    /** Keypair for signing */
    SolanaKeypair *keypair;

    /** Local state */
    bool is_registered;
    uint8_t active_task_count;
} AgencAgent;

/**
 * @brief Callback for message reception
 */
typedef void (*AgencMessageCallback)(
    AgencAgent *agent,
    const AgencMessage *message,
    void *user_data
);

/**
 * @brief Callback for task events
 */
typedef void (*AgencTaskCallback)(
    AgencAgent *agent,
    const AgencTask *task,
    uint8_t event_type,  /* 0=created, 1=claimed, 2=completed, 3=cancelled */
    void *user_data
);

/**
 * @brief Callback for state changes
 */
typedef void (*AgencStateCallback)(
    AgencAgent *agent,
    const uint8_t state_key[32],
    const uint8_t state_value[64],
    uint64_t version,
    void *user_data
);

/**
 * @brief Configuration for AgenC Solana integration
 */
typedef struct AgencSolanaConfig {
    /** Solana communication configuration */
    SolanaCommConfig solana_config;

    /** Agent identifier */
    uint8_t agent_id[32];

    /** Agent capabilities bitmask */
    uint64_t capabilities;

    /** Agent endpoint for P2P communication */
    const char *endpoint;

    /** Extended metadata URI */
    const char *metadata_uri;

    /** Auto-register on initialization */
    bool auto_register;

    /** Auto-claim matching tasks */
    bool auto_claim;

    /** Message callback */
    AgencMessageCallback message_callback;
    void *message_callback_data;

    /** Task callback */
    AgencTaskCallback task_callback;
    void *task_callback_data;

    /** State callback */
    AgencStateCallback state_callback;
    void *state_callback_data;
} AgencSolanaConfig;

/*============================================================================
 * Agent Lifecycle
 *============================================================================*/

/**
 * @brief Create and initialize an AgenC agent with Solana backend
 *
 * @param config Configuration parameters
 * @return Agent handle or NULL on failure
 *
 * @note If auto_register is true, the agent will be registered on-chain
 *       during initialization. Otherwise, call agenc_agent_register().
 */
AgencAgent *agenc_agent_create(const AgencSolanaConfig *config);

/**
 * @brief Destroy an AgenC agent
 *
 * @param agent Agent to destroy
 *
 * @note This does NOT deregister the agent on-chain. Call
 *       agenc_agent_deregister() first if needed.
 */
void agenc_agent_destroy(AgencAgent *agent);

/**
 * @brief Register agent on-chain
 *
 * @param agent Agent to register
 * @return Result code
 */
SolanaResult agenc_agent_register(AgencAgent *agent);

/**
 * @brief Deregister agent on-chain and reclaim rent
 *
 * @param agent Agent to deregister
 * @return Result code
 *
 * @note Agent must have no active tasks
 */
SolanaResult agenc_agent_deregister(AgencAgent *agent);

/**
 * @brief Update agent registration
 *
 * @param agent Agent to update
 * @param capabilities New capabilities (0 to keep current)
 * @param endpoint New endpoint (NULL to keep current)
 * @param status New status (-1 to keep current)
 * @return Result code
 */
SolanaResult agenc_agent_update(
    AgencAgent *agent,
    uint64_t capabilities,
    const char *endpoint,
    int status
);

/*============================================================================
 * Task Operations
 *============================================================================*/

/**
 * @brief Create a new task on-chain
 *
 * @param agent Agent creating the task
 * @param task_id Unique task identifier
 * @param capabilities Required capabilities
 * @param description Task description (64 bytes)
 * @param reward_lamports Reward in lamports
 * @param max_workers Maximum workers
 * @param deadline Unix timestamp (0 for none)
 * @param task_type Task type
 * @param task Output task handle
 * @return Result code
 */
SolanaResult agenc_task_create(
    AgencAgent *agent,
    const uint8_t task_id[32],
    uint64_t capabilities,
    const uint8_t description[64],
    uint64_t reward_lamports,
    uint8_t max_workers,
    int64_t deadline,
    TaskType task_type,
    AgencTask *task
);

/**
 * @brief Claim a task
 *
 * @param agent Agent claiming the task
 * @param task Task to claim
 * @return Result code
 */
SolanaResult agenc_task_claim(
    AgencAgent *agent,
    AgencTask *task
);

/**
 * @brief Complete a task
 *
 * @param agent Agent completing the task
 * @param task Task to complete
 * @param proof_hash Proof of work hash
 * @param result_data Result data (64 bytes, optional)
 * @return Result code
 */
SolanaResult agenc_task_complete(
    AgencAgent *agent,
    AgencTask *task,
    const uint8_t proof_hash[32],
    const uint8_t result_data[64]
);

/**
 * @brief Cancel a task
 *
 * @param agent Task creator
 * @param task Task to cancel
 * @return Result code
 */
SolanaResult agenc_task_cancel(
    AgencAgent *agent,
    AgencTask *task
);

/**
 * @brief Get task by ID
 *
 * @param agent Agent performing query
 * @param task_creator Task creator public key
 * @param task_id Task identifier
 * @param task Output task handle
 * @return Result code
 */
SolanaResult agenc_task_get(
    AgencAgent *agent,
    const SolanaPubkey *task_creator,
    const uint8_t task_id[32],
    AgencTask *task
);

/**
 * @brief Find tasks matching capabilities
 *
 * @param agent Agent performing search
 * @param capabilities Required capabilities mask
 * @param tasks Output task array
 * @param max_tasks Maximum tasks to return
 * @param count Output actual count
 * @return Result code
 */
SolanaResult agenc_task_find(
    AgencAgent *agent,
    uint64_t capabilities,
    AgencTask *tasks,
    size_t max_tasks,
    size_t *count
);

/*============================================================================
 * State Synchronization
 *============================================================================*/

/**
 * @brief Update shared coordination state
 *
 * @param agent Agent updating state
 * @param state_key State key (32 bytes)
 * @param state_value State value (64 bytes)
 * @param expected_version Expected version for optimistic locking
 * @return Result code
 */
SolanaResult agenc_state_update(
    AgencAgent *agent,
    const uint8_t state_key[32],
    const uint8_t state_value[64],
    uint64_t expected_version
);

/**
 * @brief Get coordination state
 *
 * @param agent Agent querying state
 * @param state_key State key (32 bytes)
 * @param state_value Output state value (64 bytes)
 * @param version Output version
 * @return Result code
 */
SolanaResult agenc_state_get(
    AgencAgent *agent,
    const uint8_t state_key[32],
    uint8_t state_value[64],
    uint64_t *version
);

/**
 * @brief Subscribe to state changes
 *
 * @param agent Agent subscribing
 * @param state_key State key to watch (NULL for all)
 * @return Result code
 */
SolanaResult agenc_state_subscribe(
    AgencAgent *agent,
    const uint8_t state_key[32]
);

/*============================================================================
 * Messaging
 *============================================================================*/

/**
 * @brief Send a message to another agent
 *
 * @param agent Sending agent
 * @param recipient Recipient agent ID (NULL for broadcast)
 * @param type Message type
 * @param payload Message payload
 * @param payload_size Payload size
 * @param routing Routing mode
 * @return Result code
 */
SolanaResult agenc_message_send(
    AgencAgent *agent,
    const uint8_t recipient[32],
    uint16_t type,
    const uint8_t *payload,
    size_t payload_size,
    AgencRoutingMode routing
);

/**
 * @brief Receive next message
 *
 * @param agent Receiving agent
 * @param message Output message
 * @param timeout_ms Timeout (0 for non-blocking)
 * @return Result code
 */
SolanaResult agenc_message_receive(
    AgencAgent *agent,
    AgencMessage *message,
    uint32_t timeout_ms
);

/**
 * @brief Free message payload
 *
 * @param message Message to free
 */
void agenc_message_free(AgencMessage *message);

/*============================================================================
 * Event Loop
 *============================================================================*/

/**
 * @brief Process pending events
 *
 * @param agent Agent to process events for
 * @param max_events Maximum events to process (0 for all)
 * @return Number of events processed
 *
 * @note This should be called regularly to handle callbacks
 */
int agenc_process_events(AgencAgent *agent, int max_events);

/**
 * @brief Run event loop
 *
 * @param agent Agent to run loop for
 * @param timeout_ms Timeout for each iteration (0 for default)
 * @param running Pointer to control flag (set to false to stop)
 * @return Result code when loop exits
 */
SolanaResult agenc_run_loop(
    AgencAgent *agent,
    uint32_t timeout_ms,
    volatile bool *running
);

/*============================================================================
 * Utility Functions
 *============================================================================*/

/**
 * @brief Get current Solana slot
 *
 * @param agent Agent to query with
 * @param slot Output slot number
 * @return Result code
 */
SolanaResult agenc_get_slot(AgencAgent *agent, uint64_t *slot);

/**
 * @brief Get agent balance
 *
 * @param agent Agent to query
 * @param lamports Output balance
 * @return Result code
 */
SolanaResult agenc_get_balance(AgencAgent *agent, uint64_t *lamports);

/**
 * @brief Generate random task ID
 *
 * @param task_id Output task ID (32 bytes)
 */
void agenc_generate_task_id(uint8_t task_id[32]);

/**
 * @brief Generate random agent ID
 *
 * @param agent_id Output agent ID (32 bytes)
 */
void agenc_generate_agent_id(uint8_t agent_id[32]);

#ifdef __cplusplus
}
#endif

#endif /* AGENC_SOLANA_H_ */
