#include <assert.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include <unistd.h>
#include <sched.h>
#include <inttypes.h>
#include "../include/memory_stats.h"

#define HIGH_THREAD_COUNT 100
#define RAPID_ITERATIONS 1000
#define OVERFLOW_SIZE (SIZE_MAX / 2)
#define STRESS_THREADS 8
#define STRESS_ITERATIONS 10000

static void *
stress_alloc_dealloc_thread (void *arg)
{
  memory_stats_t *stats = (memory_stats_t *) arg;
  void *ptrs[10];

  for (int i = 0; i < STRESS_ITERATIONS; i++)
  {
    for (int j = 0; j < 10; j++)
    {
      size_t size = (rand () % 1024) + 1;
      ptrs[j] = malloc (size);
      if (ptrs[j] == NULL)
	continue;
      memory_stats_update_allocation (stats, ptrs[j], size, __FILE__, __LINE__);
    }

    usleep (rand () % 100);

    for (int j = 9; j >= 0; j--)
    {
      if (ptrs[j] != NULL)
      {
	memory_stats_update_deallocation (stats, ptrs[j]);
	free (ptrs[j]);
	ptrs[j] = NULL;
      }
    }

    sched_yield ();
  }
  return NULL;
}

void
test_stress_concurrent_access (void)
{
  printf ("Testing stress concurrent access...\n");
  memory_stats_t stats;
  stats_report_t initial_report, final_report;
  pthread_t threads[STRESS_THREADS];

  memory_stats_init (&stats);
  memory_stats_get_report (&stats, &initial_report);
  assert (initial_report.alloc_count == 0);
  assert (initial_report.free_count == 0);

  for (int i = 0; i < STRESS_THREADS; i++)
  {
    int rc
      = pthread_create (&threads[i], NULL, stress_alloc_dealloc_thread, &stats);
    (void) rc;
    assert (rc == 0);
  }

  for (int i = 0; i < STRESS_THREADS; i++)
  {
    pthread_join (threads[i], NULL);
  }

  usleep (1000);

  memory_stats_get_report (&stats, &final_report);
  uint64_t expected_count = STRESS_THREADS * STRESS_ITERATIONS * 10;

  printf ("Expected count: %" PRIu64 "\n", expected_count);
  printf ("Actual alloc count: %" PRIu64 "\n", final_report.alloc_count);
  printf ("Actual free count: %" PRIu64 "\n", final_report.free_count);

  assert (final_report.alloc_count <= expected_count);
  assert (final_report.free_count == final_report.alloc_count);
  assert (final_report.current_bytes == 0);
  assert (final_report.total_leaked_bytes == 0);

  printf ("Stress concurrent access tests passed\n");
}

void
test_fragmentation_patterns (void)
{
  printf ("Testing fragmentation patterns...\n");
  memory_stats_t stats;
  memory_stats_init (&stats);

#define FRAG_ALLOCS 100
  void *ptrs[FRAG_ALLOCS];
  size_t sizes[FRAG_ALLOCS];

  for (int i = 0; i < FRAG_ALLOCS; i++)
  {
    sizes[i] = (1 << (i % 12)) + 1;
    ptrs[i] = malloc (sizes[i]);
    memory_stats_update_allocation (&stats, ptrs[i], sizes[i], __FILE__,
				    __LINE__);
  }

  for (int i = 0; i < FRAG_ALLOCS; i += 2)
  {
    memory_stats_update_deallocation (&stats, ptrs[i]);
    free (ptrs[i]);
  }

  for (int i = 0; i < FRAG_ALLOCS; i += 2)
  {
    size_t new_size = sizes[i] / 2;
    ptrs[i] = malloc (new_size);
    memory_stats_update_allocation (&stats, ptrs[i], new_size, __FILE__,
				    __LINE__);
  }

  char *pattern_report = memory_stats_analyze_patterns (&stats);
  assert (pattern_report != NULL);
  assert (strstr (pattern_report, "Distribution") != NULL);
  free (pattern_report);

  for (int i = 0; i < FRAG_ALLOCS; i++)
  {
    memory_stats_update_deallocation (&stats, ptrs[i]);
    free (ptrs[i]);
  }

  printf ("Fragmentation pattern tests passed\n");
}

