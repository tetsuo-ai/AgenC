# AgenC Integration Guide

This guide explains how to integrate the Solana communication module with the AgenC framework.

## Overview

The Solana module implements AgenC's Communication Module interface using function pointers and follows the framework's design patterns:

- **StatusTracker**: Thread-safe state management
- **StrategyResult**: Explicit error handling
- **Atomic Operations**: Lock-free synchronization
- **Memory Safety**: Consistent allocation patterns

## Integration Steps

### 1. Add to AgenC Source Tree

```bash
# Clone into AgenC repository
cd AgenC/src
git clone https://github.com/your-repo/agenc-solana.git communication/solana

# Or add as submodule
git submodule add https://github.com/your-repo/agenc-solana.git src/communication/solana
```

### 2. Update AgenC Build System

Add to `AgenC/Makefile`:

```makefile
# Communication modules
COMM_MODULES := solana

# Build communication modules
.PHONY: communication
communication:
	@for mod in $(COMM_MODULES); do \
		$(MAKE) -C src/communication/$$mod; \
	done

# Link with communication modules
LDFLAGS += -Lsrc/communication/solana/build -lsolana_comm
```

### 3. Create Communication Interface Adapter

Create `src/communication/comm_strategy.h`:

```c
#ifndef AGENC_COMM_STRATEGY_H_
#define AGENC_COMM_STRATEGY_H_

#include "memory_strategy.h"

/* Communication protocol types */
typedef enum {
    COMM_PROTOCOL_LOCAL = 0,
    COMM_PROTOCOL_TCP,
    COMM_PROTOCOL_SOLANA,
    COMM_PROTOCOL_MAX
} CommProtocol;

/* Generic communication strategy interface */
typedef struct CommStrategy {
    /* Send message to peer */
    int (*send)(struct CommStrategy *self,
                const void *peer_id,
                const void *data,
                size_t len);

    /* Receive message */
    int (*receive)(struct CommStrategy *self,
                   void *peer_id,
                   void *data,
                   size_t *len,
                   uint32_t timeout_ms);

    /* Get status */
    StrategyStatus (*get_status)(struct CommStrategy *self);

    /* Validate */
    bool (*validate)(struct CommStrategy *self);

    /* Internal state */
    StatusTracker *status_tracker;
    void *strategy_data;
    CommProtocol protocol;
} CommStrategy;

/* Factory function */
CommStrategy *comm_strategy_create(CommProtocol protocol, const void *config);
void comm_strategy_destroy(CommStrategy *strategy);

#endif
```

### 4. Implement Solana Adapter

Create `src/communication/solana_adapter.c`:

```c
#include "comm_strategy.h"
#include "solana/include/agenc_solana.h"

typedef struct {
    AgencAgent *agent;
    CommStrategy base;
} SolanaCommAdapter;

static int solana_send(CommStrategy *self, const void *peer_id,
                       const void *data, size_t len) {
    SolanaCommAdapter *adapter = (SolanaCommAdapter *)self->strategy_data;

    SolanaResult result = agenc_message_send(
        adapter->agent,
        (const uint8_t *)peer_id,
        0,  /* message type */
        data,
        len,
        AGENC_ROUTE_HYBRID
    );

    return result == SOLANA_SUCCESS ? 0 : -1;
}

static int solana_receive(CommStrategy *self, void *peer_id,
                          void *data, size_t *len, uint32_t timeout_ms) {
    SolanaCommAdapter *adapter = (SolanaCommAdapter *)self->strategy_data;

    AgencMessage msg;
    SolanaResult result = agenc_message_receive(
        adapter->agent,
        &msg,
        timeout_ms
    );

    if (result == SOLANA_SUCCESS) {
        memcpy(peer_id, msg.sender, 32);
        memcpy(data, msg.payload, msg.payload_size);
        *len = msg.payload_size;
        agenc_message_free(&msg);
        return 0;
    }

    return -1;
}

static StrategyStatus solana_get_status(CommStrategy *self) {
    SolanaCommAdapter *adapter = (SolanaCommAdapter *)self->strategy_data;
    SolanaStatus status = adapter->agent->comm->get_status(adapter->agent->comm);

    switch (status) {
        case SOLANA_STATE_CONNECTED:
            return STRATEGY_STATE_ACTIVE;
        case SOLANA_STATE_ERROR:
            return STRATEGY_STATE_ERROR;
        default:
            return STRATEGY_STATE_INITIALIZED;
    }
}

CommStrategy *solana_comm_adapter_create(const AgencSolanaConfig *config) {
    SolanaCommAdapter *adapter = calloc(1, sizeof(SolanaCommAdapter));
    if (!adapter) return NULL;

    adapter->agent = agenc_agent_create(config);
    if (!adapter->agent) {
        free(adapter);
        return NULL;
    }

    adapter->base.send = solana_send;
    adapter->base.receive = solana_receive;
    adapter->base.get_status = solana_get_status;
    adapter->base.protocol = COMM_PROTOCOL_SOLANA;
    adapter->base.strategy_data = adapter;

    return &adapter->base;
}
```

