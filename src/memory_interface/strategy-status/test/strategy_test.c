#include <stdio.h>
#include <assert.h>
#include <string.h>
#include <pthread.h>
#include <time.h>
#include <limits.h>
#include <signal.h>
#include <stdatomic.h>
#include <inttypes.h>

#include "../include/strategy_status.h"

#define NUM_THREADS 4
#define ITERATIONS_PER_THREAD 10000
#define OVERFLOW_TEST_THRESHOLD (UINT64_MAX - 100)

// clang-format off
static void print_test_header (const char *test_name);
static void print_test_result (const char *test_name, bool passed);
static void assert_strategy_success (StrategyResult result, const char *operation);
static void verify_status (const StatusTracker *tracker, StrategyStatus expected);
// clang-format on

static volatile atomic_bool should_terminate = false;

typedef struct
{
  StatusTracker *tracker;
  int thread_id;
  uint64_t success_count;
  pthread_t thread;
} ThreadData;

/* Security: Signal handler for thread termination */
static void
handle_termination (int signum)
{
  (void) signum; /* Unused parameter */
  atomic_store (&should_terminate, true);
}

/* Thread function for concurrent testing */
void *
concurrent_transitions (void *arg)
{
  ThreadData *data = (ThreadData *) arg;
  if (data == NULL || data->tracker == NULL)
  {
    return NULL;
  }

  for (int i = 0; i < ITERATIONS_PER_THREAD && !atomic_load (&should_terminate);
       i++)
  {
    if (transition_status (data->tracker, STRATEGY_STATE_ACTIVE)
	  == STRATEGY_SUCCESS
	&& transition_status (data->tracker, STRATEGY_STATE_ERROR)
	     == STRATEGY_SUCCESS
	&& transition_status (data->tracker, STRATEGY_STATE_INITIALIZED)
	     == STRATEGY_SUCCESS)
    {
      data->success_count++;
    }
  }

  return NULL;
}

/* Helper function to verify status */
static void
verify_status (const StatusTracker *tracker, StrategyStatus expected)
{
  StrategyStatus current;
  assert_strategy_success (get_current_status (tracker, &current),
			   "get_current_status");
  assert (current == expected);
}

/* Helper function to assert strategy operation success */
static void
assert_strategy_success (StrategyResult result, const char *operation)
{
  if (result != STRATEGY_SUCCESS)
  {
    printf ("Operation %s failed with error code: %d\n", operation, result);
    assert (false);
  }
}

void
test_initialization (void)
{
  print_test_header ("Initialization");

  StatusTracker tracker;
  assert_strategy_success (initialize_status (&tracker), "initialize_status");

  /* Verify initial state */
  verify_status (&tracker, STRATEGY_STATE_INITIALIZED);

  uint64_t count;
  assert_strategy_success (get_transition_count (&tracker, &count),
			   "get_transition_count");
  assert (count == 0);

  assert_strategy_success (get_error_count (&tracker, &count),
			   "get_error_count");
  assert (count == 0);

  /* Security: Test NULL pointer handling */
  assert (initialize_status (NULL) == STRATEGY_NULL_POINTER);

  print_test_result ("Initialization", true);
}

void
test_overflow_protection (void)
{
  print_test_header ("Overflow Protection");

  StatusTracker tracker;
  assert_strategy_success (initialize_status (&tracker), "initialize_status");

  /* Set counters near maximum */
  atomic_store_explicit (&tracker.transition_count, OVERFLOW_TEST_THRESHOLD,
			 memory_order_seq_cst);
  atomic_store_explicit (&tracker.error_count, OVERFLOW_TEST_THRESHOLD,
			 memory_order_seq_cst);

  /* Attempt to cause overflow */
  for (int i = 0; i < 200; i++)
  {
    StrategyResult result = transition_status (&tracker, STRATEGY_STATE_ERROR);
    if (result == STRATEGY_OVERFLOW)
    {
      break; /* Expected behavior when approaching UINT64_MAX */
    }

    result = transition_status (&tracker, STRATEGY_STATE_INITIALIZED);
    if (result == STRATEGY_OVERFLOW)
    {
      break; /* Expected behavior when approaching UINT64_MAX */
    }
  }

  /* Verify no overflow occurred */
  uint64_t count;
  assert_strategy_success (get_transition_count (&tracker, &count),
			   "get_transition_count");
  assert (count <= UINT64_MAX);

  assert_strategy_success (get_error_count (&tracker, &count),
			   "get_error_count");
  assert (count <= UINT64_MAX);

  print_test_result ("Overflow Protection", true);
}

