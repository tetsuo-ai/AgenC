#define _GNU_SOURCE
/**
 * @file test_fuzz_default_strategy.c
 * @brief Enhanced fuzzing tests for DefaultStrategy implementation
 */

#include "test_default_strategy.h"
#include "../src/default_strategy.h"
#include <pthread.h>
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <stdatomic.h>
#include <errno.h>
#include <time.h>

#define FUZZ_THREADS 8			// Reduced thread count
#define FUZZ_ITERATIONS 1000		// Reduced iterations
#define MAX_ALLOCATION_SIZE (64 * 1024) // Reduced to 64KB
#define MIN_ALLOCATION_SIZE 1
#define RANDOM_DELAY_MAX_US 1000
#define ALLOCATION_PATTERN_COUNT 8
#define REALLOCATION_PROBABILITY 15
#define EARLY_FREE_PROBABILITY 10
#define MEMORY_CHECK_PATTERN 0xAA
#define CLEANUP_RETRY_COUNT 3

typedef struct
{
  DefaultStrategy *strategy;
  unsigned int seed;
  atomic_size_t total_allocated;
  atomic_size_t total_freed;
  atomic_size_t errors;
  atomic_size_t reallocations;
  atomic_bool should_stop;
  atomic_int active_threads;
  atomic_bool cleanup_phase;
} fuzz_context_t;

typedef struct
{
  void *ptr;
  size_t size;
  uint32_t checksum;
  bool is_valid;
} allocation_record_t;

static void
random_delay (unsigned int *seed)
{
  if (rand_r (seed) % 4 == 0)
  {
    unsigned int delay
      = (rand_r (seed) % RANDOM_DELAY_MAX_US) * (1 << (rand_r (seed) % 4));
    usleep (delay);
  }
}

static size_t
get_random_size (unsigned int *seed)
{
  int pattern = rand_r (seed) % ALLOCATION_PATTERN_COUNT;
  size_t size;

  switch (pattern)
  {
  case 0: // Tiny allocations (1-16 bytes)
    size = (rand_r (seed) % 16) + 1;
    break;
  case 1: // Small allocations (17-256 bytes)
    size = (rand_r (seed) % 240) + 17;
    break;
  case 2: // Medium allocations (257-4096 bytes)
    size = (rand_r (seed) % 3840) + 257;
    break;
  case 3: // Large allocations
    size = (rand_r (seed) % (32 * 1024)) + 4097;
    break;
  case 4:				 // Power of 2 sizes
    size = 1ULL << (rand_r (seed) % 12); // Reduced max power
    break;
  case 5: // Page boundary adjacent
    size = 4096 + ((rand_r (seed) % 128) - 64);
    break;
  case 6: // Cache line adjacent (64 bytes)
    size = 64 + ((rand_r (seed) % 16) - 8);
    break;
  case 7: // Prime numbers near power of 2
    size = (1ULL << (rand_r (seed) % 10)) + (rand_r (seed) % 17) - 8;
    break;
  default:
    size = 64;
  }

  return size < MIN_ALLOCATION_SIZE
	   ? MIN_ALLOCATION_SIZE
	   : (size > MAX_ALLOCATION_SIZE ? MAX_ALLOCATION_SIZE : size);
}

static uint32_t
calculate_checksum (const void *ptr, size_t size)
{
  const unsigned char *data = (const unsigned char *) ptr;
  uint32_t checksum = 0;

  for (size_t i = 0; i < size; i++)
  {
    checksum = ((checksum << 5) + checksum) + data[i];
  }

  return checksum;
}

static bool
verify_allocation (allocation_record_t *record)
{
  if (!record->ptr || !record->is_valid)
    return false;

  const unsigned char *mem = (const unsigned char *) record->ptr;
  for (size_t i = 0; i < record->size; i++)
  {
    if (mem[i] != MEMORY_CHECK_PATTERN)
    {
      return false;
    }
  }

  uint32_t current_checksum = calculate_checksum (record->ptr, record->size);
  return current_checksum == record->checksum;
}

static void
safe_deallocate (DefaultStrategy *strategy, allocation_record_t *record)
{
  if (!record->ptr || !record->is_valid)
    return;

  atomic_thread_fence (memory_order_acquire);

  if (verify_allocation (record))
  {
    default_deallocate (&strategy->base, record->ptr);
    record->ptr = NULL;
    record->is_valid = false;
  }

  atomic_thread_fence (memory_order_release);
}

