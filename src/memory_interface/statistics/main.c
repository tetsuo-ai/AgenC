#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "include/memory_stats.h"

memory_stats_t stats;

void
demonstrate_basic_tracking ()
{
  printf ("\n=== Basic Memory Tracking ===\n");
  void *ptr1 = malloc (256);
  void *ptr2 = malloc (1024);

  memory_stats_update_allocation (&stats, ptr1, 256, __FILE__, __LINE__);
  memory_stats_update_allocation (&stats, ptr2, 1024, __FILE__, __LINE__);

  stats_report_t report;
  memory_stats_get_report (&stats, &report);
  printf ("Current allocations: %lu\n", report.alloc_count);
  printf ("Current memory usage: %zu bytes\n", report.current_bytes);

  memory_stats_update_deallocation (&stats, ptr1);
  free (ptr1);
  memory_stats_update_deallocation (&stats, ptr2);
  free (ptr2);
}

void
demonstrate_pattern_analysis ()
{
  printf ("\n=== Pattern Analysis ===\n");

  size_t sizes[] = {32, 64, 128, 256, 512, 1024, 2048, 4096};
  void *ptrs[8];

  for (int i = 0; i < 8; i++)
  {
    ptrs[i] = malloc (sizes[i]);
    memory_stats_update_allocation (&stats, ptrs[i], sizes[i], __FILE__,
				    __LINE__);
  }

  char *analysis = memory_stats_analyze_patterns (&stats);
  printf ("%s\n", analysis);
  free (analysis);

  for (int i = 0; i < 8; i++)
  {
    memory_stats_update_deallocation (&stats, ptrs[i]);
    free (ptrs[i]);
  }
}

void
demonstrate_leak_detection ()
{
  printf ("\n=== Leak Detection ===\n");

  void *leak1 = malloc (128);
  void *leak2 = malloc (256);
  void *non_leak = malloc (512);

  memory_stats_update_allocation (&stats, leak1, 128, __FILE__, __LINE__);
  memory_stats_update_allocation (&stats, leak2, 256, __FILE__, __LINE__);
  memory_stats_update_allocation (&stats, non_leak, 512, __FILE__, __LINE__);

  memory_stats_update_deallocation (&stats, non_leak);
  free (non_leak);

  char *leak_report = memory_stats_check_leaks (&stats);
  printf ("%s\n", leak_report);
  free (leak_report);

  memory_stats_update_deallocation (&stats, leak1);
  memory_stats_update_deallocation (&stats, leak2);
  free (leak1);
  free (leak2);
}

int
main (int argc, char **argv)
{
  (void) argc;
  (void) argv;

  printf ("Memory Statistics Tracking Example\n");
  printf ("=================================\n");

  memory_stats_init (&stats);

  demonstrate_basic_tracking ();
  demonstrate_pattern_analysis ();
  demonstrate_leak_detection ();

  stats_report_t final_report;
  memory_stats_get_report (&stats, &final_report);
  printf ("\n=== Final Statistics ===\n");
  printf ("Total allocations: %lu\n", final_report.alloc_count);
  printf ("Total deallocations: %lu\n", final_report.free_count);
  printf ("Peak memory usage: %zu bytes\n", final_report.peak_bytes);

  return 0;
}
