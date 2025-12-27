/**
 * @file main.c
 * @brief Multi-Agent Coordination Example
 *
 * Demonstrates a complete multi-agent workflow using the AgenC
 * Solana coordination protocol:
 *
 * 1. Coordinator agent creates a task with reward
 * 2. Worker agents compete/collaborate to claim and complete
 * 3. Automatic payment distribution on completion
 *
 * This example uses 3 agents:
 * - Coordinator: Posts computational tasks
 * - Worker 1: Claims and executes tasks
 * - Worker 2: Collaborates or competes with Worker 1
 *
 * Build: gcc -o multi_agent main.c -L../../build -lsolana_comm -pthread
 * Run: ./multi_agent
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <signal.h>
#include <time.h>

#ifdef _WIN32
#include <windows.h>
#define sleep_ms(x) Sleep(x)
#else
#include <unistd.h>
#define sleep_ms(x) usleep((x) * 1000)
#endif

#include "../../src/communication/solana/include/agenc_solana.h"

/*============================================================================
 * Configuration
 *============================================================================*/

/* Solana devnet configuration */
#define RPC_ENDPOINT "https://api.devnet.solana.com"
#define NETWORK "devnet"

/* Program ID (placeholder - replace with deployed program) */
static const uint8_t PROGRAM_ID[32] = {
    0x41, 0x67, 0x4e, 0x43, 0x6f, 0x6f, 0x72, 0x44,
    0x31, 0x6e, 0x61, 0x74, 0x31, 0x6f, 0x6e, 0x50,
    0x72, 0x30, 0x67, 0x72, 0x61, 0x6d, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
};

/* Reward amount in lamports (0.01 SOL) */
#define TASK_REWARD 10000000

/* Task deadline (30 minutes from now) */
#define TASK_DEADLINE_OFFSET (30 * 60)

/*============================================================================
 * Global State
 *============================================================================*/

static volatile bool g_running = true;

static void signal_handler(int sig) {
    (void)sig;
    printf("\nShutdown signal received...\n");
    g_running = false;
}

/*============================================================================
 * Callback Handlers
 *============================================================================*/

static void on_message(
    AgencAgent *agent,
    const AgencMessage *message,
    void *user_data
) {
    (void)user_data;

    char sender_hex[65];
    for (int i = 0; i < 32; i++) {
        sprintf(&sender_hex[i * 2], "%02x", message->sender[i]);
    }
    sender_hex[64] = '\0';

    printf("[%s] Received message type=%u from %s...\n",
           agent->registration.endpoint,
           message->type,
           sender_hex);
}

static void on_task_event(
    AgencAgent *agent,
    const AgencTask *task,
    uint8_t event_type,
    void *user_data
) {
    (void)user_data;

    const char *event_names[] = {"CREATED", "CLAIMED", "COMPLETED", "CANCELLED"};
    const char *event_name = event_type < 4 ? event_names[event_type] : "UNKNOWN";

    char task_id_hex[65];
    for (int i = 0; i < 32; i++) {
        sprintf(&task_id_hex[i * 2], "%02x", task->id[i]);
    }
    task_id_hex[64] = '\0';

    printf("[%s] Task %s: %s...\n",
           agent->registration.endpoint,
           event_name,
           task_id_hex);
}

static void on_state_change(
    AgencAgent *agent,
    const uint8_t state_key[32],
    const uint8_t state_value[64],
    uint64_t version,
    void *user_data
) {
    (void)agent;
    (void)state_key;
    (void)state_value;
    (void)version;
    (void)user_data;

    printf("[STATE] Coordination state updated, version=%llu\n",
           (unsigned long long)version);
}

/*============================================================================
 * Agent Creation Helpers
 *============================================================================*/

static AgencAgent *create_agent(
    const char *name,
    uint64_t capabilities,
    SolanaKeypair *keypair
) {
    AgencSolanaConfig config;
    memset(&config, 0, sizeof(config));

    /* Solana configuration */
    config.solana_config.rpc_endpoint = RPC_ENDPOINT;
    config.solana_config.network = NETWORK;
    config.solana_config.commitment = SOLANA_COMMITMENT_CONFIRMED;
    config.solana_config.timeout_ms = 30000;
    config.solana_config.enable_websocket = false;
    config.solana_config.keypair = keypair;
    memcpy(config.solana_config.program_id.bytes, PROGRAM_ID, 32);

    /* Generate agent ID */
    agenc_generate_agent_id(config.agent_id);

    /* Agent capabilities */
    config.capabilities = capabilities;
    config.endpoint = name;
    config.metadata_uri = NULL;

    /* Don't auto-register (we'll do it manually for demo) */
    config.auto_register = false;
    config.auto_claim = false;

    /* Callbacks */
    config.message_callback = on_message;
    config.task_callback = on_task_event;
    config.state_callback = on_state_change;

    return agenc_agent_create(&config);
}

