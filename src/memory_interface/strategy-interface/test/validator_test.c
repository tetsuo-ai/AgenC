/**
 * @file validator_test.c
 * @brief Test suite for memory strategy validation system
 */

#include "strategy_validator.h"
#include "memory_strategy.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <pthread.h>
#include <stdint.h>

#define VALID_SIZE 1024
#define NUM_THREADS 4
#define NUM_ITERATIONS 100

// Mock strategy for testing
static void *
mock_allocate (struct MemoryStrategy *self, size_t size)
{
  (void) self;
  (void) size;
  return NULL;
}

static void
mock_deallocate (struct MemoryStrategy *self, void *ptr)
{
  (void) self;
  (void) ptr;
}

static StrategyStatus
mock_get_status (struct MemoryStrategy *self)
{
  return *(StrategyStatus *) self->strategy_data;
}

static bool
mock_validate (struct MemoryStrategy *self)
{
  (void) self;
  return true;
}

static MemoryStrategy *
create_mock_strategy (void)
{
  MemoryStrategy *strategy = calloc (1, sizeof (MemoryStrategy));
  if (!strategy)
    return NULL;

  strategy->status_tracker = calloc (1, sizeof (StatusTracker));
  if (!strategy->status_tracker)
  {
    free (strategy);
    return NULL;
  }

  strategy->allocate = mock_allocate;
  strategy->deallocate = mock_deallocate;
  strategy->get_status = mock_get_status;
  strategy->validate = mock_validate;

  // Initialize status tracker
  initialize_status (strategy->status_tracker);
  transition_status (strategy->status_tracker, STRATEGY_STATE_ACTIVE);

  return strategy;
}

static void
destroy_mock_strategy (MemoryStrategy *strategy)
{
  if (!strategy)
    return;
  if (strategy->status_tracker)
    free (strategy->status_tracker);
  if (strategy->strategy_data)
    free (strategy->strategy_data);
  free (strategy);
}

static void
test_strategy_validation (void)
{
  printf ("Testing strategy validation...\n");

  // Test null strategy
  assert (validate_strategy (NULL) == false);

  // Test valid strategy
  MemoryStrategy *strategy = create_mock_strategy ();
  assert (validate_strategy (strategy) == true);

  // Test incomplete strategy (missing functions)
  strategy->allocate = NULL;
  assert (validate_strategy (strategy) == false);

  // Test strategy in error state
  transition_status (strategy->status_tracker, STRATEGY_STATE_ERROR);
  assert (validate_strategy (strategy) == false);

  destroy_mock_strategy (strategy);
  printf ("Strategy validation tests passed\n");
}

static void
test_allocation_validation (void)
{
  printf ("Testing allocation validation...\n");

  MemoryStrategy *strategy = create_mock_strategy ();

  // Test null strategy
  assert (validate_allocation (NULL, VALID_SIZE) == false);

  // Test zero size
  assert (validate_allocation (strategy, 0) == false);

  // Test overflow size
  assert (validate_allocation (strategy, SIZE_MAX) == false);

  // Test valid size
  assert (validate_allocation (strategy, VALID_SIZE) == true);

  // Test allocation in non-active state
  transition_status (strategy->status_tracker, STRATEGY_STATE_ERROR);
  assert (validate_allocation (strategy, VALID_SIZE) == false);

  destroy_mock_strategy (strategy);
  printf ("Allocation validation tests passed\n");
}

static void
test_deallocation_validation (void)
{
  printf ("Testing deallocation validation...\n");

  MemoryStrategy *strategy = create_mock_strategy ();
  void *test_ptr = (void *) 0x1000; // Mock pointer

  // Test null strategy
  assert (validate_deallocation (NULL, test_ptr) == false);

  // Test null pointer
  assert (validate_deallocation (strategy, NULL) == false);

  // Test valid deallocation
  assert (validate_deallocation (strategy, test_ptr) == true);

  // Test deallocation in non-active state
  transition_status (strategy->status_tracker, STRATEGY_STATE_ERROR);
  assert (validate_deallocation (strategy, test_ptr) == false);

  destroy_mock_strategy (strategy);
  printf ("Deallocation validation tests passed\n");
}

static void *
concurrent_validation_thread (void *arg)
{
  MemoryStrategy *strategy = (MemoryStrategy *) arg;

  for (int i = 0; i < NUM_ITERATIONS; i++)
  {
    assert (validate_strategy (strategy) == true);
    assert (validate_allocation (strategy, VALID_SIZE) == true);
    assert (validate_deallocation (strategy, (void *) 0x1000) == true);
  }

  return NULL;
}

static void
test_concurrent_validation (void)
{
  printf ("Testing concurrent validation...\n");

  MemoryStrategy *strategy = create_mock_strategy ();
  pthread_t threads[NUM_THREADS];

  // Start concurrent threads
  for (int i = 0; i < NUM_THREADS; i++)
  {
    assert (
      pthread_create (&threads[i], NULL, concurrent_validation_thread, strategy)
      == 0);
  }

  // Wait for all threads to complete
  for (int i = 0; i < NUM_THREADS; i++)
  {
    assert (pthread_join (threads[i], NULL) == 0);
  }

  // Verify strategy is still valid
  assert (validate_strategy (strategy) == true);

  destroy_mock_strategy (strategy);
  printf ("Concurrent validation tests passed\n");
}

int
main (void)
{
  printf ("Running strategy validator tests...\n\n");

  test_strategy_validation ();
  test_allocation_validation ();
  test_deallocation_validation ();
  test_concurrent_validation ();

  printf ("\nAll strategy validator tests passed successfully!\n");
  return 0;
}
