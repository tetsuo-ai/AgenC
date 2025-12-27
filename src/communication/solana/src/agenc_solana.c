/**
 * @file agenc_solana.c
 * @brief AgenC Framework Integration Implementation
 *
 * Implements the AgenC communication module interface using Solana.
 */

#include "../include/agenc_solana.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <time.h>

#ifdef _WIN32
#include <windows.h>
#else
#include <unistd.h>
#endif

/*============================================================================
 * Internal State
 *============================================================================*/

typedef struct AgencAgentInternal {
    AgencSolanaConfig config;
    AgencMessageCallback msg_callback;
    void *msg_callback_data;
    AgencTaskCallback task_callback;
    void *task_callback_data;
    AgencStateCallback state_callback;
    void *state_callback_data;
    uint64_t msg_sequence;
} AgencAgentInternal;

/*============================================================================
 * Agent Lifecycle
 *============================================================================*/

AgencAgent *agenc_agent_create(const AgencSolanaConfig *config) {
    if (config == NULL) {
        return NULL;
    }

    /* Allocate agent structure */
    AgencAgent *agent = calloc(1, sizeof(AgencAgent));
    if (agent == NULL) {
        return NULL;
    }

    /* Allocate internal state */
    AgencAgentInternal *internal = calloc(1, sizeof(AgencAgentInternal));
    if (internal == NULL) {
        free(agent);
        return NULL;
    }

    /* Copy configuration */
    memcpy(&internal->config, config, sizeof(AgencSolanaConfig));
    internal->msg_callback = config->message_callback;
    internal->msg_callback_data = config->message_callback_data;
    internal->task_callback = config->task_callback;
    internal->task_callback_data = config->task_callback_data;
    internal->state_callback = config->state_callback;
    internal->state_callback_data = config->state_callback_data;
    internal->msg_sequence = 0;

    /* Copy agent ID */
    memcpy(agent->id, config->agent_id, 32);

    /* Create Solana communication strategy */
    agent->comm = solana_comm_create(&config->solana_config);
    if (agent->comm == NULL) {
        free(internal);
        free(agent);
        return NULL;
    }

    /* Store keypair reference */
    agent->keypair = config->solana_config.keypair;

    /* Connect to network */
    SolanaResult result = agent->comm->connect(agent->comm);
    if (result != SOLANA_SUCCESS) {
        solana_comm_destroy(agent->comm);
        free(internal);
        free(agent);
        return NULL;
    }

    /* Derive agent PDA */
    uint8_t bump;
    result = solana_derive_agent_pda(
        &config->solana_config.program_id,
        agent->id,
        &agent->pda,
        &bump
    );

    if (result != SOLANA_SUCCESS) {
        agent->comm->disconnect(agent->comm);
        solana_comm_destroy(agent->comm);
        free(internal);
        free(agent);
        return NULL;
    }

    /* Store internal reference (using registration's reserved space) */
    agent->registration._reserved[0] = (uint8_t)((uintptr_t)internal & 0xFF);
    agent->registration._reserved[1] = (uint8_t)(((uintptr_t)internal >> 8) & 0xFF);

    /* Auto-register if configured */
    if (config->auto_register) {
        result = agenc_agent_register(agent);
        if (result != SOLANA_SUCCESS) {
            agent->comm->disconnect(agent->comm);
            solana_comm_destroy(agent->comm);
            free(internal);
            free(agent);
            return NULL;
        }
    }

    return agent;
}

void agenc_agent_destroy(AgencAgent *agent) {
    if (agent == NULL) {
        return;
    }

    /* Disconnect and cleanup */
    if (agent->comm != NULL) {
        agent->comm->disconnect(agent->comm);
        solana_comm_destroy(agent->comm);
    }

    /* Free internal state */
    uintptr_t internal_ptr = agent->registration._reserved[0] |
                            ((uintptr_t)agent->registration._reserved[1] << 8);
    if (internal_ptr != 0) {
        free((void *)internal_ptr);
    }

    free(agent);
}

