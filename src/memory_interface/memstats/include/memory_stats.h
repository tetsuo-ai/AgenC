#ifndef MEMORY_STATS_H_
#define MEMORY_STATS_H_

#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>
#include "stats_report.h"

/* Return values for memory stats operations */
#define MEMORY_STATS_SUCCESS 0
#define MEMORY_STATS_ERROR 1

/* Maximum number of allocations to track for leak detection */
#define STATS_MAX_TRACKED_ALLOCATIONS 1000

/* Size of circular buffer for allocation pattern analysis */
#define STATS_PATTERN_HISTORY_SIZE 100

/**
 * @brief Memory statistics tracking context
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

  _Atomic uint64_t
    total_allocation_time; /**< Total time spent in allocations */

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

// clang-format off
/* Function declarations */
void memory_stats_init(memory_stats_t *stats);
void memory_stats_update_allocation(memory_stats_t *stats, void *ptr, size_t size, const char *file, int line);
int memory_stats_get_allocation_size(const memory_stats_t *stats, const void *ptr, size_t *size);
void memory_stats_update_deallocation(memory_stats_t *stats, void *ptr);
void memory_stats_reset(memory_stats_t *stats);
void memory_stats_get_report(const memory_stats_t *stats, stats_report_t *report);
char *memory_stats_analyze_patterns(const memory_stats_t *stats);
char *memory_stats_check_leaks(const memory_stats_t *stats);
// clang-format on

#endif /* MEMORY_STATS_H_ */