void
test_atomic_corners (void)
{
  printf ("Testing atomic operation corner cases...\n");
  memory_stats_t stats;
  memory_stats_init (&stats);

  void *ptr = malloc (1);
  for (int i = 0; i < 1000000; i++)
  {
    memory_stats_update_allocation (&stats, ptr, 1, __FILE__, __LINE__);
    memory_stats_update_deallocation (&stats, ptr);
  }
  free (ptr);

#define PEAK_THREADS 4
#define PEAK_ITERATIONS 1000

  pthread_t peak_threads[PEAK_THREADS];
  for (int i = 0; i < PEAK_THREADS; i++)
  {
    pthread_create (&peak_threads[i], NULL, stress_alloc_dealloc_thread,
		    &stats);
  }

  for (int i = 0; i < PEAK_THREADS; i++)
  {
    pthread_join (peak_threads[i], NULL);
  }

  stats_report_t report;
  memory_stats_get_report (&stats, &report);
  assert (report.peak_bytes > 0);
  assert (report.current_bytes == 0);

  printf ("Atomic corner case tests passed\n");
}

void
test_null_cases (void)
{
  printf ("Testing NULL pointer handling...\n");

  memory_stats_init (NULL);
  memory_stats_update_allocation (NULL, NULL, 0, NULL, 0);
  memory_stats_update_deallocation (NULL, NULL);
  memory_stats_get_report (NULL, NULL);
  memory_stats_analyze_patterns (NULL);
  memory_stats_check_leaks (NULL);

  memory_stats_t valid_stats;
  memory_stats_init (&valid_stats);
  memory_stats_update_allocation (&valid_stats, NULL, 0, NULL, 0);
  memory_stats_update_deallocation (&valid_stats, NULL);

  printf ("NULL pointer tests passed\n");
}

void
test_size_boundaries (void)
{
  printf ("Testing size boundary conditions...\n");
  memory_stats_t stats;
  stats_report_t report;
  memory_stats_init (&stats);

  void *ptr0 = malloc (0);
  memory_stats_update_allocation (&stats, ptr0, 0, __FILE__, __LINE__);
  memory_stats_get_report (&stats, &report);
  assert (report.alloc_count == 1);
  free (ptr0);

  void *ptr1 = malloc (STATS_SIZE_BUCKET_COUNT * 1024);
  memory_stats_update_allocation (&stats, ptr1, STATS_SIZE_BUCKET_COUNT * 1024,
				  __FILE__, __LINE__);
  memory_stats_get_report (&stats, &report);
  assert (report.size_distribution[STATS_SIZE_BUCKET_COUNT - 1].count > 0);
  free (ptr1);

  size_t large_size = 1024 * 1024 * 10;
  void *ptr2 = malloc (large_size);
  if (ptr2)
  {
    memory_stats_update_allocation (&stats, ptr2, large_size, __FILE__,
				    __LINE__);
    memory_stats_get_report (&stats, &report);
    assert (report.current_bytes >= large_size);
    free (ptr2);
  }

  printf ("Size boundary tests passed\n");
}

void *
stress_thread_routine (void *arg)
{
  memory_stats_t *stats = (memory_stats_t *) arg;
  size_t sizes[] = {16, 32, 64, 128, 256, 512, 1024};

  for (int i = 0; i < RAPID_ITERATIONS; i++)
  {
    size_t size = sizes[i % (sizeof (sizes) / sizeof (sizes[0]))];
    void *ptr = malloc (size);
    memory_stats_update_allocation (stats, ptr, size, __FILE__, __LINE__);

    if (rand () % 2)
    {
      memory_stats_update_deallocation (stats, ptr);
      free (ptr);
    }
  }
  return NULL;
}

void
test_high_concurrency (void)
{
  printf ("Testing high concurrency conditions...\n");
  memory_stats_t stats;
  stats_report_t report;
  memory_stats_init (&stats);

  pthread_t threads[HIGH_THREAD_COUNT];

  for (int i = 0; i < HIGH_THREAD_COUNT; i++)
  {
    pthread_create (&threads[i], NULL, stress_thread_routine, &stats);
  }

  for (int i = 0; i < HIGH_THREAD_COUNT; i++)
  {
    pthread_join (threads[i], NULL);
  }

  memory_stats_get_report (&stats, &report);
  assert (report.alloc_count == HIGH_THREAD_COUNT * RAPID_ITERATIONS);

  printf ("High concurrency tests passed\n");
}