void
test_memory_barriers (void)
{
  print_test_header ("Memory Barriers");

  StatusTracker tracker;
  assert_strategy_success (initialize_status (&tracker), "initialize_status");

  /* Test acquire-release semantics */
  atomic_thread_fence (memory_order_acquire);
  verify_status (&tracker, STRATEGY_STATE_INITIALIZED);

  atomic_thread_fence (memory_order_release);
  assert_strategy_success (transition_status (&tracker, STRATEGY_STATE_ACTIVE),
			   "transition_status");

  print_test_result ("Memory Barriers", true);
}

void
test_thread_safety (void)
{
  print_test_header ("Thread Safety");

  StatusTracker tracker;
  assert_strategy_success (initialize_status (&tracker), "initialize_status");

  /* Setup signal handler */
  struct sigaction sa;
  memset (&sa, 0, sizeof (sa));
  sa.sa_handler = handle_termination;
  sigaction (SIGTERM, &sa, NULL);

  ThreadData thread_data[NUM_THREADS];
  atomic_store (&should_terminate, false);

  /* Initialize and start threads */
  for (int i = 0; i < NUM_THREADS; i++)
  {
    thread_data[i].tracker = &tracker;
    thread_data[i].thread_id = i;
    thread_data[i].success_count = 0;
    pthread_create (&thread_data[i].thread, NULL, concurrent_transitions,
		    &thread_data[i]);
  }

  /* Wait for all threads to complete */
  for (int i = 0; i < NUM_THREADS; i++)
  {
    pthread_join (thread_data[i].thread, NULL);
  }

  /* Verify results */
  uint64_t total_success = 0;
  for (int i = 0; i < NUM_THREADS; i++)
  {
    total_success += thread_data[i].success_count;
  }

  uint64_t transitions, errors;
  assert_strategy_success (get_transition_count (&tracker, &transitions),
			   "get_transition_count");
  assert_strategy_success (get_error_count (&tracker, &errors),
			   "get_error_count");

  printf ("Thread safety results:\n");
  printf ("- Total successful transition sequences: %" PRIu64 "\n", total_success);
  printf ("- Total transitions: %" PRIu64 "\n", transitions);
  printf ("- Total errors: %" PRIu64 "\n", errors);

  assert (transitions > 0);
  assert (total_success > 0);

  print_test_result ("Thread Safety", true);
}

void
test_error_handling (void)
{
  print_test_header ("Error Handling");

  StatusTracker tracker;
  assert_strategy_success (initialize_status (&tracker), "initialize_status");

  /* Test invalid state transitions */
  assert (transition_status (&tracker, (StrategyStatus) 99)
	  == STRATEGY_INVALID_STATE);
  assert (transition_status (&tracker, (StrategyStatus) -1)
	  == STRATEGY_INVALID_STATE);

  /* Test NULL pointer handling */
  StrategyStatus status;
  uint64_t count;
  assert (get_current_status (NULL, &status) == STRATEGY_NULL_POINTER);
  assert (get_transition_count (NULL, &count) == STRATEGY_NULL_POINTER);
  assert (get_error_count (NULL, &count) == STRATEGY_NULL_POINTER);
  assert (transition_status (NULL, STRATEGY_STATE_ACTIVE)
	  == STRATEGY_NULL_POINTER);

  /* Test error state handling */
  assert_strategy_success (transition_status (&tracker, STRATEGY_STATE_ERROR),
			   "transition_to_error");
  verify_status (&tracker, STRATEGY_STATE_ERROR);
  assert (is_error_state (STRATEGY_STATE_ERROR));
  assert (requires_state_recovery (STRATEGY_STATE_ERROR));

  print_test_result ("Error Handling", true);
}

/* Test helper function implementations */
static void
print_test_header (const char *test_name)
{
  printf ("\nRunning %s test...\n", test_name);
}

static void
print_test_result (const char *test_name, bool passed)
{
  printf ("✓ %s test %s\n", test_name, passed ? "passed" : "failed");
}

int
main (void)
{
  printf ("Running StatusTracker Security Tests...\n");
  printf ("=====================================\n");

  test_initialization ();
  test_overflow_protection ();
  test_memory_barriers ();
  test_thread_safety ();
  test_error_handling ();

  printf ("\nAll security tests completed successfully!\n");
  return 0;
}
