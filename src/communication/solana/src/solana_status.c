/**
 * @file solana_status.c
 * @brief Status tracker implementation following AgenC pattern
 *
 * Thread-safe status management using atomic operations.
 */

#include "../include/solana_comm.h"
#include <string.h>

/*============================================================================
 * State Transition Matrix
 *
 * Defines valid transitions between states.
 * 1 = valid transition, 0 = invalid
 *============================================================================*/

static const uint8_t status_transitions[SOLANA_MAX_STATE + 1][SOLANA_MAX_STATE + 1] = {
    /*                 UNINIT INIT  CONN_ING CONN  DISC  ERROR TRANS */
    /* UNINITIALIZED */ {0,    1,    0,       0,    0,    1,    0},
    /* INITIALIZED   */ {0,    0,    1,       0,    1,    1,    1},
    /* CONNECTING    */ {0,    0,    0,       1,    1,    1,    1},
    /* CONNECTED     */ {0,    0,    0,       0,    1,    1,    1},
    /* DISCONNECTED  */ {0,    1,    1,       0,    0,    1,    1},
    /* ERROR         */ {1,    1,    1,       0,    1,    0,    1},
    /* TRANSITIONING */ {1,    1,    1,       1,    1,    1,    0},
};

/*============================================================================
 * Status Tracker Implementation
 *============================================================================*/

SolanaResult solana_status_init(SolanaStatusTracker *tracker) {
    if (tracker == NULL) {
        return SOLANA_ERROR_NULL_POINTER;
    }

    atomic_store_explicit(
        &tracker->current_status,
        SOLANA_STATE_UNINITIALIZED,
        memory_order_release
    );
    atomic_store_explicit(&tracker->transition_count, 0, memory_order_release);
    atomic_store_explicit(&tracker->error_count, 0, memory_order_release);
    atomic_store_explicit(&tracker->last_error_code, 0, memory_order_release);

    /* Transition to initialized state */
    atomic_store_explicit(
        &tracker->current_status,
        SOLANA_STATE_INITIALIZED,
        memory_order_release
    );
    atomic_fetch_add_explicit(&tracker->transition_count, 1, memory_order_release);

    return SOLANA_SUCCESS;
}

SolanaResult solana_status_transition(
    SolanaStatusTracker *tracker,
    SolanaStatus new_status
) {
    if (tracker == NULL) {
        return SOLANA_ERROR_NULL_POINTER;
    }

    if (new_status > SOLANA_MAX_STATE) {
        return SOLANA_ERROR_INVALID_PARAMS;
    }

    SolanaStatus current = atomic_load_explicit(
        &tracker->current_status,
        memory_order_acquire
    );

    /* Check if transition is valid */
    if (!status_transitions[current][new_status]) {
        atomic_fetch_add_explicit(&tracker->error_count, 1, memory_order_release);
        return SOLANA_ERROR_INVALID_STATE;
    }

    /* Attempt atomic compare-and-swap */
    bool success = atomic_compare_exchange_strong_explicit(
        &tracker->current_status,
        &current,
        new_status,
        memory_order_seq_cst,
        memory_order_seq_cst
    );

    if (!success) {
        atomic_fetch_add_explicit(&tracker->error_count, 1, memory_order_release);
        return SOLANA_ERROR_ATOMIC_FAILURE;
    }

    atomic_fetch_add_explicit(&tracker->transition_count, 1, memory_order_release);

    /* Track error count if transitioning to error state */
    if (new_status == SOLANA_STATE_ERROR) {
        atomic_fetch_add_explicit(&tracker->error_count, 1, memory_order_release);
    }

    return SOLANA_SUCCESS;
}

SolanaResult solana_status_get(
    const SolanaStatusTracker *tracker,
    SolanaStatus *status
) {
    if (tracker == NULL || status == NULL) {
        return SOLANA_ERROR_NULL_POINTER;
    }

    *status = atomic_load_explicit(
        (volatile _Atomic(SolanaStatus) *)&tracker->current_status,
        memory_order_acquire
    );

    return SOLANA_SUCCESS;
}

/*============================================================================
 * String Conversion Functions
 *============================================================================*/

const char *solana_result_str(SolanaResult result) {
    switch (result) {
        case SOLANA_SUCCESS:
            return "Success";
        case SOLANA_ERROR_NULL_POINTER:
            return "Null pointer";
        case SOLANA_ERROR_INVALID_STATE:
            return "Invalid state";
        case SOLANA_ERROR_OVERFLOW:
            return "Overflow";
        case SOLANA_ERROR_ATOMIC_FAILURE:
            return "Atomic operation failed";
        case SOLANA_ERROR_RPC_FAILED:
            return "RPC request failed";
        case SOLANA_ERROR_SIGNATURE_INVALID:
            return "Invalid signature";
        case SOLANA_ERROR_TX_FAILED:
            return "Transaction failed";
        case SOLANA_ERROR_CONNECTION_FAILED:
            return "Connection failed";
        case SOLANA_ERROR_TIMEOUT:
            return "Timeout";
        case SOLANA_ERROR_INVALID_PARAMS:
            return "Invalid parameters";
        case SOLANA_ERROR_SERIALIZATION:
            return "Serialization error";
        case SOLANA_ERROR_DESERIALIZATION:
            return "Deserialization error";
        case SOLANA_ERROR_INSUFFICIENT_FUNDS:
            return "Insufficient funds";
        case SOLANA_ERROR_ACCOUNT_NOT_FOUND:
            return "Account not found";
        case SOLANA_ERROR_PROGRAM_ERROR:
            return "Program error";
        case SOLANA_ERROR_QUEUE_FULL:
            return "Queue full";
        case SOLANA_ERROR_QUEUE_EMPTY:
            return "Queue empty";
        case SOLANA_ERROR_NOT_INITIALIZED:
            return "Not initialized";
        case SOLANA_ERROR_ALREADY_INITIALIZED:
            return "Already initialized";
        case SOLANA_ERROR_MEMORY:
            return "Memory allocation error";
        default:
            return "Unknown error";
    }
}

const char *solana_status_str(SolanaStatus status) {
    switch (status) {
        case SOLANA_STATE_UNINITIALIZED:
            return "Uninitialized";
        case SOLANA_STATE_INITIALIZED:
            return "Initialized";
        case SOLANA_STATE_CONNECTING:
            return "Connecting";
        case SOLANA_STATE_CONNECTED:
            return "Connected";
        case SOLANA_STATE_DISCONNECTED:
            return "Disconnected";
        case SOLANA_STATE_ERROR:
            return "Error";
        case SOLANA_STATE_TRANSITIONING:
            return "Transitioning";
        default:
            return "Unknown";
    }
}
