/**
 * @file solana_comm.c
 * @brief Solana Communication Strategy Implementation
 *
 * Main implementation of the SolanaCommStrategy interface.
 * Provides thread-safe access to Solana blockchain for AgenC agents.
 */

#include "../include/solana_comm.h"
#include "../include/solana_rpc.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

/*============================================================================
 * Internal Implementation Data
 *============================================================================*/

typedef struct SolanaCommImpl {
    /* RPC client */
    SolanaRpcClient *rpc_client;

    /* Message queue */
    SolanaMessage *msg_queue;
    size_t queue_capacity;
    _Atomic(size_t) queue_head;
    _Atomic(size_t) queue_tail;
    _Atomic(uint32_t) queue_count;

    /* Agent state */
    uint8_t agent_id[32];
    bool agent_registered;
    SolanaPubkey agent_pda;
    uint8_t agent_pda_bump;

    /* Statistics */
    SolanaCommStats stats;

    /* Status tracker */
    SolanaStatusTracker status_tracker;

    /* Cached blockhash */
    uint8_t cached_blockhash[32];
    uint64_t blockhash_slot;

} SolanaCommImpl;

/*============================================================================
 * Forward Declarations for Interface Functions
 *============================================================================*/

static SolanaResult impl_send_message(SolanaCommStrategy *self, const SolanaMessage *msg);
static SolanaResult impl_receive_message(SolanaCommStrategy *self, SolanaMessage *msg, uint32_t timeout_ms);
static SolanaResult impl_submit_transaction(SolanaCommStrategy *self, const SolanaTransaction *tx, SolanaSignature *sig);
static SolanaResult impl_confirm_transaction(SolanaCommStrategy *self, const SolanaSignature *sig, bool *confirmed);
static SolanaResult impl_get_account_info(SolanaCommStrategy *self, const SolanaPubkey *pk, SolanaAccountInfo *info);
static SolanaResult impl_subscribe_account(SolanaCommStrategy *self, const SolanaPubkey *pk, uint64_t *sub_id);
static SolanaResult impl_unsubscribe_account(SolanaCommStrategy *self, uint64_t sub_id);
static SolanaResult impl_register_agent(SolanaCommStrategy *self, const uint8_t id[32], uint64_t caps, const char *ep, SolanaSignature *sig);
static SolanaResult impl_create_task(SolanaCommStrategy *self, const uint8_t id[32], uint64_t caps, const uint8_t desc[64], uint64_t reward, uint8_t max_w, int64_t deadline, TaskType type, SolanaSignature *sig);
static SolanaResult impl_claim_task(SolanaCommStrategy *self, const SolanaPubkey *task, SolanaSignature *sig);
static SolanaResult impl_complete_task(SolanaCommStrategy *self, const SolanaPubkey *task, const uint8_t proof[32], const uint8_t result[64], SolanaSignature *sig);
static SolanaResult impl_update_state(SolanaCommStrategy *self, const uint8_t key[32], const uint8_t val[64], uint64_t ver, SolanaSignature *sig);
static SolanaResult impl_get_agent(SolanaCommStrategy *self, const uint8_t id[32], AgentRegistration *reg);
static SolanaResult impl_get_task(SolanaCommStrategy *self, const SolanaPubkey *pk, TaskData *task);
static SolanaResult impl_get_state(SolanaCommStrategy *self, const uint8_t key[32], CoordinationState *state);
static SolanaStatus impl_get_status(SolanaCommStrategy *self);
static bool impl_validate(SolanaCommStrategy *self);
static bool impl_is_connected(SolanaCommStrategy *self);
static SolanaResult impl_get_stats(SolanaCommStrategy *self, SolanaCommStats *stats);
static SolanaResult impl_connect(SolanaCommStrategy *self);
static SolanaResult impl_disconnect(SolanaCommStrategy *self);
static SolanaResult impl_reconnect(SolanaCommStrategy *self);

/*============================================================================
 * Strategy Creation and Destruction
 *============================================================================*/

