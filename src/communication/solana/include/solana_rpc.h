/**
 * @file solana_rpc.h
 * @brief Low-level Solana JSON-RPC client
 *
 * Provides direct access to Solana RPC methods for transaction
 * submission, account queries, and network status.
 */

#ifndef AGENC_SOLANA_RPC_H_
#define AGENC_SOLANA_RPC_H_

#include "solana_types.h"

#ifdef __cplusplus
extern "C" {
#endif

/*============================================================================
 * RPC Client Types
 *============================================================================*/

/**
 * @brief RPC client configuration
 */
typedef struct SolanaRpcConfig {
    const char *endpoint;
    uint32_t timeout_ms;
    uint8_t max_retries;
    uint8_t commitment;
} SolanaRpcConfig;

/**
 * @brief RPC client handle (opaque)
 */
typedef struct SolanaRpcClient SolanaRpcClient;

/**
 * @brief RPC response for account info
 */
typedef struct SolanaRpcAccountResponse {
    bool exists;
    SolanaAccountInfo info;
    uint64_t slot;
} SolanaRpcAccountResponse;

/**
 * @brief RPC response for transaction status
 */
typedef struct SolanaRpcTxStatus {
    bool found;
    bool confirmed;
    bool finalized;
    int64_t err;  /* 0 if no error */
    uint64_t slot;
} SolanaRpcTxStatus;

/**
 * @brief RPC response for blockhash
 */
typedef struct SolanaRpcBlockhash {
    uint8_t blockhash[32];
    uint64_t last_valid_block_height;
    uint64_t slot;
} SolanaRpcBlockhash;

/**
 * @brief RPC response for balance
 */
typedef struct SolanaRpcBalance {
    uint64_t lamports;
    uint64_t slot;
} SolanaRpcBalance;

/*============================================================================
 * RPC Client Lifecycle
 *============================================================================*/

/**
 * @brief Create RPC client
 *
 * @param config Client configuration
 * @return Client handle or NULL on failure
 */
SolanaRpcClient *solana_rpc_create(const SolanaRpcConfig *config);

/**
 * @brief Destroy RPC client
 *
 * @param client Client to destroy
 */
void solana_rpc_destroy(SolanaRpcClient *client);

/*============================================================================
 * Account Methods
 *============================================================================*/

/**
 * @brief Get account info
 *
 * @param client RPC client
 * @param pubkey Account public key
 * @param response Output response
 * @return Result code
 */
SolanaResult solana_rpc_get_account_info(
    SolanaRpcClient *client,
    const SolanaPubkey *pubkey,
    SolanaRpcAccountResponse *response
);

/**
 * @brief Get account balance
 *
 * @param client RPC client
 * @param pubkey Account public key
 * @param balance Output balance
 * @return Result code
 */
SolanaResult solana_rpc_get_balance(
    SolanaRpcClient *client,
    const SolanaPubkey *pubkey,
    SolanaRpcBalance *balance
);

/**
 * @brief Get multiple accounts
 *
 * @param client RPC client
 * @param pubkeys Array of public keys
 * @param count Number of public keys
 * @param responses Output responses array
 * @return Result code
 */
SolanaResult solana_rpc_get_multiple_accounts(
    SolanaRpcClient *client,
    const SolanaPubkey *pubkeys,
    size_t count,
    SolanaRpcAccountResponse *responses
);

/*============================================================================
 * Transaction Methods
 *============================================================================*/

/**
 * @brief Get recent blockhash
 *
 * @param client RPC client
 * @param blockhash Output blockhash response
 * @return Result code
 */
SolanaResult solana_rpc_get_latest_blockhash(
    SolanaRpcClient *client,
    SolanaRpcBlockhash *blockhash
);

/**
 * @brief Send transaction
 *
 * @param client RPC client
 * @param tx_data Serialized transaction bytes
 * @param tx_len Transaction length
 * @param signature Output signature
 * @return Result code
 */
SolanaResult solana_rpc_send_transaction(
    SolanaRpcClient *client,
    const uint8_t *tx_data,
    size_t tx_len,
    SolanaSignature *signature
);

/**
 * @brief Get transaction status
 *
 * @param client RPC client
 * @param signature Transaction signature
 * @param status Output status
 * @return Result code
 */
SolanaResult solana_rpc_get_signature_status(
    SolanaRpcClient *client,
    const SolanaSignature *signature,
    SolanaRpcTxStatus *status
);

/**
 * @brief Simulate transaction
 *
 * @param client RPC client
 * @param tx_data Serialized transaction bytes
 * @param tx_len Transaction length
 * @param logs Output logs buffer
 * @param logs_size Logs buffer size
 * @param units_consumed Output compute units
 * @return Result code
 */
SolanaResult solana_rpc_simulate_transaction(
    SolanaRpcClient *client,
    const uint8_t *tx_data,
    size_t tx_len,
    char *logs,
    size_t logs_size,
    uint64_t *units_consumed
);

/**
 * @brief Confirm transaction with timeout
 *
 * @param client RPC client
 * @param signature Transaction signature
 * @param timeout_ms Timeout in milliseconds
 * @param confirmed Output confirmation status
 * @return Result code
 */
SolanaResult solana_rpc_confirm_transaction(
    SolanaRpcClient *client,
    const SolanaSignature *signature,
    uint32_t timeout_ms,
    bool *confirmed
);

/*============================================================================
 * Network Methods
 *============================================================================*/

/**
 * @brief Get cluster nodes
 *
 * @param client RPC client
 * @param node_count Output number of nodes
 * @return Result code
 */
SolanaResult solana_rpc_get_cluster_nodes(
    SolanaRpcClient *client,
    uint32_t *node_count
);

/**
 * @brief Get epoch info
 *
 * @param client RPC client
 * @param epoch Output current epoch
 * @param slot_index Output slot index within epoch
 * @param slots_in_epoch Output total slots in epoch
 * @return Result code
 */
SolanaResult solana_rpc_get_epoch_info(
    SolanaRpcClient *client,
    uint64_t *epoch,
    uint64_t *slot_index,
    uint64_t *slots_in_epoch
);

/**
 * @brief Get minimum balance for rent exemption
 *
 * @param client RPC client
 * @param data_len Account data length
 * @param lamports Output minimum lamports
 * @return Result code
 */
SolanaResult solana_rpc_get_minimum_balance(
    SolanaRpcClient *client,
    size_t data_len,
    uint64_t *lamports
);

/**
 * @brief Check RPC health
 *
 * @param client RPC client
 * @return SOLANA_SUCCESS if healthy
 */
SolanaResult solana_rpc_health(SolanaRpcClient *client);

/*============================================================================
 * Program Account Methods
 *============================================================================*/

/**
 * @brief Get program accounts with filters
 *
 * @param client RPC client
 * @param program_id Program ID
 * @param filters Filter configuration (implementation-specific)
 * @param accounts Output accounts array
 * @param max_accounts Maximum accounts to return
 * @param count Output actual count
 * @return Result code
 */
SolanaResult solana_rpc_get_program_accounts(
    SolanaRpcClient *client,
    const SolanaPubkey *program_id,
    const void *filters,
    SolanaAccountInfo *accounts,
    size_t max_accounts,
    size_t *count
);

#ifdef __cplusplus
}
#endif

#endif /* AGENC_SOLANA_RPC_H_ */