static void *
fuzz_worker (void *arg)
{
  fuzz_context_t *ctx = (fuzz_context_t *) arg;
  allocation_record_t *allocations
    = calloc (FUZZ_ITERATIONS, sizeof (allocation_record_t));
  if (!allocations)
  {
    atomic_fetch_add (&ctx->errors, 1);
    return NULL;
  }

  unsigned int local_seed
    = ctx->seed ^ (unsigned int) (uintptr_t) pthread_self ();
  size_t successful_allocs = 0;
  atomic_size_t thread_total_allocated = 0;
  atomic_size_t thread_total_freed = 0;

  atomic_fetch_add (&ctx->active_threads, 1);
  atomic_thread_fence (memory_order_seq_cst);

  while (!atomic_load (&ctx->should_stop) && !atomic_load (&ctx->cleanup_phase)
	 && successful_allocs < FUZZ_ITERATIONS)
  {
    int operation = rand_r (&local_seed) % 100;

    if (operation < REALLOCATION_PROBABILITY && successful_allocs > 0)
    {
      size_t idx = rand_r (&local_seed) % successful_allocs;
      if (allocations[idx].is_valid)
      {
	atomic_thread_fence (memory_order_acquire);
	size_t new_size = get_random_size (&local_seed);
	void *new_ptr = default_allocate (&ctx->strategy->base, new_size);

	if (new_ptr)
	{
	  if (verify_allocation (&allocations[idx]))
	  {
	    size_t copy_size = (new_size < allocations[idx].size)
				 ? new_size
				 : allocations[idx].size;
	    memcpy (new_ptr, allocations[idx].ptr, copy_size);

	    atomic_fetch_add (&thread_total_allocated, new_size);
	    safe_deallocate (ctx->strategy, &allocations[idx]);
	    atomic_fetch_add (&thread_total_freed, allocations[idx].size);

	    allocations[idx].ptr = new_ptr;
	    allocations[idx].size = new_size;
	    memset (new_ptr, MEMORY_CHECK_PATTERN, new_size);
	    allocations[idx].checksum = calculate_checksum (new_ptr, new_size);
	    allocations[idx].is_valid = true;

	    atomic_fetch_add (&ctx->reallocations, 1);
	  }
	  else
	  {
	    default_deallocate (&ctx->strategy->base, new_ptr);
	    atomic_fetch_add (&ctx->errors, 1);
	  }
	}
	atomic_thread_fence (memory_order_release);
      }
    }
    else if (operation < EARLY_FREE_PROBABILITY && successful_allocs > 0)
    {
      size_t idx = rand_r (&local_seed) % successful_allocs;
      if (allocations[idx].is_valid)
      {
	atomic_thread_fence (memory_order_acquire);
	if (verify_allocation (&allocations[idx]))
	{
	  atomic_fetch_add (&thread_total_freed, allocations[idx].size);
	  safe_deallocate (ctx->strategy, &allocations[idx]);
	}
	else
	{
	  atomic_fetch_add (&ctx->errors, 1);
	}
	atomic_thread_fence (memory_order_release);
      }
    }
    else
    {
      size_t size = get_random_size (&local_seed);
      random_delay (&local_seed);

      atomic_thread_fence (memory_order_acquire);
      void *ptr = default_allocate (&ctx->strategy->base, size);

      if (ptr)
      {
	allocation_record_t *record = &allocations[successful_allocs];
	record->ptr = ptr;
	record->size = size;
	record->is_valid = true;

	memset (ptr, MEMORY_CHECK_PATTERN, size);
	record->checksum = calculate_checksum (ptr, size);

	atomic_fetch_add (&thread_total_allocated, size);
	successful_allocs++;

	atomic_thread_fence (memory_order_release);
	random_delay (&local_seed);
      }
    }
  }

  atomic_thread_fence (memory_order_seq_cst);
  size_t cleanup_retries = 0;
  const size_t MAX_CLEANUP_RETRIES = 3;

  while (cleanup_retries < MAX_CLEANUP_RETRIES)
  {
    bool cleanup_failed = false;

    for (size_t i = 0; i < successful_allocs; i++)
    {
      if (allocations[i].is_valid)
      {
	if (verify_allocation (&allocations[i]))
	{
	  atomic_fetch_add (&thread_total_freed, allocations[i].size);
	  safe_deallocate (ctx->strategy, &allocations[i]);
	}
	else
	{
	  atomic_fetch_add (&ctx->errors, 1);
	  cleanup_failed = true;
	}
      }
    }

    if (!cleanup_failed)
      break;
    cleanup_retries++;
    usleep (1000 * (1 << cleanup_retries)); // Exponential backoff
  }

  atomic_thread_fence (memory_order_seq_cst);
  atomic_fetch_add (&ctx->total_allocated, thread_total_allocated);
  atomic_fetch_add (&ctx->total_freed, thread_total_freed);

  free (allocations);
  atomic_fetch_sub (&ctx->active_threads, 1);
  atomic_thread_fence (memory_order_seq_cst);

  return NULL;
}