SolanaResult agenc_agent_register(AgencAgent *agent) {
    if (agent == NULL || agent->comm == NULL) {
        return SOLANA_ERROR_NULL_POINTER;
    }

    uintptr_t internal_ptr = agent->registration._reserved[0] |
                            ((uintptr_t)agent->registration._reserved[1] << 8);
    AgencAgentInternal *internal = (AgencAgentInternal *)internal_ptr;

    SolanaSignature signature;
    SolanaResult result = agent->comm->register_agent(
        agent->comm,
        agent->id,
        internal->config.capabilities,
        internal->config.endpoint,
        &signature
    );

    if (result == SOLANA_SUCCESS) {
        agent->is_registered = true;
        agent->registration.capabilities = internal->config.capabilities;
        memcpy(agent->registration.agent_id, agent->id, 32);
    }

    return result;
}

SolanaResult agenc_agent_deregister(AgencAgent *agent) {
    if (agent == NULL || agent->comm == NULL) {
        return SOLANA_ERROR_NULL_POINTER;
    }

    if (agent->active_task_count > 0) {
        return SOLANA_ERROR_INVALID_STATE;
    }

    /* Deregistration would require a specific instruction */
    /* For now, mark as unregistered locally */
    agent->is_registered = false;

    return SOLANA_SUCCESS;
}

SolanaResult agenc_agent_update(
    AgencAgent *agent,
    uint64_t capabilities,
    const char *endpoint,
    int status
) {
    if (agent == NULL || agent->comm == NULL) {
        return SOLANA_ERROR_NULL_POINTER;
    }

    /* Update local state */
    if (capabilities > 0) {
        agent->registration.capabilities = capabilities;
    }

    if (endpoint != NULL) {
        strncpy(agent->registration.endpoint, endpoint,
                sizeof(agent->registration.endpoint) - 1);
    }

    if (status >= 0 && status <= 3) {
        agent->registration.status = (uint8_t)status;
    }

    /* Submit update transaction */
    /* This would use a UpdateAgent instruction */

    return SOLANA_SUCCESS;
}

/*============================================================================
 * Task Operations
 *============================================================================*/

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
) {
    if (agent == NULL || task_id == NULL || task == NULL) {
        return SOLANA_ERROR_NULL_POINTER;
    }

    /* Initialize task handle */
    memset(task, 0, sizeof(AgencTask));
    memcpy(task->id, task_id, 32);

    /* Derive task PDA */
    uint8_t bump;
    SolanaResult result = solana_derive_task_pda(
        &agent->comm->config.program_id,
        &agent->keypair->pubkey,
        task_id,
        &task->pda,
        &bump
    );

    if (result != SOLANA_SUCCESS) {
        return result;
    }

    /* Submit create task transaction */
    SolanaSignature signature;
    result = agent->comm->create_task(
        agent->comm,
        task_id,
        capabilities,
        description,
        reward_lamports,
        max_workers,
        deadline,
        task_type,
        &signature
    );

    if (result == SOLANA_SUCCESS) {
        task->status = TASK_STATUS_OPEN;
        task->data.reward_amount = reward_lamports;
        task->data.max_workers = max_workers;
        task->data.deadline = deadline;
        task->data.task_type = task_type;
        memcpy(task->data.task_id, task_id, 32);
        memcpy(task->data.description, description, 64);
    }

    return result;
}

SolanaResult agenc_task_claim(AgencAgent *agent, AgencTask *task) {
    if (agent == NULL || task == NULL) {
        return SOLANA_ERROR_NULL_POINTER;
    }

    if (task->is_claimed) {
        return SOLANA_ERROR_INVALID_STATE;
    }

    /* Submit claim transaction */
    SolanaSignature signature;
    SolanaResult result = agent->comm->claim_task(
        agent->comm,
        &task->pda,
        &signature
    );

    if (result == SOLANA_SUCCESS) {
        task->is_claimed = true;
        task->claimed_at = time(NULL);
        task->status = TASK_STATUS_IN_PROGRESS;
        agent->active_task_count++;
    }

    return result;
}

SolanaResult agenc_task_complete(
    AgencAgent *agent,
    AgencTask *task,
    const uint8_t proof_hash[32],
    const uint8_t result_data[64]
) {
    if (agent == NULL || task == NULL || proof_hash == NULL) {
        return SOLANA_ERROR_NULL_POINTER;
    }

    if (!task->is_claimed || task->is_completed) {
        return SOLANA_ERROR_INVALID_STATE;
    }

    /* Submit complete transaction */
    SolanaSignature signature;
    SolanaResult result = agent->comm->complete_task(
        agent->comm,
        &task->pda,
        proof_hash,
        result_data,
        &signature
    );

    if (result == SOLANA_SUCCESS) {
        task->is_completed = true;
        task->completed_at = time(NULL);
        task->status = TASK_STATUS_COMPLETED;
        if (agent->active_task_count > 0) {
            agent->active_task_count--;
        }
    }

    return result;
}