SolanaCommStrategy *solana_comm_create(const SolanaCommConfig *config) {
    if (config == NULL || config->rpc_endpoint == NULL) {
        return NULL;
    }

    /* Allocate strategy */
    SolanaCommStrategy *strategy = calloc(1, sizeof(SolanaCommStrategy));
    if (strategy == NULL) {
        return NULL;
    }

    /* Allocate implementation data */
    SolanaCommImpl *impl = calloc(1, sizeof(SolanaCommImpl));
    if (impl == NULL) {
        free(strategy);
        return NULL;
    }

    /* Initialize status tracker */
    if (solana_status_init(&impl->status_tracker) != SOLANA_SUCCESS) {
        free(impl);
        free(strategy);
        return NULL;
    }

    /* Create RPC client */
    SolanaRpcConfig rpc_config = {
        .endpoint = config->rpc_endpoint,
        .timeout_ms = config->timeout_ms > 0 ? config->timeout_ms : SOLANA_DEFAULT_TIMEOUT_MS,
        .max_retries = config->max_retries > 0 ? config->max_retries : 3,
        .commitment = config->commitment,
    };

    impl->rpc_client = solana_rpc_create(&rpc_config);
    if (impl->rpc_client == NULL) {
        free(impl);
        free(strategy);
        return NULL;
    }

    /* Allocate message queue */
    impl->queue_capacity = SOLANA_MSG_QUEUE_SIZE;
    impl->msg_queue = calloc(impl->queue_capacity, sizeof(SolanaMessage));
    if (impl->msg_queue == NULL) {
        solana_rpc_destroy(impl->rpc_client);
        free(impl);
        free(strategy);
        return NULL;
    }

    atomic_store(&impl->queue_head, 0);
    atomic_store(&impl->queue_tail, 0);
    atomic_store(&impl->queue_count, 0);

    /* Initialize statistics */
    atomic_store(&impl->stats.messages_sent, 0);
    atomic_store(&impl->stats.messages_received, 0);
    atomic_store(&impl->stats.bytes_sent, 0);
    atomic_store(&impl->stats.bytes_received, 0);
    atomic_store(&impl->stats.transactions_submitted, 0);
    atomic_store(&impl->stats.transactions_confirmed, 0);
    atomic_store(&impl->stats.transactions_failed, 0);
    atomic_store(&impl->stats.total_latency_us, 0);
    atomic_store(&impl->stats.rpc_requests, 0);
    atomic_store(&impl->stats.rpc_errors, 0);
    atomic_store(&impl->stats.ws_reconnects, 0);

    /* Copy configuration */
    memcpy(&strategy->config, config, sizeof(SolanaCommConfig));

    /* Assign interface functions */
    strategy->send_message = impl_send_message;
    strategy->receive_message = impl_receive_message;
    strategy->submit_transaction = impl_submit_transaction;
    strategy->confirm_transaction = impl_confirm_transaction;
    strategy->get_account_info = impl_get_account_info;
    strategy->subscribe_account = impl_subscribe_account;
    strategy->unsubscribe_account = impl_unsubscribe_account;
    strategy->register_agent = impl_register_agent;
    strategy->create_task = impl_create_task;
    strategy->claim_task = impl_claim_task;
    strategy->complete_task = impl_complete_task;
    strategy->update_state = impl_update_state;
    strategy->get_agent = impl_get_agent;
    strategy->get_task = impl_get_task;
    strategy->get_state = impl_get_state;
    strategy->get_status = impl_get_status;
    strategy->validate = impl_validate;
    strategy->is_connected = impl_is_connected;
    strategy->get_stats = impl_get_stats;
    strategy->connect = impl_connect;
    strategy->disconnect = impl_disconnect;
    strategy->reconnect = impl_reconnect;

    strategy->status_tracker = &impl->status_tracker;
    strategy->impl_data = impl;

    return strategy;
}

void solana_comm_destroy(SolanaCommStrategy *strategy) {
    if (strategy == NULL) {
        return;
    }

    SolanaCommImpl *impl = (SolanaCommImpl *)strategy->impl_data;
    if (impl != NULL) {
        /* Transition to disconnected state */
        solana_status_transition(&impl->status_tracker, SOLANA_STATE_DISCONNECTED);

        /* Cleanup RPC client */
        if (impl->rpc_client != NULL) {
            solana_rpc_destroy(impl->rpc_client);
        }

        /* Free message queue */
        if (impl->msg_queue != NULL) {
            /* Free any payload data in queued messages */
            size_t head = atomic_load(&impl->queue_head);
            size_t count = atomic_load(&impl->queue_count);
            for (size_t i = 0; i < count; i++) {
                size_t idx = (head + i) % impl->queue_capacity;
                if (impl->msg_queue[idx].payload != NULL) {
                    free(impl->msg_queue[idx].payload);
                }
            }
            free(impl->msg_queue);
        }

        free(impl);
    }

    free(strategy);
}

