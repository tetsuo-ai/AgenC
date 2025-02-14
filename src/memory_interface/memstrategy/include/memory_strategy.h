/**
 * @file memory_strategy.h
 * @brief Memory management strategy interface
 */

#ifndef MEMORY_STRATEGY_H_
#define MEMORY_STRATEGY_H_

#include "strategy_status.h"
#include <stddef.h>
#include <stdbool.h>

/**
 * @brief Memory strategy interface
 * @note All implementations must provide thread-safe operations
 */
typedef struct MemoryStrategy
{
  /* Core operations */
  void *(*allocate) (struct MemoryStrategy *self, size_t size);
  void (*deallocate) (struct MemoryStrategy *self, void *ptr);
  StrategyStatus (*get_status) (struct MemoryStrategy *self);
  bool (*validate) (struct MemoryStrategy *self);

  /* Internal state */
  StatusTracker *status_tracker; /**< Thread-safe status tracking */
  void *strategy_data;		 /**< Implementation-specific data */
} MemoryStrategy;

/**
 * @brief Initialize a memory strategy
 * @param strategy Pointer to strategy to initialize
 * @return true if initialization successful, false otherwise
 */
bool
initialize_strategy (MemoryStrategy *strategy);

/**
 * @brief Clean up a memory strategy
 * @param strategy Pointer to strategy to cleanup
 */
void
cleanup_strategy (MemoryStrategy *strategy);

#endif /* MEMORY_STRATEGY_H_ */
