/**
 * @file test_default_strategy.c
 * @brief Test suite for DefaultStrategy implementation
 */

#include "test_default_strategy.h"
#include "../src/default_strategy.h"
#include <pthread.h>
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <stdatomic.h>
#include <time.h>
#include <stdlib.h>

#define MAX_RETRY_COUNT 3
#define RETRY_DELAY_NS 100000 // 100 microseconds

static void *
concurrent_allocation_worker (void *arg)
{
  DefaultStrategy *strategy = (DefaultStrategy *) arg;
  const size_t NUM_ALLOCS = 100;
  const size_t ALLOC_SIZE = 128;
  void *ptrs[100];
  size_t successful_allocs = 0;

  atomic_thread_fence (memory_order_seq_cst);

  for (size_t i = 0; i < NUM_ALLOCS; i++)
  {
    ptrs[i] = default_allocate (&strategy->base, ALLOC_SIZE);
    if (ptrs[i])
    {
      memset (ptrs[i], (unsigned char) i, ALLOC_SIZE);
      successful_allocs++;
    }
  }

  atomic_thread_fence (memory_order_seq_cst);

  for (size_t i = 0; i < successful_allocs; i++)
  {
    unsigned char *mem = (unsigned char *) ptrs[i];
    for (size_t j = 0; j < ALLOC_SIZE; j++)
    {
      assert (mem[j] == (unsigned char) i);
    }

    atomic_thread_fence (memory_order_seq_cst);
    default_deallocate (&strategy->base, ptrs[i]);
  }

  atomic_thread_fence (memory_order_seq_cst);
  return NULL;
}

bool
test_strategy_creation (void)
{
  printf ("Running test_strategy_creation...\n");
  DefaultStrategy *strategy = create_default_strategy ();
  if (!strategy)
    return false;

  bool success = strategy->base.allocate != NULL
		 && strategy->base.deallocate != NULL
		 && strategy->base.get_status != NULL
		 && strategy->base.validate != NULL && strategy->stats != NULL;

  destroy_default_strategy (strategy);
  printf ("test_strategy_creation: %s\n", success ? "PASSED" : "FAILED");
  return success;
}

bool
test_basic_allocation (void)
{
  printf ("Running test_basic_allocation...\n");
  DefaultStrategy *strategy = create_default_strategy ();
  if (!strategy)
    return false;

  void *ptr = default_allocate (&strategy->base, 1024);
  bool success = ptr != NULL;

  if (success)
  {
    default_deallocate (&strategy->base, ptr);
  }

  destroy_default_strategy (strategy);
  printf ("test_basic_allocation: %s\n", success ? "PASSED" : "FAILED");
  return success;
}

bool
test_concurrent_allocations (void)
{
  printf ("Running test_concurrent_allocations...\n");
  DefaultStrategy *strategy = create_default_strategy ();
  if (!strategy)
    return false;

  const int NUM_THREADS = 4;
  pthread_t threads[NUM_THREADS];
  bool success = true;

  atomic_thread_fence (memory_order_seq_cst);
  size_t initial_usage = get_current_usage (strategy);
  printf ("Initial memory usage: %zu\n", initial_usage);

  for (int i = 0; i < NUM_THREADS; i++)
  {
    if (pthread_create (&threads[i], NULL, concurrent_allocation_worker,
			strategy)
	!= 0)
    {
      printf ("Failed to create thread %d\n", i);
      success = false;
      break;
    }
    struct timespec ts = {0, RETRY_DELAY_NS};
    nanosleep (&ts, NULL);
  }

  if (success)
  {
    for (int i = 0; i < NUM_THREADS; i++)
    {
      pthread_join (threads[i], NULL);
    }
    atomic_thread_fence (memory_order_seq_cst);
  }

  atomic_thread_fence (memory_order_seq_cst);
  size_t final_usage = get_current_usage (strategy);
  printf ("Final memory usage: %zu (expected: %zu)\n", final_usage,
	  initial_usage);
  success &= (final_usage == initial_usage);

  stats_report_t report;
  memory_stats_get_report (strategy->stats, &report);
  printf ("Active allocations: %u\n", report.active_allocation_count);
  printf ("Total leaked bytes: %zu\n", report.total_leaked_bytes);

  destroy_default_strategy (strategy);
  printf ("test_concurrent_allocations: %s\n", success ? "PASSED" : "FAILED");
  return success;
}