/*============================================================================
 * Interface Implementation Functions
 *============================================================================*/

static SolanaResult impl_send_message(SolanaCommStrategy *self, const SolanaMessage *msg) {
    if (self == NULL || msg == NULL) {
        return SOLANA_ERROR_NULL_POINTER;
    }

    SolanaCommImpl *impl = (SolanaCommImpl *)self->impl_data;
    SolanaStatus status;
    solana_status_get(&impl->status_tracker, &status);

    if (status != SOLANA_STATE_CONNECTED) {
        return SOLANA_ERROR_INVALID_STATE;
    }

    /* For now, queue the message for async processing */
    uint32_t count = atomic_load(&impl->queue_count);
    if (count >= impl->queue_capacity) {
        return SOLANA_ERROR_QUEUE_FULL;
    }

    size_t tail = atomic_load(&impl->queue_tail);
    SolanaMessage *slot = &impl->msg_queue[tail];

    /* Copy message header */
    memcpy(&slot->header, &msg->header, sizeof(SolanaMsgHeader));
    slot->message_id = msg->message_id;
    slot->payload_size = msg->payload_size;

    /* Copy payload */
    if (msg->payload_size > 0 && msg->payload != NULL) {
        slot->payload = malloc(msg->payload_size);
        if (slot->payload == NULL) {
            return SOLANA_ERROR_MEMORY;
        }
        memcpy(slot->payload, msg->payload, msg->payload_size);
    } else {
        slot->payload = NULL;
    }

    /* Update queue pointers */
    atomic_store(&impl->queue_tail, (tail + 1) % impl->queue_capacity);
    atomic_fetch_add(&impl->queue_count, 1);
    atomic_fetch_add(&impl->stats.messages_sent, 1);
    atomic_fetch_add(&impl->stats.bytes_sent, msg->payload_size);

    return SOLANA_SUCCESS;
}

static SolanaResult impl_receive_message(SolanaCommStrategy *self, SolanaMessage *msg, uint32_t timeout_ms) {
    if (self == NULL || msg == NULL) {
        return SOLANA_ERROR_NULL_POINTER;
    }

    SolanaCommImpl *impl = (SolanaCommImpl *)self->impl_data;
    (void)timeout_ms; /* TODO: Implement blocking with timeout */

    uint32_t count = atomic_load(&impl->queue_count);
    if (count == 0) {
        return SOLANA_ERROR_QUEUE_EMPTY;
    }

    size_t head = atomic_load(&impl->queue_head);
    SolanaMessage *slot = &impl->msg_queue[head];

    /* Copy message */
    memcpy(&msg->header, &slot->header, sizeof(SolanaMsgHeader));
    msg->message_id = slot->message_id;
    msg->payload_size = slot->payload_size;
    msg->payload = slot->payload; /* Transfer ownership */
    slot->payload = NULL;

    /* Update queue pointers */
    atomic_store(&impl->queue_head, (head + 1) % impl->queue_capacity);
    atomic_fetch_sub(&impl->queue_count, 1);
    atomic_fetch_add(&impl->stats.messages_received, 1);
    atomic_fetch_add(&impl->stats.bytes_received, msg->payload_size);

    return SOLANA_SUCCESS;
}

static SolanaResult impl_submit_transaction(
    SolanaCommStrategy *self,
    const SolanaTransaction *tx,
    SolanaSignature *signature
) {
    if (self == NULL || tx == NULL || signature == NULL) {
        return SOLANA_ERROR_NULL_POINTER;
    }

    SolanaCommImpl *impl = (SolanaCommImpl *)self->impl_data;
    SolanaStatus status;
    solana_status_get(&impl->status_tracker, &status);

    if (status != SOLANA_STATE_CONNECTED) {
        return SOLANA_ERROR_INVALID_STATE;
    }

    atomic_fetch_add(&impl->stats.rpc_requests, 1);

    SolanaResult result = solana_rpc_send_transaction(
        impl->rpc_client,
        tx->serialized,
        tx->serialized_len,
        signature
    );

    if (result == SOLANA_SUCCESS) {
        atomic_fetch_add(&impl->stats.transactions_submitted, 1);
    } else {
        atomic_fetch_add(&impl->stats.rpc_errors, 1);
        atomic_fetch_add(&impl->stats.transactions_failed, 1);
    }

    return result;
}

