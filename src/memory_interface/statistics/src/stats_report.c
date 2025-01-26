/**
 * @file stats_report.c
 * @brief Implementation of memory statistics reporting functionality
 */

#include "../include/stats_report.h"
#include <stdio.h>
#include <time.h>

/** Size of the static report buffer */
#define REPORT_BUFFER_SIZE 4096

/** Static buffer for report string generation */
static char report_buffer[REPORT_BUFFER_SIZE];

const char *
stats_report_to_string (const stats_report_t *report)
{
  if (!report)
    return "Invalid report";

  int offset
    = snprintf (report_buffer, REPORT_BUFFER_SIZE,
		"Memory Statistics Report\n"
		"=====================\n"
		"Basic Statistics:\n"
		"  Allocations:     %lu\n"
		"  Deallocations:   %lu\n"
		"  Current Memory:  %zu bytes\n"
		"  Peak Memory:     %zu bytes\n"
		"\nPattern Analysis:\n"
		"  Average Size:    %.2f bytes\n"
		"  Alloc Rate:      %lu/sec\n"
		"\nSize Distribution:\n",
		report->alloc_count, report->free_count, report->current_bytes,
		report->peak_bytes, report->avg_allocation_size,
		report->allocation_frequency);

  for (int i = 0; i < STATS_SIZE_BUCKET_COUNT && offset < REPORT_BUFFER_SIZE;
       i++)
  {
    offset += snprintf (report_buffer + offset, REPORT_BUFFER_SIZE - offset,
			"  ≤ %zu bytes:     %lu allocations\n",
			report->size_distribution[i].threshold,
			report->size_distribution[i].count);
  }

  if (offset < REPORT_BUFFER_SIZE)
  {
    offset
      += snprintf (report_buffer + offset, REPORT_BUFFER_SIZE - offset,
		   "\nLeak Detection:\n"
		   "  Active Allocations: %u\n"
		   "  Total Leaked:       %zu bytes\n",
		   report->active_allocation_count, report->total_leaked_bytes);

    if (report->leak_count > 0)
    {
      offset += snprintf (report_buffer + offset, REPORT_BUFFER_SIZE - offset,
			  "  Detected Leaks:     %u\n", report->leak_count);
    }
  }

  report_buffer[REPORT_BUFFER_SIZE - 1] = '\0';

  return report_buffer;
}
