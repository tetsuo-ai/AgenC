/**
 * @file memory_strategy_test.c
 * @brief Test suite for memory strategy core interface
 */

#include "memory_strategy.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <pthread.h>

#define TEST_ALLOC_SIZE 1024
#define NUM_THREADS 4
#define NUM_ITERATIONS 100

static void
test_strategy_initialization (void)
{
  printf ("Testing strategy initialization...\n");

  MemoryStrategy strategy;
  memset (&strategy, 0, sizeof (MemoryStrategy));

  assert (initialize_strategy (&strategy) == true);
  assert (strategy.status_tracker != NULL);
  assert (strategy.allocate != NULL);
  assert (strategy.deallocate != NULL);
  assert (strategy.get_status != NULL);
  assert (strategy.validate != NULL);

  assert (strategy.get_status (&strategy) == STRATEGY_STATE_ACTIVE);

  cleanup_strategy (&strategy);
  printf ("Strategy initialization tests passed\n");
}

static void
test_null_handling (void)
{
  printf ("Testing null pointer handling...\n");

  // Test initialization with null
  assert (initialize_strategy (NULL) == false);

  // Test cleanup with null
  cleanup_strategy (NULL); // Should not crash

  MemoryStrategy strategy;
  memset (&strategy, 0, sizeof (MemoryStrategy));

  // Initialize valid strategy but without status tracker
  strategy.allocate = NULL; // Ensure no function pointers
  strategy.deallocate = NULL;
  strategy.get_status = NULL;
  strategy.validate = NULL;
  strategy.status_tracker = NULL;
  strategy.strategy_data = NULL;

  // Test operations with null strategy data
  void *ptr
    = strategy.allocate ? strategy.allocate (&strategy, TEST_ALLOC_SIZE) : NULL;
  assert (ptr == NULL);

  if (strategy.deallocate)
  {
    strategy.deallocate (&strategy, NULL); // Should not crash
  }

  StrategyStatus status = strategy.get_status ? strategy.get_status (&strategy)
					      : STRATEGY_STATE_ERROR;
  assert (status == STRATEGY_STATE_ERROR);

  cleanup_strategy (&strategy);
  printf ("Null pointer handling tests passed\n");
}

static void *
concurrent_test_thread (void *arg)
{
  MemoryStrategy *strategy = (MemoryStrategy *) arg;
  void *ptrs[NUM_ITERATIONS];

  for (int i = 0; i < NUM_ITERATIONS; i++)
  {
    // Allocate memory
    ptrs[i] = strategy->allocate (strategy, TEST_ALLOC_SIZE);
    assert (ptrs[i] != NULL);

    // Write to memory to test usability
    memset (ptrs[i], i % 256, TEST_ALLOC_SIZE);

    // Verify status remains active
    assert (strategy->get_status (strategy) == STRATEGY_STATE_ACTIVE);
  }

  // Deallocate all memory
  for (int i = 0; i < NUM_ITERATIONS; i++)
  {
    strategy->deallocate (strategy, ptrs[i]);
  }

  return NULL;
}

static void
test_concurrent_operations (void)
{
  printf ("Testing concurrent operations...\n");

  MemoryStrategy strategy;
  assert (initialize_strategy (&strategy) == true);

  pthread_t threads[NUM_THREADS];

  // Start concurrent threads
  for (int i = 0; i < NUM_THREADS; i++)
  {
    assert (
      pthread_create (&threads[i], NULL, concurrent_test_thread, &strategy)
      == 0);
  }

  // Wait for all threads to complete
  for (int i = 0; i < NUM_THREADS; i++)
  {
    assert (pthread_join (threads[i], NULL) == 0);
  }

  // Verify strategy is still in valid state
  assert (strategy.get_status (&strategy) == STRATEGY_STATE_ACTIVE);
  assert (strategy.validate (&strategy) == true);

  cleanup_strategy (&strategy);
  printf ("Concurrent operation tests passed\n");
}

static void
test_error_recovery (void)
{
  printf ("Testing error recovery...\n");

  MemoryStrategy strategy;
  assert (initialize_strategy (&strategy) == true);

  // Force error state through invalid operation
  void *ptr = strategy.allocate (&strategy, 0); // Invalid size
  assert (ptr == NULL);
  assert (strategy.get_status (&strategy) == STRATEGY_STATE_ERROR);

  // Attempt recovery through reinitialization
  cleanup_strategy (&strategy);
  assert (initialize_strategy (&strategy) == true);
  assert (strategy.get_status (&strategy) == STRATEGY_STATE_ACTIVE);

  // Verify normal operations work after recovery
  ptr = strategy.allocate (&strategy, TEST_ALLOC_SIZE);
  assert (ptr != NULL);
  strategy.deallocate (&strategy, ptr);

  cleanup_strategy (&strategy);
  printf ("Error recovery tests passed\n");
}

int
main (void)
{
  printf ("Running memory strategy interface tests...\n\n");

  test_strategy_initialization ();
  test_null_handling ();
  test_concurrent_operations ();
  test_error_recovery ();

  printf ("\nAll memory strategy interface tests passed successfully!\n");
  return 0;
}