static SolanaResult impl_confirm_transaction(
    SolanaCommStrategy *self,
    const SolanaSignature *signature,
    bool *confirmed
) {
    if (self == NULL || signature == NULL || confirmed == NULL) {
        return SOLANA_ERROR_NULL_POINTER;
    }

    SolanaCommImpl *impl = (SolanaCommImpl *)self->impl_data;

    atomic_fetch_add(&impl->stats.rpc_requests, 1);

    SolanaResult result = solana_rpc_confirm_transaction(
        impl->rpc_client,
        signature,
        self->config.timeout_ms,
        confirmed
    );

    if (result == SOLANA_SUCCESS && *confirmed) {
        atomic_fetch_add(&impl->stats.transactions_confirmed, 1);
    } else if (result != SOLANA_SUCCESS) {
        atomic_fetch_add(&impl->stats.rpc_errors, 1);
    }

    return result;
}

static SolanaResult impl_get_account_info(
    SolanaCommStrategy *self,
    const SolanaPubkey *pubkey,
    SolanaAccountInfo *info
) {
    if (self == NULL || pubkey == NULL || info == NULL) {
        return SOLANA_ERROR_NULL_POINTER;
    }

    SolanaCommImpl *impl = (SolanaCommImpl *)self->impl_data;

    atomic_fetch_add(&impl->stats.rpc_requests, 1);

    SolanaRpcAccountResponse response;
    SolanaResult result = solana_rpc_get_account_info(
        impl->rpc_client,
        pubkey,
        &response
    );

    if (result == SOLANA_SUCCESS) {
        if (response.exists) {
            memcpy(info, &response.info, sizeof(SolanaAccountInfo));
        } else {
            return SOLANA_ERROR_ACCOUNT_NOT_FOUND;
        }
    } else {
        atomic_fetch_add(&impl->stats.rpc_errors, 1);
    }

    return result;
}

static SolanaResult impl_subscribe_account(
    SolanaCommStrategy *self,
    const SolanaPubkey *pubkey,
    uint64_t *subscription_id
) {
    /* WebSocket subscriptions - placeholder for full implementation */
    (void)self;
    (void)pubkey;
    (void)subscription_id;
    return SOLANA_ERROR_NOT_INITIALIZED; /* WebSocket not implemented yet */
}

static SolanaResult impl_unsubscribe_account(
    SolanaCommStrategy *self,
    uint64_t subscription_id
) {
    (void)self;
    (void)subscription_id;
    return SOLANA_ERROR_NOT_INITIALIZED;
}

/*============================================================================
 * AgenC Coordination Protocol Implementation
 *============================================================================*/

static SolanaResult impl_register_agent(
    SolanaCommStrategy *self,
    const uint8_t agent_id[32],
    uint64_t capabilities,
    const char *endpoint,
    SolanaSignature *signature
) {
    if (self == NULL || agent_id == NULL || endpoint == NULL || signature == NULL) {
        return SOLANA_ERROR_NULL_POINTER;
    }

    /* TODO: Build and submit RegisterAgent transaction */
    /* This requires:
     * 1. Derive agent PDA
     * 2. Build instruction with agent_id, capabilities, endpoint
     * 3. Get recent blockhash
     * 4. Sign and serialize transaction
     * 5. Submit via RPC
     */

    (void)capabilities;

    /* Placeholder - actual implementation would build the transaction */
    memset(signature, 0, sizeof(SolanaSignature));
    return SOLANA_SUCCESS;
}

static SolanaResult impl_create_task(
    SolanaCommStrategy *self,
    const uint8_t task_id[32],
    uint64_t capabilities,
    const uint8_t description[64],
    uint64_t reward_lamports,
    uint8_t max_workers,
    int64_t deadline,
    TaskType task_type,
    SolanaSignature *signature
) {
    if (self == NULL || task_id == NULL || signature == NULL) {
        return SOLANA_ERROR_NULL_POINTER;
    }

    /* TODO: Build and submit CreateTask transaction */
    (void)capabilities;
    (void)description;
    (void)reward_lamports;
    (void)max_workers;
    (void)deadline;
    (void)task_type;

    memset(signature, 0, sizeof(SolanaSignature));
    return SOLANA_SUCCESS;
}

