/**
 * @file solana_types.h
 * @brief Core type definitions for AgenC Solana Communication Module
 *
 * Defines fundamental types, constants, and data structures used throughout
 * the Solana communication layer. Designed for minimal footprint and
 * compatibility with embedded systems.
 */

#ifndef AGENC_SOLANA_TYPES_H_
#define AGENC_SOLANA_TYPES_H_

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdatomic.h>

#ifdef __cplusplus
extern "C" {
#endif

/*============================================================================
 * Constants
 *============================================================================*/

/** Maximum RPC endpoint URL length */
#define SOLANA_MAX_ENDPOINT_LEN 256

/** Maximum network name length */
#define SOLANA_MAX_NETWORK_LEN 32

/** Ed25519 public key size in bytes */
#define SOLANA_PUBKEY_SIZE 32

/** Ed25519 signature size in bytes */
#define SOLANA_SIGNATURE_SIZE 64

/** Maximum transaction size in bytes */
#define SOLANA_MAX_TX_SIZE 1232

/** Maximum message payload size */
#define SOLANA_MAX_PAYLOAD_SIZE 1024

/** Maximum number of instructions per transaction */
#define SOLANA_MAX_INSTRUCTIONS 8

/** Maximum number of accounts per instruction */
#define SOLANA_MAX_ACCOUNTS 16

/** Message queue capacity */
#define SOLANA_MSG_QUEUE_SIZE 64

/** WebSocket reconnect timeout (ms) */
#define SOLANA_WS_RECONNECT_MS 5000

/** Default RPC timeout (ms) */
#define SOLANA_DEFAULT_TIMEOUT_MS 30000

/** Commitment levels */
#define SOLANA_COMMITMENT_PROCESSED 0
#define SOLANA_COMMITMENT_CONFIRMED 1
#define SOLANA_COMMITMENT_FINALIZED 2

/*============================================================================
 * Result Codes
 *============================================================================*/

/**
 * @brief Result codes for Solana communication operations
 */
typedef enum SolanaResult {
    SOLANA_SUCCESS = 0,
    SOLANA_ERROR_NULL_POINTER = -1,
    SOLANA_ERROR_INVALID_STATE = -2,
    SOLANA_ERROR_OVERFLOW = -3,
    SOLANA_ERROR_ATOMIC_FAILURE = -4,
    SOLANA_ERROR_RPC_FAILED = -5,
    SOLANA_ERROR_SIGNATURE_INVALID = -6,
    SOLANA_ERROR_TX_FAILED = -7,
    SOLANA_ERROR_CONNECTION_FAILED = -8,
    SOLANA_ERROR_TIMEOUT = -9,
    SOLANA_ERROR_INVALID_PARAMS = -10,
    SOLANA_ERROR_SERIALIZATION = -11,
    SOLANA_ERROR_DESERIALIZATION = -12,
    SOLANA_ERROR_INSUFFICIENT_FUNDS = -13,
    SOLANA_ERROR_ACCOUNT_NOT_FOUND = -14,
    SOLANA_ERROR_PROGRAM_ERROR = -15,
    SOLANA_ERROR_QUEUE_FULL = -16,
    SOLANA_ERROR_QUEUE_EMPTY = -17,
    SOLANA_ERROR_NOT_INITIALIZED = -18,
    SOLANA_ERROR_ALREADY_INITIALIZED = -19,
    SOLANA_ERROR_MEMORY = -20,
} SolanaResult;

/*============================================================================
 * Status Management (Following AgenC StrategyStatus pattern)
 *============================================================================*/

/**
 * @brief Communication strategy status states
 */
typedef enum SolanaStatus {
    SOLANA_STATE_UNINITIALIZED = 0,
    SOLANA_STATE_INITIALIZED,
    SOLANA_STATE_CONNECTING,
    SOLANA_STATE_CONNECTED,
    SOLANA_STATE_DISCONNECTED,
    SOLANA_STATE_ERROR,
    SOLANA_STATE_TRANSITIONING,
    SOLANA_MAX_STATE = SOLANA_STATE_TRANSITIONING
} SolanaStatus;

/**
 * @brief Thread-safe status tracker following AgenC pattern
 */
typedef struct SolanaStatusTracker {
    volatile _Atomic(SolanaStatus) current_status;
    volatile _Atomic(uint64_t) transition_count;
    volatile _Atomic(uint64_t) error_count;
    volatile _Atomic(int64_t) last_error_code;
} SolanaStatusTracker;

/*============================================================================
 * Cryptographic Types
 *============================================================================*/

/**
 * @brief Ed25519 public key
 */
typedef struct SolanaPubkey {
    uint8_t bytes[SOLANA_PUBKEY_SIZE];
} SolanaPubkey;

/**
 * @brief Ed25519 signature
 */
typedef struct SolanaSignature {
    uint8_t bytes[SOLANA_SIGNATURE_SIZE];
} SolanaSignature;

/**
 * @brief Ed25519 keypair (public + secret key)
 */
typedef struct SolanaKeypair {
    uint8_t secret_key[64];  /* Full 64-byte secret key (includes public key) */
    SolanaPubkey pubkey;
} SolanaKeypair;

/*============================================================================
 * Account Types
 *============================================================================*/

/**
 * @brief Account metadata for instruction building
 */
typedef struct SolanaAccountMeta {
    SolanaPubkey pubkey;
    bool is_signer;
    bool is_writable;
} SolanaAccountMeta;

/**
 * @brief Account info returned from RPC
 */
typedef struct SolanaAccountInfo {
    SolanaPubkey pubkey;
    uint64_t lamports;
    uint64_t data_len;
    uint8_t *data;
    SolanaPubkey owner;
    bool executable;
    uint64_t rent_epoch;
} SolanaAccountInfo;

/*============================================================================
 * Transaction Types
 *============================================================================*/

/**
 * @brief Single instruction for transaction
 */
typedef struct SolanaInstruction {
    SolanaPubkey program_id;
    SolanaAccountMeta accounts[SOLANA_MAX_ACCOUNTS];
    uint8_t num_accounts;
    uint8_t *data;
    size_t data_len;
} SolanaInstruction;

/**
 * @brief Transaction header
 */
typedef struct SolanaTxHeader {
    uint8_t num_required_signatures;
    uint8_t num_readonly_signed;
    uint8_t num_readonly_unsigned;
} SolanaTxHeader;

/**
 * @brief Complete transaction message
 */
typedef struct SolanaTxMessage {
    SolanaTxHeader header;
    SolanaPubkey account_keys[SOLANA_MAX_ACCOUNTS * SOLANA_MAX_INSTRUCTIONS];
    uint8_t num_account_keys;
    uint8_t recent_blockhash[32];
    SolanaInstruction instructions[SOLANA_MAX_INSTRUCTIONS];
    uint8_t num_instructions;
} SolanaTxMessage;

/**
 * @brief Signed transaction ready for submission
 */
typedef struct SolanaTransaction {
    SolanaTxMessage message;
    SolanaSignature signatures[SOLANA_MAX_ACCOUNTS];
    uint8_t num_signatures;
    uint8_t serialized[SOLANA_MAX_TX_SIZE];
    size_t serialized_len;
} SolanaTransaction;

/*============================================================================
 * AgenC Coordination Protocol Types
 *============================================================================*/

/**
 * @brief Agent capability flags (must match Rust program)
 */
typedef enum AgentCapability {
    AGENT_CAP_COMPUTE = 1 << 0,
    AGENT_CAP_INFERENCE = 1 << 1,
    AGENT_CAP_STORAGE = 1 << 2,
    AGENT_CAP_NETWORK = 1 << 3,
    AGENT_CAP_SENSOR = 1 << 4,
    AGENT_CAP_ACTUATOR = 1 << 5,
    AGENT_CAP_COORDINATOR = 1 << 6,
    AGENT_CAP_ARBITER = 1 << 7,
    AGENT_CAP_VALIDATOR = 1 << 8,
    AGENT_CAP_AGGREGATOR = 1 << 9,
} AgentCapability;

/**
 * @brief Agent registration data
 */
typedef struct AgentRegistration {
    uint8_t agent_id[32];
    SolanaPubkey authority;
    uint64_t capabilities;
    uint8_t status;
    char endpoint[128];
    char metadata_uri[128];
    int64_t registered_at;
    int64_t last_active;
    uint64_t tasks_completed;
    uint64_t total_earned;
    uint16_t reputation;
    uint8_t active_tasks;
    uint64_t stake;
    uint8_t _reserved[32];  /* Reserved for internal use */
} AgentRegistration;

/**
 * @brief Task status (must match Rust program)
 */
typedef enum TaskStatus {
    TASK_STATUS_OPEN = 0,
    TASK_STATUS_IN_PROGRESS,
    TASK_STATUS_PENDING_VALIDATION,
    TASK_STATUS_COMPLETED,
    TASK_STATUS_CANCELLED,
    TASK_STATUS_DISPUTED,
} TaskStatus;

/**
 * @brief Task type (must match Rust program)
 */
typedef enum TaskType {
    TASK_TYPE_EXCLUSIVE = 0,
    TASK_TYPE_COLLABORATIVE,
    TASK_TYPE_COMPETITIVE,
} TaskType;

/**
 * @brief Task data
 */
typedef struct TaskData {
    uint8_t task_id[32];
    SolanaPubkey creator;
    uint64_t required_capabilities;
    uint8_t description[64];
    uint64_t reward_amount;
    uint8_t max_workers;
    uint8_t current_workers;
    TaskStatus status;
    TaskType task_type;
    int64_t created_at;
    int64_t deadline;
    int64_t completed_at;
    SolanaPubkey escrow;
    uint8_t result[64];
    uint8_t completions;
    uint8_t required_completions;
} TaskData;

/**
 * @brief Coordination state entry
 */
typedef struct CoordinationState {
    uint8_t state_key[32];
    uint8_t state_value[64];
    SolanaPubkey last_updater;
    uint64_t version;
    int64_t updated_at;
} CoordinationState;

/*============================================================================
 * Message Types for Real-time Communication
 *============================================================================*/

/**
 * @brief Message types for protocol communication
 */
typedef enum SolanaMsgType {
    SOLANA_MSG_TX_REQUEST = 1,
    SOLANA_MSG_TX_CONFIRM = 2,
    SOLANA_MSG_ACCOUNT_UPDATE = 3,
    SOLANA_MSG_TASK_CREATED = 4,
    SOLANA_MSG_TASK_CLAIMED = 5,
    SOLANA_MSG_TASK_COMPLETED = 6,
    SOLANA_MSG_STATE_UPDATED = 7,
    SOLANA_MSG_HEARTBEAT = 8,
    SOLANA_MSG_ERROR = 9,
} SolanaMsgType;

/**
 * @brief Message header for protocol messages
 */
typedef struct SolanaMsgHeader {
    SolanaSignature signature;
    SolanaPubkey sender;
    uint64_t timestamp;
    uint32_t sequence;
    uint16_t flags;
    SolanaMsgType type;
} SolanaMsgHeader;

/**
 * @brief Protocol message
 */
typedef struct SolanaMessage {
    SolanaMsgHeader header;
    uint8_t *payload;
    size_t payload_size;
    uint64_t message_id;
} SolanaMessage;

/*============================================================================
 * Statistics
 *============================================================================*/

/**
 * @brief Communication statistics
 */
typedef struct SolanaCommStats {
    _Atomic(uint64_t) messages_sent;
    _Atomic(uint64_t) messages_received;
    _Atomic(uint64_t) bytes_sent;
    _Atomic(uint64_t) bytes_received;
    _Atomic(uint64_t) transactions_submitted;
    _Atomic(uint64_t) transactions_confirmed;
    _Atomic(uint64_t) transactions_failed;
    _Atomic(uint64_t) total_latency_us;
    _Atomic(uint64_t) rpc_requests;
    _Atomic(uint64_t) rpc_errors;
    _Atomic(uint64_t) ws_reconnects;
} SolanaCommStats;

#ifdef __cplusplus
}
#endif

#endif /* AGENC_SOLANA_TYPES_H_ */
