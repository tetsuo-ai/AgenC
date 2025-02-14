/**
 * @file memory_stats.h
 * @brief memory statistics tracking system
 */

#ifndef MEMORY_STATS_H_
#define MEMORY_STATS_H_

#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>
#include "stats_report.h"

/**
 * Maximum number of allocations to track for leak detection
 */
#define STATS_MAX_TRACKED_ALLOCATIONS 1000

/**
 * Size of circular buffer for allocation pattern analysis
 */
#define STATS_PATTERN_HISTORY_SIZE 100

/**
 * @brief Memory statistics tracking context
 *
 * This structure maintains thread-safe counters and tracking information
 * for memory allocations. All modifications are performed atomically.
 */
typedef struct memory_stats
{
  /* Basic statistics - atomic counters */
  _Atomic uint64_t alloc_count; /**< Total allocation count */
  _Atomic uint64_t free_count;	/**< Total deallocation count */
  _Atomic size_t current_bytes; /**< Current allocated bytes */
  _Atomic size_t peak_bytes;	/**< Peak allocated bytes */

  /* Pattern analysis */
  struct
  {
    size_t size_threshold;  /**< Upper bound of this bucket */
    _Atomic uint64_t count; /**< Number of allocations in this range */
  } size_distribution[STATS_SIZE_BUCKET_COUNT];

  _Atomic uint64_t total_allocation_time; /**< Total time spent in allocations */

  /* Active allocation tracking with atomic pointers */
  struct
  {
    _Atomic (void *) address;	/**< Memory address - atomic pointer */
    _Atomic size_t size;	/**< Size of allocation - atomic */
    const char *file;		/**< Source file of allocation */
    int line;			/**< Line number of allocation */
    _Atomic uint64_t timestamp; /**< Time of allocation - atomic */
    _Atomic uint8_t valid;	/**< Valid flag - atomic */
    _Atomic uint8_t in_use;	/**< In-use flag for synchronization */
  } active_allocations[STATS_MAX_TRACKED_ALLOCATIONS];

  _Atomic uint32_t active_allocation_count; /**< Number of active allocations */
  _Atomic uint64_t
  total_leaked_bytes; /**< Total bytes from unfreed allocations */

  /* Pattern history tracking */
  struct
  {
    _Atomic size_t size;	/**< Allocation size */
    _Atomic uint64_t timestamp; /**< Time of allocation */
  } recent_allocations[STATS_PATTERN_HISTORY_SIZE];
  _Atomic uint32_t
  allocation_history_index; /**< Current index in circular buffer */
} memory_stats_t;

/**
 * @brief Initialize memory statistics tracking
 *
 * Initializes all counters and tracking structures to zero.
 * Must be called before any other operations on the stats structure.
 *
 * @param stats Pointer to memory_stats structure to initialize
 * @return void
 * @note Thread-safe: No
 */
void memory_stats_init (memory_stats_t *stats);

/**
 * @brief Update statistics for memory allocation
 *
 * Records information about a memory allocation including size and source
 * location. All updates are performed atomically.
 *
 * @param stats Pointer to memory_stats structure
 * @param ptr Pointer to allocated memory
 * @param size Size of allocated memory in bytes
 * @param file Source file name where allocation occurred
 * @param line Line number where allocation occurred
 * @return void
 * @note Thread-safe: Yes
 */
void memory_stats_update_allocation (memory_stats_t *stats, void *ptr, size_t size, const char *file, int line);

/**
 * @brief Update statistics for memory deallocation
 *
 * Records deallocation of previously tracked memory.
 * All updates are performed atomically.
 *
 * @param stats Pointer to memory_stats structure
 * @param ptr Pointer to deallocated memory
 * @return void
 * @note Thread-safe: Yes
 */
void
memory_stats_update_deallocation (memory_stats_t *stats, void *ptr);

/**
 * @brief Reset all statistics to initial values
 *
 * Resets all counters and tracking information to zero.
 *
 * @param stats Pointer to memory_stats structure
 * @return void
 * @note Thread-safe: No
 */
void memory_stats_reset (memory_stats_t *stats);

/**
 * @brief Get current statistics report
 *
 * Generates a snapshot of current memory statistics including leak detection
 * and pattern analysis.
 *
 * @param stats Pointer to memory_stats structure
 * @param report Pointer to stats_report structure to fill
 * @return void
 * @note Thread-safe: Yes
 */
void memory_stats_get_report (const memory_stats_t *stats, stats_report_t *report);

/**
 * @brief Analyze allocation patterns
 *
 * Generates a detailed analysis of memory allocation patterns including
 * size distribution and frequency analysis.
 *
 * @param stats Pointer to memory_stats structure
 * @return Allocated string containing the analysis (caller must free)
 * @note Thread-safe: Yes
 */
char * memory_stats_analyze_patterns (const memory_stats_t *stats);

/**
 * @brief Check for memory leaks
 *
 * Generates a detailed report of currently leaked memory including
 * allocation locations and sizes.
 *
 * @param stats Pointer to memory_stats structure
 * @return Allocated string containing the leak report (caller must free)
 * @note Thread-safe: Yes
 */
char * memory_stats_check_leaks (const memory_stats_t *stats);

#endif /* MEMORY_STATS_H_ */