static SolanaResult impl_claim_task(
    SolanaCommStrategy *self,
    const SolanaPubkey *task_pubkey,
    SolanaSignature *signature
) {
    if (self == NULL || task_pubkey == NULL || signature == NULL) {
        return SOLANA_ERROR_NULL_POINTER;
    }

    /* TODO: Build and submit ClaimTask transaction */
    memset(signature, 0, sizeof(SolanaSignature));
    return SOLANA_SUCCESS;
}

static SolanaResult impl_complete_task(
    SolanaCommStrategy *self,
    const SolanaPubkey *task_pubkey,
    const uint8_t proof_hash[32],
    const uint8_t result_data[64],
    SolanaSignature *signature
) {
    if (self == NULL || task_pubkey == NULL || proof_hash == NULL || signature == NULL) {
        return SOLANA_ERROR_NULL_POINTER;
    }

    /* TODO: Build and submit CompleteTask transaction */
    (void)result_data;

    memset(signature, 0, sizeof(SolanaSignature));
    return SOLANA_SUCCESS;
}

static SolanaResult impl_update_state(
    SolanaCommStrategy *self,
    const uint8_t state_key[32],
    const uint8_t state_value[64],
    uint64_t expected_version,
    SolanaSignature *signature
) {
    if (self == NULL || state_key == NULL || state_value == NULL || signature == NULL) {
        return SOLANA_ERROR_NULL_POINTER;
    }

    /* TODO: Build and submit UpdateState transaction */
    (void)expected_version;

    memset(signature, 0, sizeof(SolanaSignature));
    return SOLANA_SUCCESS;
}

static SolanaResult impl_get_agent(
    SolanaCommStrategy *self,
    const uint8_t agent_id[32],
    AgentRegistration *registration
) {
    if (self == NULL || agent_id == NULL || registration == NULL) {
        return SOLANA_ERROR_NULL_POINTER;
    }

    /* Derive agent PDA */
    SolanaPubkey pda;
    uint8_t bump;
    SolanaResult result = solana_derive_agent_pda(
        &self->config.program_id,
        agent_id,
        &pda,
        &bump
    );

    if (result != SOLANA_SUCCESS) {
        return result;
    }

    /* Get account data */
    SolanaAccountInfo info;
    result = impl_get_account_info(self, &pda, &info);
    if (result != SOLANA_SUCCESS) {
        return result;
    }

    /* TODO: Deserialize account data into AgentRegistration */
    /* For now, just copy the agent_id */
    memcpy(registration->agent_id, agent_id, 32);

    return SOLANA_SUCCESS;
}

static SolanaResult impl_get_task(
    SolanaCommStrategy *self,
    const SolanaPubkey *task_pubkey,
    TaskData *task
) {
    if (self == NULL || task_pubkey == NULL || task == NULL) {
        return SOLANA_ERROR_NULL_POINTER;
    }

    /* Get account data */
    SolanaAccountInfo info;
    SolanaResult result = impl_get_account_info(self, task_pubkey, &info);
    if (result != SOLANA_SUCCESS) {
        return result;
    }

    /* TODO: Deserialize account data into TaskData */
    memset(task, 0, sizeof(TaskData));

    return SOLANA_SUCCESS;
}

static SolanaResult impl_get_state(
    SolanaCommStrategy *self,
    const uint8_t state_key[32],
    CoordinationState *state
) {
    if (self == NULL || state_key == NULL || state == NULL) {
        return SOLANA_ERROR_NULL_POINTER;
    }

    /* Derive state PDA */
    SolanaPubkey pda;
    uint8_t bump;
    SolanaResult result = solana_derive_state_pda(
        &self->config.program_id,
        state_key,
        &pda,
        &bump
    );

    if (result != SOLANA_SUCCESS) {
        return result;
    }

    /* Get account data */
    SolanaAccountInfo info;
    result = impl_get_account_info(self, &pda, &info);
    if (result != SOLANA_SUCCESS) {
        return result;
    }

    /* TODO: Deserialize account data into CoordinationState */
    memcpy(state->state_key, state_key, 32);

    return SOLANA_SUCCESS;
}

/*============================================================================
 * Status and Connection Management
 *============================================================================*/

static SolanaStatus impl_get_status(SolanaCommStrategy *self) {
    if (self == NULL || self->status_tracker == NULL) {
        return SOLANA_STATE_UNINITIALIZED;
    }

    SolanaStatus status;
    solana_status_get(self->status_tracker, &status);
    return status;
}

