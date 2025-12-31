/**
 * @file solana_comm.h
 * @brief Solana Communication Strategy Interface for AgenC
 *
 * This module provides a thread-safe, lock-free communication interface
 * for interacting with the Solana blockchain. Follows AgenC's interface
 * patterns using function pointers and StatusTracker for state management.
 *
 * @note Thread-safe: All public functions are thread-safe
 * @note Lock-free: Uses atomic operations for synchronization
 */

#ifndef AGENC_SOLANA_COMM_H_
#define AGENC_SOLANA_COMM_H_

#include "solana_types.h"

#ifdef __cplusplus
extern "C" {
#endif

/*============================================================================
 * Forward Declarations
 *============================================================================*/

typedef struct SolanaCommStrategy SolanaCommStrategy;
typedef struct SolanaRpcClient SolanaRpcClient;

/*============================================================================
 * Configuration
 *============================================================================*/

/**
 * @brief Configuration for Solana communication strategy
 */
typedef struct SolanaCommConfig {
    /** RPC endpoint URL (required) */
    const char *rpc_endpoint;

    /** WebSocket endpoint URL (optional, derived from RPC if NULL) */
    const char *ws_endpoint;

    /** Network name: "devnet", "testnet", "mainnet-beta" */
    const char *network;

    /** Commitment level for confirmations */
    uint8_t commitment;

    /** Connection timeout in milliseconds */
    uint32_t timeout_ms;

    /** Enable WebSocket subscriptions */
    bool enable_websocket;

    /** Auto-reconnect on disconnect */
    bool auto_reconnect;

    /** Maximum retry attempts */
    uint8_t max_retries;

    /** Program ID for AgenC Coordination */
    SolanaPubkey program_id;

    /** Agent keypair for signing */
    SolanaKeypair *keypair;
} SolanaCommConfig;

/*============================================================================
 * Communication Strategy Interface (Following AgenC Pattern)
 *============================================================================*/

/**
 * @brief Solana Communication Strategy Interface
 *
 * Implements the AgenC communication module pattern using function pointers.
 * Provides thread-safe access to Solana blockchain for agent coordination.
 */
struct SolanaCommStrategy {
    /*------------------------------------------------------------------------
     * Core Communication Operations
     *------------------------------------------------------------------------*/

    /**
     * @brief Send a message/transaction to the network
     * @param self Strategy instance
     * @param message Message to send
     * @return Result code
     * @note Thread-safe
     */
    SolanaResult (*send_message)(
        struct SolanaCommStrategy *self,
        const SolanaMessage *message
    );

    /**
     * @brief Receive a message from subscriptions
     * @param self Strategy instance
     * @param message Buffer for received message
     * @param timeout_ms Timeout (0 = non-blocking)
     * @return Result code
     * @note Thread-safe
     */
    SolanaResult (*receive_message)(
        struct SolanaCommStrategy *self,
        SolanaMessage *message,
        uint32_t timeout_ms
    );

    /**
     * @brief Submit a transaction to the network
     * @param self Strategy instance
     * @param tx Transaction to submit
     * @param signature Output signature
     * @return Result code
     * @note Thread-safe
     */
    SolanaResult (*submit_transaction)(
        struct SolanaCommStrategy *self,
        const SolanaTransaction *tx,
        SolanaSignature *signature
    );

    /**
     * @brief Confirm a transaction
     * @param self Strategy instance
     * @param signature Transaction signature
     * @param confirmed Output confirmation status
     * @return Result code
     * @note Thread-safe
     */
    SolanaResult (*confirm_transaction)(
        struct SolanaCommStrategy *self,
        const SolanaSignature *signature,
        bool *confirmed
    );

    /*------------------------------------------------------------------------
     * Account Operations
     *------------------------------------------------------------------------*/

    /**
     * @brief Get account info
     * @param self Strategy instance
     * @param pubkey Account public key
     * @param info Output account info
     * @return Result code
     * @note Thread-safe
     */
    SolanaResult (*get_account_info)(
        struct SolanaCommStrategy *self,
        const SolanaPubkey *pubkey,
        SolanaAccountInfo *info
    );

    /**
     * @brief Subscribe to account changes
     * @param self Strategy instance
     * @param pubkey Account to watch
     * @param subscription_id Output subscription ID
     * @return Result code
     * @note Thread-safe
     */
    SolanaResult (*subscribe_account)(
        struct SolanaCommStrategy *self,
        const SolanaPubkey *pubkey,
        uint64_t *subscription_id
    );

    /**
     * @brief Unsubscribe from account changes
     * @param self Strategy instance
     * @param subscription_id Subscription to cancel
     * @return Result code
     * @note Thread-safe
     */
    SolanaResult (*unsubscribe_account)(
        struct SolanaCommStrategy *self,
        uint64_t subscription_id
    );

    /*------------------------------------------------------------------------
     * AgenC Coordination Protocol Operations
     *------------------------------------------------------------------------*/

    /**
     * @brief Register an agent on-chain
     * @param self Strategy instance
     * @param agent_id Unique agent identifier
     * @param capabilities Agent capability bitmask
     * @param endpoint Network endpoint
     * @param signature Output transaction signature
     * @return Result code
     * @note Thread-safe
     */
    SolanaResult (*register_agent)(
        struct SolanaCommStrategy *self,
        const uint8_t agent_id[32],
        uint64_t capabilities,
        const char *endpoint,
        SolanaSignature *signature
    );

    /**
     * @brief Create a new task
     * @param self Strategy instance
     * @param task_id Task identifier
     * @param capabilities Required capabilities
     * @param description Task description
     * @param reward_lamports Reward amount
     * @param max_workers Maximum workers
     * @param deadline Unix timestamp (0 = none)
     * @param task_type Task type
     * @param signature Output transaction signature
     * @return Result code
     * @note Thread-safe
     */
    SolanaResult (*create_task)(
        struct SolanaCommStrategy *self,
        const uint8_t task_id[32],
        uint64_t capabilities,
        const uint8_t description[64],
        uint64_t reward_lamports,
        uint8_t max_workers,
        int64_t deadline,
        TaskType task_type,
        SolanaSignature *signature
    );

    /**
     * @brief Claim a task
     * @param self Strategy instance
     * @param task_pubkey Task account public key
     * @param signature Output transaction signature
     * @return Result code
     * @note Thread-safe
     */
    SolanaResult (*claim_task)(
        struct SolanaCommStrategy *self,
        const SolanaPubkey *task_pubkey,
        SolanaSignature *signature
    );

    /**
     * @brief Complete a task
     * @param self Strategy instance
     * @param task_pubkey Task account public key
     * @param proof_hash Proof of work hash
     * @param result_data Result data (optional)
     * @param signature Output transaction signature
     * @return Result code
     * @note Thread-safe
     */
    SolanaResult (*complete_task)(
        struct SolanaCommStrategy *self,
        const SolanaPubkey *task_pubkey,
        const uint8_t proof_hash[32],
        const uint8_t result_data[64],
        SolanaSignature *signature
    );

    /**
     * @brief Update coordination state
     * @param self Strategy instance
     * @param state_key State key
     * @param state_value State value
     * @param expected_version Expected version for optimistic lock
     * @param signature Output transaction signature
     * @return Result code
     * @note Thread-safe
     */
    SolanaResult (*update_state)(
        struct SolanaCommStrategy *self,
        const uint8_t state_key[32],
        const uint8_t state_value[64],
        uint64_t expected_version,
        SolanaSignature *signature
    );

    /**
     * @brief Get agent registration
     * @param self Strategy instance
     * @param agent_id Agent identifier
     * @param registration Output registration data
     * @return Result code
     * @note Thread-safe
     */
    SolanaResult (*get_agent)(
        struct SolanaCommStrategy *self,
        const uint8_t agent_id[32],
        AgentRegistration *registration
    );

    /**
     * @brief Get task data
     * @param self Strategy instance
     * @param task_pubkey Task account public key
     * @param task Output task data
     * @return Result code
     * @note Thread-safe
     */
    SolanaResult (*get_task)(
        struct SolanaCommStrategy *self,
        const SolanaPubkey *task_pubkey,
        TaskData *task
    );

    /**
     * @brief Get coordination state
     * @param self Strategy instance
     * @param state_key State key
     * @param state Output state data
     * @return Result code
     * @note Thread-safe
     */
    SolanaResult (*get_state)(
        struct SolanaCommStrategy *self,
        const uint8_t state_key[32],
        CoordinationState *state
    );

    /*------------------------------------------------------------------------
     * Status and Validation (Following AgenC Pattern)
     *------------------------------------------------------------------------*/

    /**
     * @brief Get current status
     * @param self Strategy instance
     * @return Current status
     * @note Thread-safe
     */
    SolanaStatus (*get_status)(struct SolanaCommStrategy *self);

    /**
     * @brief Validate strategy integrity
     * @param self Strategy instance
     * @return true if valid
     * @note Thread-safe
     */
    bool (*validate)(struct SolanaCommStrategy *self);

    /**
     * @brief Check if connected
     * @param self Strategy instance
     * @return true if connected
     * @note Thread-safe
     */
    bool (*is_connected)(struct SolanaCommStrategy *self);

    /**
     * @brief Get communication statistics
     * @param self Strategy instance
     * @param stats Output statistics
     * @return Result code
     * @note Thread-safe
     */
    SolanaResult (*get_stats)(
        struct SolanaCommStrategy *self,
        SolanaCommStats *stats
    );

    /*------------------------------------------------------------------------
     * Connection Management
     *------------------------------------------------------------------------*/

    /**
     * @brief Connect to the network
     * @param self Strategy instance
     * @return Result code
     * @note Thread-safe
     */
    SolanaResult (*connect)(struct SolanaCommStrategy *self);

    /**
     * @brief Disconnect from the network
     * @param self Strategy instance
     * @return Result code
     * @note Thread-safe
     */
    SolanaResult (*disconnect)(struct SolanaCommStrategy *self);

    /**
     * @brief Reconnect to the network
     * @param self Strategy instance
     * @return Result code
     * @note Thread-safe
     */
    SolanaResult (*reconnect)(struct SolanaCommStrategy *self);

    /*------------------------------------------------------------------------
     * Internal State (Opaque to Users)
     *------------------------------------------------------------------------*/

    /** Status tracker for thread-safe state management */
    SolanaStatusTracker *status_tracker;

    /** Implementation-specific data */
    void *impl_data;

    /** Configuration reference */
    SolanaCommConfig config;
};

/*============================================================================
 * Public API Functions
 *============================================================================*/

/**
 * @brief Create and initialize a Solana communication strategy
 *
 * @param config Configuration parameters
 * @return Pointer to initialized strategy, or NULL on failure
 *
 * @note Thread-safe for creation, but returned instance should be
 *       used from a single thread or with external synchronization
 *       for initialization.
 *
 * @example
 * SolanaCommConfig config = {
 *     .rpc_endpoint = "https://api.devnet.solana.com",
 *     .network = "devnet",
 *     .commitment = SOLANA_COMMITMENT_CONFIRMED,
 *     .timeout_ms = 30000,
 *     .enable_websocket = true,
 *     .keypair = &my_keypair,
 * };
 * SolanaCommStrategy *comm = solana_comm_create(&config);
 */
SolanaCommStrategy *solana_comm_create(const SolanaCommConfig *config);

/**
 * @brief Destroy and cleanup a communication strategy
 *
 * @param strategy Strategy to destroy
 *
 * @note This function is NOT thread-safe. Ensure no other threads
 *       are using the strategy before calling.
 */
void solana_comm_destroy(SolanaCommStrategy *strategy);

/**
 * @brief Initialize status tracker
 *
 * @param tracker Status tracker to initialize
 * @return Result code
 *
 * @note Thread-safe
 */
SolanaResult solana_status_init(SolanaStatusTracker *tracker);

/**
 * @brief Transition status to new state
 *
 * @param tracker Status tracker
 * @param new_status New status to transition to
 * @return Result code (SOLANA_ERROR_INVALID_STATE if transition not allowed)
 *
 * @note Thread-safe, atomic
 */
SolanaResult solana_status_transition(
    SolanaStatusTracker *tracker,
    SolanaStatus new_status
);

/**
 * @brief Get current status
 *
 * @param tracker Status tracker
 * @param status Output current status
 * @return Result code
 *
 * @note Thread-safe
 */
SolanaResult solana_status_get(
    const SolanaStatusTracker *tracker,
    SolanaStatus *status
);

/*============================================================================
 * Utility Functions
 *============================================================================*/

/**
 * @brief Derive PDA for agent registration
 *
 * @param program_id Program ID
 * @param agent_id Agent identifier
 * @param pda Output PDA public key
 * @param bump Output bump seed
 * @return Result code
 */
SolanaResult solana_derive_agent_pda(
    const SolanaPubkey *program_id,
    const uint8_t agent_id[32],
    SolanaPubkey *pda,
    uint8_t *bump
);

/**
 * @brief Derive PDA for task
 *
 * @param program_id Program ID
 * @param creator Task creator
 * @param task_id Task identifier
 * @param pda Output PDA public key
 * @param bump Output bump seed
 * @return Result code
 */
SolanaResult solana_derive_task_pda(
    const SolanaPubkey *program_id,
    const SolanaPubkey *creator,
    const uint8_t task_id[32],
    SolanaPubkey *pda,
    uint8_t *bump
);

/**
 * @brief Derive PDA for coordination state
 *
 * @param program_id Program ID
 * @param state_key State key
 * @param pda Output PDA public key
 * @param bump Output bump seed
 * @return Result code
 */
SolanaResult solana_derive_state_pda(
    const SolanaPubkey *program_id,
    const uint8_t state_key[32],
    SolanaPubkey *pda,
    uint8_t *bump
);

/**
 * @brief Convert public key to base58 string
 *
 * @param pubkey Public key
 * @param output Output buffer (must be at least 45 bytes)
 * @param output_len Output buffer length
 * @return Result code
 */
SolanaResult solana_pubkey_to_base58(
    const SolanaPubkey *pubkey,
    char *output,
    size_t output_len
);

/**
 * @brief Parse base58 string to public key
 *
 * @param base58 Base58 encoded string
 * @param pubkey Output public key
 * @return Result code
 */
SolanaResult solana_pubkey_from_base58(
    const char *base58,
    SolanaPubkey *pubkey
);

/**
 * @brief Get result code description
 *
 * @param result Result code
 * @return Human-readable description
 */
const char *solana_result_str(SolanaResult result);

/**
 * @brief Get status description
 *
 * @param status Status code
 * @return Human-readable description
 */
const char *solana_status_str(SolanaStatus status);

#ifdef __cplusplus
}
#endif

#endif /* AGENC_SOLANA_COMM_H_ */