void
test_allocation_pattern_fuzzing (void)
{
  printf ("Running enhanced allocation pattern fuzzing test...\n");

  DefaultStrategy *strategy = create_default_strategy ();
  assert (strategy != NULL);

  fuzz_context_t ctx = {.strategy = strategy,
			.seed = (unsigned int) time (NULL),
			.total_allocated = 0,
			.total_freed = 0,
			.errors = 0,
			.reallocations = 0,
			.should_stop = false,
			.active_threads = 0,
			.cleanup_phase = false};

  pthread_t threads[FUZZ_THREADS];
  atomic_thread_fence (memory_order_seq_cst);

  for (int i = 0; i < FUZZ_THREADS; i++)
  {
    int rc = pthread_create (&threads[i], NULL, fuzz_worker, &ctx);
    if (rc != 0)
    {
      fprintf (stderr, "Failed to create thread %d: %s\n", i, strerror (rc));
      atomic_store (&ctx.should_stop, true);
      break;
    }
    usleep (1000);
  }

  stats_report_t last_report = {0};
  size_t unchanged_count = 0;
  while (atomic_load (&ctx.active_threads) > 0)
  {
    stats_report_t report;
    memory_stats_get_report (strategy->stats, &report);

    if (report.current_bytes == last_report.current_bytes
	&& report.current_bytes > 0)
    {
      unchanged_count++;
      if (unchanged_count > 5)
      { // If usage is stuck for 500ms
	printf ("\nStuck memory usage detected, initiating cleanup...\n");
	atomic_store (&ctx.cleanup_phase, true);
	atomic_store (&ctx.should_stop, true);
	break;
      }
    }
    else
    {
      unchanged_count = 0;
    }
    last_report = report;

    printf ("\rActive threads: %d, Current usage: %zu bytes, "
	    "Peak: %zu bytes, Errors: %zu, Reallocations: %zu  ",
	    atomic_load (&ctx.active_threads), report.current_bytes,
	    report.peak_bytes, (size_t) ctx.errors, (size_t) ctx.reallocations);
    fflush (stdout);

    if (report.current_bytes > MAX_ALLOCATION_SIZE * FUZZ_THREADS * 2)
    {
      printf ("\nExcessive memory usage detected, initiating cleanup...\n");
      atomic_store (&ctx.cleanup_phase, true);
    }

    usleep (100000);
  }
  printf ("\n");

  struct timespec timeout;
  clock_gettime (CLOCK_REALTIME, &timeout);
  timeout.tv_sec += 2; // 2 second timeout

  for (int i = 0; i < FUZZ_THREADS; i++)
  {
    int rc = pthread_timedjoin_np (threads[i], NULL, &timeout);
    if (rc == ETIMEDOUT)
    {
      printf ("Thread %d timed out during cleanup, forcing stop...\n", i);
      atomic_store (&ctx.should_stop, true);
    }
  }

  atomic_thread_fence (memory_order_seq_cst);

  stats_report_t final_report;
  bool cleanup_success = false;
  size_t retry_delay = 100000; // Start with 100ms

  const int MAX_GLOBAL_CLEANUP_RETRIES = 5;
  for (int cleanup_retry = 0;
       cleanup_retry < MAX_GLOBAL_CLEANUP_RETRIES && !cleanup_success;
       cleanup_retry++)
  {
    memory_stats_get_report (strategy->stats, &final_report);

    if (final_report.current_bytes == 0
	&& final_report.active_allocation_count == 0)
    {
      cleanup_success = true;
    }
    else
    {
      usleep (retry_delay);
      retry_delay *= 2; // Exponential backoff
    }
  }

  printf ("\nFinal Results:\n");
  printf ("Total Allocated: %zu bytes\n", (size_t) ctx.total_allocated);
  printf ("Total Freed: %zu bytes\n", (size_t) ctx.total_freed);
  printf ("Total Reallocations: %zu\n", (size_t) ctx.reallocations);
  printf ("Peak Usage: %zu bytes\n", get_peak_usage (strategy));
  printf ("Error Count: %zu\n", (size_t) ctx.errors);
  printf ("Active Allocations: %u\n", final_report.active_allocation_count);
  printf ("Memory Leaks: %zu bytes\n", final_report.total_leaked_bytes);

  if (ctx.total_allocated != ctx.total_freed)
  {
    printf ("Memory tracking mismatch:\n");
    printf ("Total allocated: %zu\n", (size_t) ctx.total_allocated);
    printf ("Total freed: %zu\n", (size_t) ctx.total_freed);
    printf ("Difference: %zd bytes\n",
	    (ssize_t) ctx.total_allocated - (ssize_t) ctx.total_freed);
  }

  assert (ctx.total_allocated == ctx.total_freed);
  assert (final_report.current_bytes == 0);
  assert (final_report.active_allocation_count == 0);
  assert (final_report.total_leaked_bytes == 0);
  assert (ctx.errors == 0);

  destroy_default_strategy (strategy);
  printf ("Enhanced allocation pattern fuzzing test completed\n");
}