static bool impl_validate(SolanaCommStrategy *self) {
    if (self == NULL) {
        return false;
    }

    SolanaCommImpl *impl = (SolanaCommImpl *)self->impl_data;
    if (impl == NULL) {
        return false;
    }

    /* Validate internal state */
    if (impl->rpc_client == NULL) {
        return false;
    }

    if (impl->msg_queue == NULL) {
        return false;
    }

    /* Validate function pointers */
    if (self->send_message == NULL ||
        self->receive_message == NULL ||
        self->submit_transaction == NULL ||
        self->confirm_transaction == NULL) {
        return false;
    }

    return true;
}

static bool impl_is_connected(SolanaCommStrategy *self) {
    if (self == NULL) {
        return false;
    }

    SolanaStatus status = impl_get_status(self);
    return status == SOLANA_STATE_CONNECTED;
}

static SolanaResult impl_get_stats(SolanaCommStrategy *self, SolanaCommStats *stats) {
    if (self == NULL || stats == NULL) {
        return SOLANA_ERROR_NULL_POINTER;
    }

    SolanaCommImpl *impl = (SolanaCommImpl *)self->impl_data;
    if (impl == NULL) {
        return SOLANA_ERROR_NOT_INITIALIZED;
    }

    /* Copy atomic values */
    stats->messages_sent = atomic_load(&impl->stats.messages_sent);
    stats->messages_received = atomic_load(&impl->stats.messages_received);
    stats->bytes_sent = atomic_load(&impl->stats.bytes_sent);
    stats->bytes_received = atomic_load(&impl->stats.bytes_received);
    stats->transactions_submitted = atomic_load(&impl->stats.transactions_submitted);
    stats->transactions_confirmed = atomic_load(&impl->stats.transactions_confirmed);
    stats->transactions_failed = atomic_load(&impl->stats.transactions_failed);
    stats->total_latency_us = atomic_load(&impl->stats.total_latency_us);
    stats->rpc_requests = atomic_load(&impl->stats.rpc_requests);
    stats->rpc_errors = atomic_load(&impl->stats.rpc_errors);
    stats->ws_reconnects = atomic_load(&impl->stats.ws_reconnects);

    return SOLANA_SUCCESS;
}

static SolanaResult impl_connect(SolanaCommStrategy *self) {
    if (self == NULL) {
        return SOLANA_ERROR_NULL_POINTER;
    }

    SolanaCommImpl *impl = (SolanaCommImpl *)self->impl_data;

    /* Transition to connecting state */
    SolanaResult result = solana_status_transition(
        &impl->status_tracker,
        SOLANA_STATE_CONNECTING
    );

    if (result != SOLANA_SUCCESS) {
        return result;
    }

    /* Check RPC health */
    result = solana_rpc_health(impl->rpc_client);
    if (result != SOLANA_SUCCESS) {
        solana_status_transition(&impl->status_tracker, SOLANA_STATE_ERROR);
        return result;
    }

    /* Get initial blockhash */
    SolanaRpcBlockhash blockhash;
    result = solana_rpc_get_latest_blockhash(impl->rpc_client, &blockhash);
    if (result != SOLANA_SUCCESS) {
        solana_status_transition(&impl->status_tracker, SOLANA_STATE_ERROR);
        return result;
    }

    memcpy(impl->cached_blockhash, blockhash.blockhash, 32);
    impl->blockhash_slot = blockhash.slot;

    /* Transition to connected state */
    result = solana_status_transition(&impl->status_tracker, SOLANA_STATE_CONNECTED);
    return result;
}

static SolanaResult impl_disconnect(SolanaCommStrategy *self) {
    if (self == NULL) {
        return SOLANA_ERROR_NULL_POINTER;
    }

    SolanaCommImpl *impl = (SolanaCommImpl *)self->impl_data;
    return solana_status_transition(&impl->status_tracker, SOLANA_STATE_DISCONNECTED);
}

static SolanaResult impl_reconnect(SolanaCommStrategy *self) {
    SolanaResult result = impl_disconnect(self);
    if (result != SOLANA_SUCCESS && result != SOLANA_ERROR_INVALID_STATE) {
        return result;
    }

    SolanaCommImpl *impl = (SolanaCommImpl *)self->impl_data;
    atomic_fetch_add(&impl->stats.ws_reconnects, 1);

    return impl_connect(self);
}