bool
test_error_handling (void)
{
  printf ("Running test_error_handling...\n");
  DefaultStrategy *strategy = create_default_strategy ();
  if (!strategy)
    return false;

  bool success
    = default_allocate (&strategy->base, 0) == NULL &&	    // Invalid size
      default_allocate (NULL, 1024) == NULL &&		    // NULL strategy
      default_allocate (&strategy->base, SIZE_MAX) == NULL; // Overflow

  destroy_default_strategy (strategy);
  printf ("test_error_handling: %s\n", success ? "PASSED" : "FAILED");
  return success;
}

bool
test_memory_tracking (void)
{
  printf ("Running test_memory_tracking...\n");
  DefaultStrategy *strategy = create_default_strategy ();
  if (!strategy)
    return false;

  void *ptr = default_allocate (&strategy->base, 1024);
  bool success = ptr != NULL && get_current_usage (strategy) == 1024;
  printf ("Current usage after allocation: %zu\n",
	  get_current_usage (strategy));

  if (success)
  {
    default_deallocate (&strategy->base, ptr);
    success &= get_current_usage (strategy) == 0;
    printf ("Current usage after deallocation: %zu\n",
	    get_current_usage (strategy));
  }

  destroy_default_strategy (strategy);
  printf ("test_memory_tracking: %s\n", success ? "PASSED" : "FAILED");
  return success;
}

bool
test_status_transitions (void)
{
  printf ("Running test_status_transitions...\n");
  DefaultStrategy *strategy = create_default_strategy ();
  if (!strategy)
    return false;

  StrategyStatus status = default_get_status (&strategy->base);
  bool success = status == STRATEGY_STATE_ACTIVE;

  destroy_default_strategy (strategy);
  printf ("test_status_transitions: %s\n", success ? "PASSED" : "FAILED");
  return success;
}

bool
test_validation (void)
{
  printf ("Running test_validation...\n");
  DefaultStrategy *strategy = create_default_strategy ();
  if (!strategy)
    return false;

  bool success = default_validate (&strategy->base);

  success &= !default_validate (NULL);

  destroy_default_strategy (strategy);
  printf ("test_validation: %s\n", success ? "PASSED" : "FAILED");
  return success;
}

bool
test_peak_usage (void)
{
  printf ("Running test_peak_usage...\n");
  DefaultStrategy *strategy = create_default_strategy ();
  if (!strategy)
    return false;

  void *ptr1 = default_allocate (&strategy->base, 1024);
  void *ptr2 = default_allocate (&strategy->base, 2048);

  size_t peak = get_peak_usage (strategy);
  printf ("Peak usage after allocations: %zu (expected: 3072)\n", peak);
  bool success = peak == 3072;

  default_deallocate (&strategy->base, ptr1);
  default_deallocate (&strategy->base, ptr2);

  peak = get_peak_usage (strategy);
  printf ("Peak usage after deallocations: %zu (expected: 3072)\n", peak);
  success &= peak == 3072; // Peak should remain unchanged

  destroy_default_strategy (strategy);
  printf ("test_peak_usage: %s\n", success ? "PASSED" : "FAILED");
  return success;
}

int
run_default_strategy_tests (void)
{
  int passed = 0;
  int total = 8;

  printf ("\nRunning DefaultStrategy standard tests...\n");

  if (test_strategy_creation ())
    passed++;
  if (test_basic_allocation ())
    passed++;
  if (test_concurrent_allocations ())
    passed++;
  if (test_error_handling ())
    passed++;
  if (test_memory_tracking ())
    passed++;
  if (test_status_transitions ())
    passed++;
  if (test_validation ())
    passed++;
  if (test_peak_usage ())
    passed++;

  printf ("\nStandard tests passed: %d/%d\n", passed, total);
  return passed == total ? 0 : 1;
}

int
run_all_tests (void)
{
  printf ("\n=== Starting Comprehensive Test Suite ===\n");

  int standard_result = run_default_strategy_tests ();
  if (standard_result != 0)
  {
    printf ("Standard tests failed, skipping fuzzing tests\n");
    return standard_result;
  }

  printf ("\n=== Starting Fuzzing Test Suite ===\n");
  run_fuzz_tests ();

  printf ("\n=== All Tests Completed Successfully ===\n");
  return 0;
}

int
main (void)
{
  srand ((unsigned int) time (NULL));
  return run_all_tests ();
}
