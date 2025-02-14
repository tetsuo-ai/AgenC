/**
 * @file stats_report.h
 * @brief Memory statistics reporting functionality
 *
 * This header defines structures and functions for reporting memory statistics,
 * including allocation patterns, memory leaks, and usage trends.
 *
 * @copyright 7etsuo (c) 2025
 */

#ifndef MEMORY_STATS_REPORT_H_
#define MEMORY_STATS_REPORT_H_

#include <stddef.h>
#include <stdint.h>

/**
 * Maximum number of size buckets for allocation distribution
 */
#define STATS_SIZE_BUCKET_COUNT 8

/**
 * Maximum number of leaks to track in a report
 */
#define STATS_MAX_LEAK_REPORTS 100

/**
 * @brief Information about a detected memory leak
 */
typedef struct stats_leak_info
{
  void *address;      /**< Leaked memory address */
  size_t size;	      /**< Size of leaked allocation in bytes */
  const char *file;   /**< Source file where allocation occurred */
  int line;	      /**< Line number where allocation occurred */
  uint64_t timestamp; /**< Time of allocation (unix timestamp) */
} stats_leak_info_t;

/**
 * @brief Size distribution bucket information
 */
typedef struct stats_size_bucket
{
  size_t threshold; /**< Upper bound of size bucket in bytes */
  uint64_t count;   /**< Number of allocations in this bucket */
} stats_size_bucket_t;

/**
 * @brief Comprehensive memory statistics report
 */
typedef struct stats_report
{
  /* Basic allocation statistics */
  uint64_t alloc_count; /**< Total number of allocations */
  uint64_t free_count;	/**< Total number of deallocations */
  size_t current_bytes; /**< Currently allocated bytes */
  size_t peak_bytes;	/**< Peak allocated bytes */

  /* Pattern analysis */
  stats_size_bucket_t size_distribution[STATS_SIZE_BUCKET_COUNT]; /**<
				 Distribution of allocation sizes */
  double avg_allocation_size;	 /**< Average allocation size in bytes */
  uint64_t allocation_frequency; /**< Allocations per second */

  /* Leak detection */
  uint32_t
    active_allocation_count; /**< Number of active (unfreed) allocations */
  size_t total_leaked_bytes; /**< Total bytes from unfreed allocations */
  stats_leak_info_t
    leaks[STATS_MAX_LEAK_REPORTS]; /**< Details of detected leaks */
  uint32_t leak_count;		   /**< Number of leaks in the report */
} stats_report_t;

// clang-format off
/**
 * @brief Convert stats report to a human-readable string representation
 *
 * @param report Pointer to stats_report structure to convert
 * @return Pointer to statically allocated string containing the report.
 *         Returns "Invalid report" if report is NULL.
 * @note The returned string is valid until the next call to this function
 */
const char *stats_report_to_string(const stats_report_t *report);
// clang-format on

#endif /* MEMORY_STATS_REPORT_H_ */