## Using in AgenC Agents

### Basic Agent with Solana Communication

```c
#include "agent.h"
#include "communication/solana/include/agenc_solana.h"

typedef struct MyAgent {
    AgentBase base;
    AgencAgent *solana_agent;
} MyAgent;

int my_agent_init(MyAgent *agent, const char *rpc_endpoint) {
    SolanaKeypair keypair;
    /* Load keypair from file or generate */

    AgencSolanaConfig config = {
        .solana_config = {
            .rpc_endpoint = rpc_endpoint,
            .network = "devnet",
            .keypair = &keypair,
        },
        .capabilities = AGENT_CAP_COMPUTE,
        .auto_register = true,
    };
    agenc_generate_agent_id(config.agent_id);

    agent->solana_agent = agenc_agent_create(&config);
    return agent->solana_agent ? 0 : -1;
}

int my_agent_process(MyAgent *agent) {
    /* Process Solana events */
    agenc_process_events(agent->solana_agent, 10);

    /* Check for tasks */
    AgencTask tasks[10];
    size_t count;
    agenc_task_find(agent->solana_agent, AGENT_CAP_COMPUTE,
                    tasks, 10, &count);

    for (size_t i = 0; i < count; i++) {
        if (tasks[i].status == TASK_STATUS_OPEN) {
            /* Claim and execute task */
            agenc_task_claim(agent->solana_agent, &tasks[i]);
            /* ... do work ... */
        }
    }

    return 0;
}
```

### Multi-Agent Coordination Pattern

```c
/* Coordinator agent */
void coordinator_loop(AgencAgent *coord) {
    while (running) {
        /* Create task */
        uint8_t task_id[32];
        agenc_generate_task_id(task_id);

        AgencTask task;
        agenc_task_create(coord, task_id, AGENT_CAP_INFERENCE,
                          "Process sensor data", 1000000,
                          3, 0, TASK_TYPE_COLLABORATIVE, &task);

        /* Wait for completion */
        while (task.status != TASK_STATUS_COMPLETED) {
            agenc_process_events(coord, 0);
            agenc_task_get(coord, &coord->keypair->pubkey,
                          task_id, &task);
            sleep_ms(100);
        }

        /* Task complete, result available */
        printf("Task completed: %s\n", task.data.result);
    }
}

/* Worker agent */
void worker_loop(AgencAgent *worker) {
    while (running) {
        agenc_process_events(worker, 0);

        /* Find available tasks */
        AgencTask tasks[10];
        size_t count;
        agenc_task_find(worker, worker->registration.capabilities,
                        tasks, 10, &count);

        for (size_t i = 0; i < count; i++) {
            if (tasks[i].status == TASK_STATUS_OPEN) {
                /* Claim task */
                if (agenc_task_claim(worker, &tasks[i]) == SOLANA_SUCCESS) {
                    /* Execute */
                    uint8_t result[64] = "Computation result";
                    uint8_t proof[32];
                    compute_proof(proof);

                    agenc_task_complete(worker, &tasks[i], proof, result);
                }
            }
        }

        sleep_ms(100);
    }
}
```

## State Synchronization

### Shared State Pattern

```c
/* All agents can read/write shared state */

/* Writer agent */
void update_global_state(AgencAgent *agent) {
    uint8_t key[32] = "sensor_readings";
    uint8_t value[64];

    /* Get current version */
    uint64_t version;
    agenc_state_get(agent, key, value, &version);

    /* Update with optimistic locking */
    float new_reading = read_sensor();
    memcpy(value, &new_reading, sizeof(float));

    SolanaResult result = agenc_state_update(agent, key, value, version);
    if (result == SOLANA_ERROR_INVALID_STATE) {
        /* Concurrent modification, retry */
        update_global_state(agent);
    }
}

/* Reader agent */
void monitor_state(AgencAgent *agent, AgencStateCallback callback) {
    uint8_t key[32] = "sensor_readings";

    /* Subscribe to changes */
    agenc_state_subscribe(agent, key);

    /* Process events calls callback on changes */
    while (running) {
        agenc_process_events(agent, 0);
        sleep_ms(10);
    }
}
```

