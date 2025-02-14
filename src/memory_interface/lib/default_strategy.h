/**
 * @file default_strategy.h
 * @brief Thread-safe default memory management strategy implementation
 *
 * This file implements a thread-safe DefaultStrategy that provides memory
 * management functionality with comprehensive tracking and statistics. The
 * implementation meets the following key requirements:
 * - Thread-safe allocation and deallocation
 * - Memory usage statistics and leak detection
 * - Status tracking and validation
 * - Performance overhead < 5% compared to raw malloc/free
 *
 * Thread safety is achieved through atomic operations and proper memory
 * barriers.
 *
 * @note All operations are atomic and thread-safe by design
 * @warning Not intended for use in signal handlers or interrupt contexts
 */

#ifndef DEFAULT_STRATEGY_H
#define DEFAULT_STRATEGY_H

#include <stdatomic.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Include paths relative to the include directories
#include "memory_strategy.h"
#include "memory_stats.h"
#include "strategy_status.h"

/**
 * @brief Thread-safe default memory management strategy
 *
 * Implements the MemoryStrategy interface with additional features:
 * - Memory usage statistics tracking
 * - Thread-safe status management
 * - Peak memory usage monitoring
 * - Operation counting for debugging
 *
 * @note All member variables are atomic to ensure thread safety
 * @see MemoryStrategy for the base interface
 */
typedef struct DefaultStrategy
{
  MemoryStrategy base;		/**< Base strategy interface */
  memory_stats_t *stats;	/**< Memory usage statistics */
  StatusTracker status_tracker; /**< Thread-safe status management */

  // Atomic counters for usage tracking
  _Atomic size_t total_allocated; /**< Total bytes allocated */
  _Atomic size_t total_freed;	  /**< Total bytes freed */
  _Atomic size_t peak_usage;	  /**< Peak memory usage observed */
  _Atomic uint32_t usage_count;	  /**< Count of in-flight operations */
  _Atomic uint64_t
    operation_count; /**< Unique operation ID counter for debugging */
} DefaultStrategy;

// clang-format off
/**
 * @brief Creates and initializes a new DefaultStrategy instance
 *
 * Allocates and initializes a new DefaultStrategy with:
 * - Memory statistics tracking
 * - Status management
 * - Function pointers for the MemoryStrategy interface
 *
 * @return Pointer to initialized DefaultStrategy or NULL on failure
 * @note Thread-safe: Yes
 * @see destroy_default_strategy for cleanup
 */
DefaultStrategy *create_default_strategy(void);

/**
 * @brief Cleans up and destroys a DefaultStrategy instance
 *
 * Ensures proper cleanup of resources:
 * - Waits for in-flight operations to complete
 * - Generates leak report if needed
 * - Frees all associated resources
 *
 * @param strategy Strategy to destroy (must be non-NULL)
 * @note Thread-safe: Yes
 * @warning Undefined behavior if strategy is NULL or already destroyed
 */
void destroy_default_strategy(DefaultStrategy *strategy);

/**
 * @brief Thread-safe memory allocation function
 *
 * Allocates memory while maintaining:
 * - Usage statistics
 * - Thread safety through atomic operations
 * - Error handling and validation
 *
 * @param base Base strategy pointer (must be non-NULL)
 * @param size Number of bytes to allocate (must be > 0)
 * @return Allocated memory pointer or NULL on failure
 * @note Thread-safe: Yes
 * @warning May return NULL if size is 0 or on allocation failure
 */
void *default_allocate(MemoryStrategy *base, size_t size);

/**
 * @brief Thread-safe memory deallocation function
 *
 * Frees memory while:
 * - Updating usage statistics
 * - Maintaining thread safety
 * - Validating the operation
 *
 * @param base Base strategy pointer (must be non-NULL)
 * @param ptr Pointer to memory to free (may be NULL)
 * @note Thread-safe: Yes
 * @warning Undefined behavior if ptr was not allocated by this strategy
 */
void default_deallocate(MemoryStrategy *base, void *ptr);

/**
 * @brief Gets current strategy status
 *
 * @param base Base strategy pointer (must be non-NULL)
 * @return Current StrategyStatus
 * @note Thread-safe: Yes
 * @warning Returns STRATEGY_STATE_ERROR if base is NULL
 */
StrategyStatus default_get_status(MemoryStrategy *base);

/**
 * @brief Validates strategy state
 *
 * Checks:
 * - Function pointer validity
 * - Status tracker state
 * - Memory stats validity
 *
 * @param base Base strategy pointer (must be non-NULL)
 * @return true if valid, false otherwise
 * @note Thread-safe: Yes
 */
bool default_validate(MemoryStrategy *base);

/**
 * @brief Gets strategy name
 *
 * @return Constant string containing strategy name
 * @note Thread-safe: Yes
 */
const char *get_strategy_name(void);

/**
 * @brief Gets current memory usage
 *
 * @param strategy Strategy instance (must be non-NULL)
 * @return Current memory usage in bytes
 * @note Thread-safe: Yes
 * @warning Returns 0 if strategy is NULL
 */
size_t get_current_usage(const DefaultStrategy *strategy);

/**
 * @brief Gets peak memory usage
 *
 * @param strategy Strategy instance (must be non-NULL)
 * @return Peak memory usage in bytes
 * @note Thread-safe: Yes
 * @warning Returns 0 if strategy is NULL
 */
size_t get_peak_usage(const DefaultStrategy *strategy);

/**
 * @brief Gets total allocated memory
 *
 * @param strategy Strategy instance (must be non-NULL)
 * @return Total bytes allocated
 * @note Thread-safe: Yes
 * @warning Returns 0 if strategy is NULL
 */
size_t get_total_allocated(const DefaultStrategy *strategy);

/**
 * @brief Gets total freed memory
 *
 * @param strategy Strategy instance (must be non-NULL)
 * @return Total bytes freed
 * @note Thread-safe: Yes
 * @warning Returns 0 if strategy is NULL
 */
size_t get_total_freed(const DefaultStrategy *strategy);
// clang-format on

#endif // DEFAULT_STRATEGY_H