/*============================================================================
 * Simulation Functions
 *============================================================================*/

static void simulate_work(AgencAgent *agent, AgencTask *task) {
    printf("[%s] Executing task...\n", agent->registration.endpoint);

    /* Simulate computational work */
    for (int i = 0; i < 5 && g_running; i++) {
        printf("[%s] Working... %d%%\n", agent->registration.endpoint, (i + 1) * 20);
        sleep_ms(500);
    }

    if (!g_running) return;

    /* Generate proof of work (simulated hash) */
    uint8_t proof_hash[32];
    for (int i = 0; i < 32; i++) {
        proof_hash[i] = (uint8_t)(rand() & 0xFF);
    }

    /* Generate result data */
    uint8_t result_data[64];
    memset(result_data, 0, 64);
    snprintf((char *)result_data, 64, "Result from %s", agent->registration.endpoint);

    printf("[%s] Work completed, submitting proof...\n", agent->registration.endpoint);

    SolanaResult result = agenc_task_complete(agent, task, proof_hash, result_data);
    if (result == SOLANA_SUCCESS) {
        printf("[%s] Task completed successfully!\n", agent->registration.endpoint);
    } else {
        printf("[%s] Failed to complete task: %s\n",
               agent->registration.endpoint,
               solana_result_str(result));
    }
}

/*============================================================================
 * Demo Workflow
 *============================================================================*/

static void run_coordinator_workflow(AgencAgent *coordinator) {
    printf("\n=== COORDINATOR WORKFLOW ===\n\n");

    /* Register coordinator */
    printf("[Coordinator] Registering on-chain...\n");
    SolanaResult result = agenc_agent_register(coordinator);
    if (result != SOLANA_SUCCESS) {
        printf("[Coordinator] Registration failed: %s\n", solana_result_str(result));
        return;
    }
    printf("[Coordinator] Registered successfully!\n");

    /* Create a task */
    printf("[Coordinator] Creating task with %llu lamport reward...\n",
           (unsigned long long)TASK_REWARD);

    uint8_t task_id[32];
    agenc_generate_task_id(task_id);

    uint8_t description[64];
    memset(description, 0, 64);
    strncpy((char *)description, "Compute factorial of large number", 63);

    AgencTask task;
    result = agenc_task_create(
        coordinator,
        task_id,
        AGENT_CAP_COMPUTE | AGENT_CAP_INFERENCE,
        description,
        TASK_REWARD,
        2,  /* max 2 workers */
        time(NULL) + TASK_DEADLINE_OFFSET,
        TASK_TYPE_EXCLUSIVE,
        &task
    );

    if (result == SOLANA_SUCCESS) {
        char task_id_hex[65];
        for (int i = 0; i < 32; i++) {
            sprintf(&task_id_hex[i * 2], "%02x", task_id[i]);
        }
        task_id_hex[64] = '\0';
        printf("[Coordinator] Task created: %s...\n", task_id_hex);
    } else {
        printf("[Coordinator] Failed to create task: %s\n", solana_result_str(result));
    }
}

static void run_worker_workflow(AgencAgent *worker, AgencTask *task) {
    printf("\n=== %s WORKFLOW ===\n\n", worker->registration.endpoint);

    /* Register worker */
    printf("[%s] Registering on-chain...\n", worker->registration.endpoint);
    SolanaResult result = agenc_agent_register(worker);
    if (result != SOLANA_SUCCESS) {
        printf("[%s] Registration failed: %s\n",
               worker->registration.endpoint,
               solana_result_str(result));
        return;
    }
    printf("[%s] Registered successfully!\n", worker->registration.endpoint);

    /* Try to claim the task */
    printf("[%s] Attempting to claim task...\n", worker->registration.endpoint);
    result = agenc_task_claim(worker, task);

    if (result == SOLANA_SUCCESS) {
        printf("[%s] Task claimed!\n", worker->registration.endpoint);

        /* Execute the task */
        simulate_work(worker, task);
    } else {
        printf("[%s] Failed to claim task: %s\n",
               worker->registration.endpoint,
               solana_result_str(result));
    }
}

/*============================================================================
 * State Synchronization Demo
 *============================================================================*/