void
test_edge_case_fuzzing (void)
{
  printf ("Running edge case fuzzing test...\n");
  DefaultStrategy *strategy = create_default_strategy ();
  assert (strategy != NULL);

  atomic_thread_fence (memory_order_seq_cst);

  void *ptrs[1000] = {NULL};
  size_t sizes[1000] = {0};
  size_t alloc_count = 0;

  void *ptr = default_allocate (&strategy->base, SIZE_MAX);
  assert (ptr == NULL);

  ptr = default_allocate (&strategy->base, 0);
  assert (ptr == NULL);

  for (int i = 0; i < 1000 && alloc_count < 1000; i++)
  {
    sizes[alloc_count] = 1 << (i % 12); // Power of 2 sizes up to 4KB
    atomic_thread_fence (memory_order_acquire);

    ptrs[alloc_count] = default_allocate (&strategy->base, sizes[alloc_count]);
    if (ptrs[alloc_count])
    {
      size_t allocated_size;
      memory_stats_get_allocation_size (strategy->stats, ptrs[alloc_count],
					&allocated_size);
      assert (allocated_size == sizes[alloc_count]);

      memset (ptrs[alloc_count], i % 256, sizes[alloc_count]);
      alloc_count++;
    }

    atomic_thread_fence (memory_order_release);
  }

  for (size_t i = 0; i < alloc_count; i++)
  {
    if (ptrs[i])
    {
      atomic_thread_fence (memory_order_acquire);
      default_deallocate (&strategy->base, ptrs[i]);
      atomic_thread_fence (memory_order_release);
    }
  }

  atomic_thread_fence (memory_order_seq_cst);
  usleep (10000); // 10ms delay for final cleanup

  stats_report_t report;
  memory_stats_get_report (strategy->stats, &report);
  assert (report.current_bytes == 0);
  assert (report.active_allocation_count == 0);
  assert (report.total_leaked_bytes == 0);

  destroy_default_strategy (strategy);
  printf ("Edge case fuzzing test passed\n");
}

void
run_fuzz_tests (void)
{
  printf ("\nRunning DefaultStrategy fuzzing tests...\n");

  for (int i = 0; i < 3; i++)
  {
    printf ("\nFuzz test iteration %d:\n", i + 1);
    test_allocation_pattern_fuzzing ();
    test_edge_case_fuzzing ();
    usleep (100000); // Delay between iterations
  }

  printf ("\nAll fuzzing tests completed successfully\n");
}
