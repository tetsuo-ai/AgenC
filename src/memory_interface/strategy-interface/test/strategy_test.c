/**
 * @file strategy_test.c
 * @brief Test suite for memory strategy implementation
 */

#include "memory_strategy.h"
#include "memory_pool_strategy.h"
#include "strategy_validator.h"
#include <assert.h>
#include <stdio.h>
#include <pthread.h>
#include <string.h>

#define NUM_THREADS 4
#define TEST_ALLOC_SIZE 1024
#define SMALL_ALLOC_SIZE 64
#define NUM_ALLOCATIONS 10

static void *
thread_pool_test_func (void *arg)
{
  MemoryStrategy *strategy = (MemoryStrategy *) arg;
  void *ptrs[NUM_ALLOCATIONS];

  // Test multiple small allocations
  for (int i = 0; i < NUM_ALLOCATIONS; i++)
  {
    ptrs[i] = strategy->allocate (strategy, SMALL_ALLOC_SIZE);
    assert (ptrs[i] != NULL);

    // Write to memory to test usability
    memset (ptrs[i], i, SMALL_ALLOC_SIZE);
  }

  // Test validation
  assert (strategy->validate (strategy));

  // Test status
  assert (strategy->get_status (strategy) == STRATEGY_STATE_ACTIVE);

  // Test deallocation
  for (int i = 0; i < NUM_ALLOCATIONS; i++)
  {
    strategy->deallocate (strategy, ptrs[i]);
  }

  return NULL;
}

static void
test_thread_safety (MemoryStrategy *strategy)
{
  pthread_t threads[NUM_THREADS];

  for (int i = 0; i < NUM_THREADS; i++)
  {
    assert (pthread_create (&threads[i], NULL, thread_pool_test_func, strategy)
	    == 0);
  }

  for (int i = 0; i < NUM_THREADS; i++)
  {
    assert (pthread_join (threads[i], NULL) == 0);
  }
}

static void
run_tests (void)
{
  // Test pool strategy
  MemoryStrategy *pool_strategy = create_pool_strategy ();
  assert (pool_strategy != NULL);

  // Test basic operations
  void *ptr = pool_strategy->allocate (pool_strategy, TEST_ALLOC_SIZE);
  assert (ptr != NULL);
  assert (pool_strategy->validate (pool_strategy));

  // Test memory usage
  memset (ptr, 0xAA, TEST_ALLOC_SIZE);
  unsigned char *check = (unsigned char *) ptr;
  for (size_t i = 0; i < TEST_ALLOC_SIZE; i++)
  {
    assert (check[i] == 0xAA);
  }

  pool_strategy->deallocate (pool_strategy, ptr);

  // Test thread safety
  test_thread_safety (pool_strategy);

  // Test error handling
  assert (!pool_strategy->allocate (pool_strategy,
				    POOL_BLOCK_SIZE * POOL_BLOCK_COUNT * 2));

  // Test cleanup
  destroy_pool_strategy (pool_strategy);

  printf ("All tests passed successfully!\n");
}

int
main (void)
{
  run_tests ();
  return 0;
}