static void demo_state_sync(AgencAgent *agent1, AgencAgent *agent2) {
    printf("\n=== STATE SYNCHRONIZATION DEMO ===\n\n");

    /* Agent 1 updates state */
    uint8_t state_key[32];
    memset(state_key, 0, 32);
    strncpy((char *)state_key, "global_counter", 32);

    uint8_t state_value[64];
    memset(state_value, 0, 64);
    uint64_t counter = 42;
    memcpy(state_value, &counter, sizeof(counter));

    printf("[%s] Updating shared state...\n", agent1->registration.endpoint);
    SolanaResult result = agenc_state_update(agent1, state_key, state_value, 0);

    if (result == SOLANA_SUCCESS) {
        printf("[%s] State updated!\n", agent1->registration.endpoint);

        /* Agent 2 reads state */
        sleep_ms(500);
        uint8_t read_value[64];
        uint64_t version;
        result = agenc_state_get(agent2, state_key, read_value, &version);

        if (result == SOLANA_SUCCESS) {
            uint64_t read_counter;
            memcpy(&read_counter, read_value, sizeof(read_counter));
            printf("[%s] Read state: counter=%llu, version=%llu\n",
                   agent2->registration.endpoint,
                   (unsigned long long)read_counter,
                   (unsigned long long)version);
        }
    } else {
        printf("[%s] State update failed: %s\n",
               agent1->registration.endpoint,
               solana_result_str(result));
    }
}

/*============================================================================
 * Main Entry Point
 *============================================================================*/

int main(int argc, char *argv[]) {
    (void)argc;
    (void)argv;

    printf("AgenC Solana Multi-Agent Coordination Example\n");
    printf("=============================================\n\n");

    /* Set up signal handler */
    signal(SIGINT, signal_handler);
#ifndef _WIN32
    signal(SIGTERM, signal_handler);
#endif

    /* Seed random number generator */
    srand((unsigned int)time(NULL));

    /* Create keypairs (in production, load from file) */
    SolanaKeypair coordinator_keypair;
    SolanaKeypair worker1_keypair;
    SolanaKeypair worker2_keypair;

    /* Generate placeholder keys (would use Ed25519 keygen in production) */
    for (int i = 0; i < 64; i++) {
        coordinator_keypair.secret_key[i] = (uint8_t)(rand() & 0xFF);
        worker1_keypair.secret_key[i] = (uint8_t)(rand() & 0xFF);
        worker2_keypair.secret_key[i] = (uint8_t)(rand() & 0xFF);
    }
    for (int i = 0; i < 32; i++) {
        coordinator_keypair.pubkey.bytes[i] = coordinator_keypair.secret_key[32 + i];
        worker1_keypair.pubkey.bytes[i] = worker1_keypair.secret_key[32 + i];
        worker2_keypair.pubkey.bytes[i] = worker2_keypair.secret_key[32 + i];
    }

    /* Create agents */
    printf("Creating agents...\n");

    AgencAgent *coordinator = create_agent(
        "Coordinator",
        AGENT_CAP_COORDINATOR,
        &coordinator_keypair
    );

    AgencAgent *worker1 = create_agent(
        "Worker-1",
        AGENT_CAP_COMPUTE | AGENT_CAP_INFERENCE,
        &worker1_keypair
    );

    AgencAgent *worker2 = create_agent(
        "Worker-2",
        AGENT_CAP_COMPUTE | AGENT_CAP_STORAGE,
        &worker2_keypair
    );

    if (coordinator == NULL || worker1 == NULL || worker2 == NULL) {
        printf("Failed to create agents. Check network connectivity.\n");
        goto cleanup;
    }

    printf("All agents created successfully!\n");

    /* Run coordinator workflow */
    if (g_running) {
        run_coordinator_workflow(coordinator);
    }

    sleep_ms(1000);

    /* Create a task for workers to compete for */
    AgencTask shared_task;
    memset(&shared_task, 0, sizeof(shared_task));
    agenc_generate_task_id(shared_task.id);

    uint8_t desc[64] = "Shared computation task";
    agenc_task_create(coordinator, shared_task.id, AGENT_CAP_COMPUTE,
                      desc, TASK_REWARD, 1, 0, TASK_TYPE_EXCLUSIVE, &shared_task);

    /* Workers compete for the task */
    if (g_running) {
        printf("\n--- Workers competing for task ---\n");
        run_worker_workflow(worker1, &shared_task);
    }

    if (g_running && !shared_task.is_completed) {
        run_worker_workflow(worker2, &shared_task);
    }

    /* Demonstrate state synchronization */
    if (g_running) {
        demo_state_sync(worker1, worker2);
    }

    /* Event processing loop */
    printf("\n=== Processing events (Ctrl+C to exit) ===\n");
    while (g_running) {
        agenc_process_events(coordinator, 10);
        agenc_process_events(worker1, 10);
        agenc_process_events(worker2, 10);
        sleep_ms(100);
    }

cleanup:
    printf("\nCleaning up agents...\n");

    if (coordinator) agenc_agent_destroy(coordinator);
    if (worker1) agenc_agent_destroy(worker1);
    if (worker2) agenc_agent_destroy(worker2);

    printf("Multi-agent demo complete.\n");
    return 0;
}