void
test_overflow_handling (void)
{
  printf ("\nStarting reduced overflow handling test...\n");
  memory_stats_t stats;
  stats_report_t report;
  memory_stats_init (&stats);

#define DEBUG_TEST_SIZE 5
  void *ptrs[DEBUG_TEST_SIZE];
  memset (ptrs, 0, sizeof (ptrs));

  printf ("\n=== Starting Allocation Phase ===\n");
  for (int i = 0; i < DEBUG_TEST_SIZE; i++)
  {
    printf ("\nIteration %d:\n", i);
    ptrs[i] = malloc (1);
    if (!ptrs[i])
    {
      printf ("  Allocation failed at index %d\n", i);
      continue;
    }

    printf ("  Before allocation update - Getting report...\n");
    memory_stats_get_report (&stats, &report);
    printf ("  Current alloc_count before update: %" PRIu64 "\n", report.alloc_count);

    memory_stats_update_allocation (&stats, ptrs[i], 1, __FILE__, __LINE__);

    printf ("  After allocation update - Getting report...\n");
    memory_stats_get_report (&stats, &report);
    printf ("  Current alloc_count after update: %" PRIu64 "\n", report.alloc_count);

    if (report.alloc_count != (uint64_t) (i + 1))
    {
      printf ("  ERROR: Allocation count mismatch. Expected: %d, Got: %" PRIu64 "\n", i + 1, report.alloc_count);
    }
    assert (report.alloc_count == (uint64_t) (i + 1));

    usleep (100);
  }

  printf ("\n=== Starting Deallocation Phase ===\n");
  for (int i = 0; i < DEBUG_TEST_SIZE; i++)
  {
    printf ("\nDeallocation iteration %d:\n", i);
    if (!ptrs[i])
    {
      printf ("  Skipping NULL pointer at index %d\n", i);
      continue;
    }

    printf ("  Before deallocation - Getting report...\n");
    memory_stats_get_report (&stats, &report);
    printf ("  Current free_count before update: %" PRIu64 "\n", report.free_count);

    memory_stats_update_deallocation (&stats, ptrs[i]);
    free (ptrs[i]);

    printf ("  After deallocation - Getting report...\n");
    memory_stats_get_report (&stats, &report);
    printf ("  Current free_count after update: %" PRIu64 "\n", report.free_count);

    if (report.free_count != (uint64_t) (i + 1))
    {
      printf ("  ERROR: Free count mismatch. Expected: %d, Got: %" PRIu64 "\n", i + 1, report.free_count);
    }
    assert (report.free_count == (uint64_t) (i + 1));
    assert (report.alloc_count == DEBUG_TEST_SIZE);

    usleep (100);
  }

  printf ("\n=== Final Verification ===\n");
  memory_stats_get_report (&stats, &report);
  printf ("Final counts - Alloc: %" PRIu64 ", Free: %" PRIu64 "\n", report.alloc_count, report.free_count);

  assert (report.alloc_count == DEBUG_TEST_SIZE);
  assert (report.free_count == DEBUG_TEST_SIZE);
  assert (report.current_bytes == 0);

  printf ("Reduced overflow handling test completed.\n");
}

void
test_leak_detection_edges (void)
{
  printf ("Testing leak detection edge cases...\n");
  memory_stats_t stats;
  stats_report_t report;
  memory_stats_init (&stats);

  void *ptrs[STATS_MAX_TRACKED_ALLOCATIONS + 10];

  for (int i = 0; i < STATS_MAX_TRACKED_ALLOCATIONS + 10; i++)
  {
    ptrs[i] = malloc (16);
    memory_stats_update_allocation (&stats, ptrs[i], 16, __FILE__, __LINE__);
  }

  memory_stats_get_report (&stats, &report);
  assert (report.active_allocation_count <= STATS_MAX_TRACKED_ALLOCATIONS);

  for (int i = 0; i < STATS_MAX_TRACKED_ALLOCATIONS + 10; i++)
  {
    memory_stats_update_deallocation (&stats, ptrs[i]);
    free (ptrs[i]);
  }

  printf ("Leak detection edge case tests passed\n");
}

int
main (void)
{
  printf ("\n=== Starting Focused Overflow Test ===\n");
  test_overflow_handling ();
  printf ("=== Focused Test Complete ===\n");
  return 0;
}
