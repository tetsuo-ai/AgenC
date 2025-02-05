#include <assert.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../include/memory_stats.h"

#define NUM_THREADS 4
#define ITERATIONS 1000
#define TEST_ALLOCATION_SIZE 1024

void
test_basic_operations (void)
{
  memory_stats_t stats;
  stats_report_t report;

  memory_stats_init (&stats);

  void *ptr = malloc (TEST_ALLOCATION_SIZE);
  memory_stats_update_allocation (&stats, ptr, TEST_ALLOCATION_SIZE, __FILE__,
				  __LINE__);
  memory_stats_get_report (&stats, &report);
  assert (report.alloc_count == 1);
  assert (report.current_bytes == TEST_ALLOCATION_SIZE);
  assert (report.peak_bytes == TEST_ALLOCATION_SIZE);

  memory_stats_update_deallocation (&stats, ptr);
  free (ptr);
  memory_stats_get_report (&stats, &report);
  assert (report.free_count == 1);
  assert (report.current_bytes == 0);
  assert (report.peak_bytes == TEST_ALLOCATION_SIZE);

  memory_stats_reset (&stats);
  memory_stats_get_report (&stats, &report);
  assert (report.alloc_count == 0);
  assert (report.free_count == 0);
  assert (report.current_bytes == 0);
  assert (report.peak_bytes == 0);

  printf ("Basic operations test passed\n");
}

void
test_pattern_analysis (void)
{
  memory_stats_t stats;
  stats_report_t report;

  memory_stats_init (&stats);

  size_t test_sizes[] = {16, 64, 256, 1024, 4096};
  void *ptrs[5];
  size_t num_sizes = sizeof (test_sizes) / sizeof (test_sizes[0]);

  for (size_t i = 0; i < num_sizes; i++)
  {
    ptrs[i] = malloc (test_sizes[i]);
    memory_stats_update_allocation (&stats, ptrs[i], test_sizes[i], __FILE__,
				    __LINE__);
  }

  char *analysis = memory_stats_analyze_patterns (&stats);
  assert (analysis != NULL);

  memory_stats_get_report (&stats, &report);
  assert (report.alloc_count == num_sizes);
  assert (report.avg_allocation_size > 0);

  size_t total_count = 0;
  for (int i = 0; i < STATS_SIZE_BUCKET_COUNT; i++)
  {
    total_count += report.size_distribution[i].count;
  }
  assert (total_count == num_sizes);

  for (size_t i = 0; i < num_sizes; i++)
  {
    memory_stats_update_deallocation (&stats, ptrs[i]);
    free (ptrs[i]);
  }

  free (analysis);
  printf ("Pattern analysis test passed\n");
}

void
test_leak_detection (void)
{
  memory_stats_t stats;
  stats_report_t report;

  memory_stats_init (&stats);

  void *leak1 = malloc (128);
  void *leak2 = malloc (256);
  void *non_leak = malloc (512);

  memory_stats_update_allocation (&stats, leak1, 128, __FILE__, __LINE__);
  memory_stats_update_allocation (&stats, leak2, 256, __FILE__, __LINE__);
  memory_stats_update_allocation (&stats, non_leak, 512, __FILE__, __LINE__);

  memory_stats_update_deallocation (&stats, non_leak);
  free (non_leak);

  char *leak_report = memory_stats_check_leaks (&stats);
  assert (leak_report != NULL);

  memory_stats_get_report (&stats, &report);
  assert (report.active_allocation_count == 2);
  assert (report.total_leaked_bytes == 384);
  assert (report.leak_count >= 2);

  memory_stats_update_deallocation (&stats, leak1);
  memory_stats_update_deallocation (&stats, leak2);
  free (leak1);
  free (leak2);
  free (leak_report);

  printf ("Leak detection test passed\n");
}

typedef struct
{
  memory_stats_t *stats;
  int thread_id;
} thread_args_t;

void *
thread_routine (void *arg)
{
  thread_args_t *args = (thread_args_t *) arg;

  for (int i = 0; i < ITERATIONS; i++)
  {
    void *ptr = malloc (TEST_ALLOCATION_SIZE);
    memory_stats_update_allocation (args->stats, ptr, TEST_ALLOCATION_SIZE,
				    __FILE__, __LINE__);
    memory_stats_update_deallocation (args->stats, ptr);
    free (ptr);
  }

  return NULL;
}

void
test_thread_safety (void)
{
  memory_stats_t stats;
  stats_report_t report;
  pthread_t threads[NUM_THREADS];
  thread_args_t thread_args[NUM_THREADS];

  memory_stats_init (&stats);

  for (int i = 0; i < NUM_THREADS; i++)
  {
    thread_args[i].stats = &stats;
    thread_args[i].thread_id = i;
    pthread_create (&threads[i], NULL, thread_routine, &thread_args[i]);
  }

  for (int i = 0; i < NUM_THREADS; i++)
  {
    pthread_join (threads[i], NULL);
  }

  memory_stats_get_report (&stats, &report);
  assert (report.alloc_count == NUM_THREADS * ITERATIONS);
  assert (report.free_count == NUM_THREADS * ITERATIONS);
  assert (report.current_bytes == 0);
  assert (report.total_leaked_bytes == 0);

  printf ("Thread safety test passed\n");
}

int
main (void)
{
  test_basic_operations ();
  test_pattern_analysis ();
  test_leak_detection ();
  test_thread_safety ();
  printf ("All tests passed!\n");
  return 0;
}