SolanaResult agenc_task_cancel(AgencAgent *agent, AgencTask *task) {
    if (agent == NULL || task == NULL) {
        return SOLANA_ERROR_NULL_POINTER;
    }

    /* Can only cancel tasks we created */
    /* Implementation would verify ownership and submit cancel transaction */

    task->status = TASK_STATUS_CANCELLED;
    return SOLANA_SUCCESS;
}

SolanaResult agenc_task_get(
    AgencAgent *agent,
    const SolanaPubkey *task_creator,
    const uint8_t task_id[32],
    AgencTask *task
) {
    if (agent == NULL || task_creator == NULL || task_id == NULL || task == NULL) {
        return SOLANA_ERROR_NULL_POINTER;
    }

    /* Derive task PDA */
    uint8_t bump;
    SolanaResult result = solana_derive_task_pda(
        &agent->comm->config.program_id,
        task_creator,
        task_id,
        &task->pda,
        &bump
    );

    if (result != SOLANA_SUCCESS) {
        return result;
    }

    /* Fetch task data */
    result = agent->comm->get_task(agent->comm, &task->pda, &task->data);
    if (result == SOLANA_SUCCESS) {
        memcpy(task->id, task_id, 32);
        task->status = task->data.status;
    }

    return result;
}

SolanaResult agenc_task_find(
    AgencAgent *agent,
    uint64_t capabilities,
    AgencTask *tasks,
    size_t max_tasks,
    size_t *count
) {
    (void)agent;
    (void)capabilities;
    (void)tasks;
    (void)max_tasks;
    (void)count;

    /* This would use getProgramAccounts with capability filters */
    /* Placeholder implementation */
    return SOLANA_ERROR_NOT_INITIALIZED;
}

/*============================================================================
 * State Synchronization
 *============================================================================*/

SolanaResult agenc_state_update(
    AgencAgent *agent,
    const uint8_t state_key[32],
    const uint8_t state_value[64],
    uint64_t expected_version
) {
    if (agent == NULL || state_key == NULL || state_value == NULL) {
        return SOLANA_ERROR_NULL_POINTER;
    }

    SolanaSignature signature;
    return agent->comm->update_state(
        agent->comm,
        state_key,
        state_value,
        expected_version,
        &signature
    );
}

SolanaResult agenc_state_get(
    AgencAgent *agent,
    const uint8_t state_key[32],
    uint8_t state_value[64],
    uint64_t *version
) {
    if (agent == NULL || state_key == NULL || state_value == NULL) {
        return SOLANA_ERROR_NULL_POINTER;
    }

    CoordinationState state;
    SolanaResult result = agent->comm->get_state(agent->comm, state_key, &state);

    if (result == SOLANA_SUCCESS) {
        memcpy(state_value, state.state_value, 64);
        if (version != NULL) {
            *version = state.version;
        }
    }

    return result;
}

SolanaResult agenc_state_subscribe(
    AgencAgent *agent,
    const uint8_t state_key[32]
) {
    (void)agent;
    (void)state_key;

    /* WebSocket subscription - not yet implemented */
    return SOLANA_ERROR_NOT_INITIALIZED;
}

/*============================================================================
 * Messaging
 *============================================================================*/

SolanaResult agenc_message_send(
    AgencAgent *agent,
    const uint8_t recipient[32],
    uint16_t type,
    const uint8_t *payload,
    size_t payload_size,
    AgencRoutingMode routing
) {
    if (agent == NULL || payload == NULL) {
        return SOLANA_ERROR_NULL_POINTER;
    }

    uintptr_t internal_ptr = agent->registration._reserved[0] |
                            ((uintptr_t)agent->registration._reserved[1] << 8);
    AgencAgentInternal *internal = (AgencAgentInternal *)internal_ptr;

    /* Build Solana message */
    SolanaMessage msg;
    memset(&msg, 0, sizeof(msg));

    memcpy(msg.header.sender.bytes, agent->id, 32);
    if (recipient != NULL) {
        /* Would need to convert recipient ID to pubkey */
    }
    msg.header.type = (SolanaMsgType)type;
    msg.header.sequence = (uint32_t)(++internal->msg_sequence);
    msg.header.timestamp = (uint64_t)time(NULL);

    msg.payload = (uint8_t *)payload;
    msg.payload_size = payload_size;

    (void)routing; /* Routing mode handling would go here */

    return agent->comm->send_message(agent->comm, &msg);
}