## Best Practices

### 1. Error Handling

```c
SolanaResult result = agenc_task_create(...);
switch (result) {
    case SOLANA_SUCCESS:
        /* Handle success */
        break;
    case SOLANA_ERROR_INSUFFICIENT_FUNDS:
        /* Handle low balance */
        log_error("Need more SOL");
        break;
    case SOLANA_ERROR_RPC_FAILED:
        /* Handle network error */
        reconnect();
        break;
    default:
        log_error("Error: %s", solana_result_str(result));
}
```

### 2. Thread Safety

```c
/* All agenc_* functions are thread-safe */
/* But avoid concurrent operations on same task */

pthread_mutex_t task_lock = PTHREAD_MUTEX_INITIALIZER;

void claim_task_thread_safe(AgencAgent *agent, AgencTask *task) {
    pthread_mutex_lock(&task_lock);
    if (task->status == TASK_STATUS_OPEN) {
        agenc_task_claim(agent, task);
    }
    pthread_mutex_unlock(&task_lock);
}
```

### 3. Resource Management

```c
/* Always cleanup */
AgencAgent *agent = agenc_agent_create(&config);
if (agent) {
    /* Use agent */
    agenc_agent_destroy(agent);  /* Frees all resources */
}

/* Free message payloads */
AgencMessage msg;
if (agenc_message_receive(agent, &msg, 0) == SOLANA_SUCCESS) {
    process_message(&msg);
    agenc_message_free(&msg);  /* Free payload */
}
```

### 4. Retry Logic

```c
SolanaResult submit_with_retry(AgencAgent *agent, AgencTask *task,
                                int max_retries) {
    for (int i = 0; i < max_retries; i++) {
        SolanaResult result = agenc_task_claim(agent, task);

        if (result == SOLANA_SUCCESS) {
            return result;
        }

        if (result == SOLANA_ERROR_TIMEOUT) {
            sleep_ms(1000 * (1 << i));  /* Exponential backoff */
            continue;
        }

        /* Non-retriable error */
        return result;
    }

    return SOLANA_ERROR_TIMEOUT;
}
```

## Testing Integration

### Mock Solana for Unit Tests

```c
/* Create mock that doesn't connect to network */
AgencSolanaConfig mock_config = {
    .solana_config = {
        .rpc_endpoint = NULL,  /* Triggers mock mode */
    },
    /* ... */
};

AgencAgent *mock_agent = agenc_agent_create(&mock_config);
/* All operations succeed but don't hit network */
```

### Integration Test with Devnet

```c
void test_full_workflow() {
    /* Create coordinator */
    AgencAgent *coord = create_devnet_agent(AGENT_CAP_COORDINATOR);

    /* Create workers */
    AgencAgent *worker1 = create_devnet_agent(AGENT_CAP_COMPUTE);
    AgencAgent *worker2 = create_devnet_agent(AGENT_CAP_COMPUTE);

    /* Test task lifecycle */
    AgencTask task;
    assert(agenc_task_create(coord, ..., &task) == SOLANA_SUCCESS);
    assert(agenc_task_claim(worker1, &task) == SOLANA_SUCCESS);
    assert(agenc_task_complete(worker1, &task, ...) == SOLANA_SUCCESS);

    /* Cleanup */
    agenc_agent_destroy(coord);
    agenc_agent_destroy(worker1);
    agenc_agent_destroy(worker2);
}
```

## Troubleshooting

### Connection Issues

```c
/* Check connection status */
if (!agent->comm->is_connected(agent->comm)) {
    SolanaResult result = agent->comm->reconnect(agent->comm);
    if (result != SOLANA_SUCCESS) {
        log_error("Reconnect failed: %s", solana_result_str(result));
    }
}
```

### Transaction Failures

```c
/* Get detailed error info */
SolanaCommStats stats;
agent->comm->get_stats(agent->comm, &stats);

printf("Transactions: submitted=%llu, confirmed=%llu, failed=%llu\n",
       stats.transactions_submitted,
       stats.transactions_confirmed,
       stats.transactions_failed);
```

### Memory Issues

```c
/* Use valgrind */
valgrind --leak-check=full ./my_agent

/* Check for leaks */
/* Ensure all agenc_message_free() calls */
/* Ensure agenc_agent_destroy() on exit */
```