SolanaResult agenc_message_receive(
    AgencAgent *agent,
    AgencMessage *message,
    uint32_t timeout_ms
) {
    if (agent == NULL || message == NULL) {
        return SOLANA_ERROR_NULL_POINTER;
    }

    SolanaMessage solana_msg;
    SolanaResult result = agent->comm->receive_message(
        agent->comm,
        &solana_msg,
        timeout_ms
    );

    if (result == SOLANA_SUCCESS) {
        message->id = solana_msg.message_id;
        memcpy(message->sender, solana_msg.header.sender.bytes, 32);
        message->type = (uint16_t)solana_msg.header.type;
        message->timestamp = (int64_t)solana_msg.header.timestamp;
        message->payload = solana_msg.payload;
        message->payload_size = solana_msg.payload_size;
        message->signature = solana_msg.header.signature;
    }

    return result;
}

void agenc_message_free(AgencMessage *message) {
    if (message != NULL && message->payload != NULL) {
        free(message->payload);
        message->payload = NULL;
        message->payload_size = 0;
    }
}

/*============================================================================
 * Event Loop
 *============================================================================*/

int agenc_process_events(AgencAgent *agent, int max_events) {
    if (agent == NULL) {
        return 0;
    }

    int processed = 0;
    int limit = max_events > 0 ? max_events : 100;

    uintptr_t internal_ptr = agent->registration._reserved[0] |
                            ((uintptr_t)agent->registration._reserved[1] << 8);
    AgencAgentInternal *internal = (AgencAgentInternal *)internal_ptr;

    /* Process pending messages */
    while (processed < limit) {
        AgencMessage msg;
        SolanaResult result = agenc_message_receive(agent, &msg, 0);

        if (result == SOLANA_ERROR_QUEUE_EMPTY) {
            break;
        }

        if (result == SOLANA_SUCCESS) {
            if (internal->msg_callback != NULL) {
                internal->msg_callback(agent, &msg, internal->msg_callback_data);
            }
            agenc_message_free(&msg);
            processed++;
        }
    }

    return processed;
}

SolanaResult agenc_run_loop(
    AgencAgent *agent,
    uint32_t timeout_ms,
    volatile bool *running
) {
    if (agent == NULL || running == NULL) {
        return SOLANA_ERROR_NULL_POINTER;
    }

    uint32_t interval = timeout_ms > 0 ? timeout_ms : 100;

    while (*running) {
        agenc_process_events(agent, 0);

#ifdef _WIN32
        Sleep(interval);
#else
        usleep(interval * 1000);
#endif
    }

    return SOLANA_SUCCESS;
}

/*============================================================================
 * Utility Functions
 *============================================================================*/

SolanaResult agenc_get_slot(AgencAgent *agent, uint64_t *slot) {
    (void)agent;
    (void)slot;
    /* Would call RPC getSlot */
    return SOLANA_ERROR_NOT_INITIALIZED;
}

SolanaResult agenc_get_balance(AgencAgent *agent, uint64_t *lamports) {
    if (agent == NULL || lamports == NULL) {
        return SOLANA_ERROR_NULL_POINTER;
    }

    SolanaAccountInfo info;
    SolanaResult result = agent->comm->get_account_info(
        agent->comm,
        &agent->keypair->pubkey,
        &info
    );

    if (result == SOLANA_SUCCESS) {
        *lamports = info.lamports;
    }

    return result;
}

void agenc_generate_task_id(uint8_t task_id[32]) {
    /* Simple random generation - use proper CSPRNG in production */
    srand((unsigned int)time(NULL));
    for (int i = 0; i < 32; i++) {
        task_id[i] = (uint8_t)(rand() & 0xFF);
    }
}

void agenc_generate_agent_id(uint8_t agent_id[32]) {
    srand((unsigned int)time(NULL));
    for (int i = 0; i < 32; i++) {
        agent_id[i] = (uint8_t)(rand() & 0xFF);
    }
}
