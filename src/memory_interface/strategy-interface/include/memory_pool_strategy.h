/**
 * @file memory_pool_strategy.h
 * @brief Memory pool implementation of the memory strategy interface
 * @security Thread-safe, bounds-checked, overflow-protected
 */

#ifndef MEMORY_POOL_STRATEGY_H_
#define MEMORY_POOL_STRATEGY_H_

#include "memory_strategy.h"
#include <stddef.h>
#include <stdint.h>
#include <stdatomic.h>

/* Memory Pool Configuration Constants */
/**
 * @brief Core memory block configuration
 * @security All constants are power of 2 to prevent integer overflow in
 * calculations
 */
enum PoolConfig
{
  POOL_BLOCK_SIZE = 256,     /**< Size of each memory block in bytes */
  POOL_BLOCK_COUNT = 1024,   /**< Total number of blocks in the pool */
  BLOCKS_PER_BITMAP = 64,    /**< Number of blocks tracked per bitmap word */
  MAX_ALLOCATION_RETRIES = 3 /**< Maximum retries for failed allocations */
};

/**
 * @brief Memory allocation size limits
 * @security Prevents integer overflow in size calculations
 */
enum PoolSizeLimits
{
  POOL_MIN_ALLOCATION = sizeof (void *), /**< Minimum allocation size */
  POOL_METADATA_SIZE = sizeof (size_t),	 /**< Size of block metadata */
  POOL_MAX_ALLOCATION
  = (POOL_BLOCK_SIZE * (POOL_BLOCK_COUNT / 2) - POOL_METADATA_SIZE)
  /**< Maximum allocation size (limited to half pool to prevent fragmentation)
   */
};

/**
 * @brief Memory pool statistics and metrics
 * @security All members protected by atomic operations
 */
typedef struct PoolMetrics
{
  atomic_uint_fast32_t blocks_used; /**< Number of blocks currently in use */
  atomic_uint_fast32_t total_allocations; /**< Total successful allocations */
  atomic_uint_fast32_t
    failed_allocations; /**< Number of failed allocation attempts */
  atomic_uint_fast32_t concurrent_ops; /**< Number of concurrent operations */
} PoolMetrics;

/**
 * @brief Memory pool data structure
 * @security All members protected by atomic operations and bounds checking
 */
typedef struct
{
  atomic_uintptr_t pool_memory;	     /**< Pre-allocated memory pool */
  atomic_uintptr_t block_bitmap;     /**< Bitmap tracking block usage */
  atomic_size_t bitmap_size;	     /**< Size of bitmap in words */
  atomic_uint_fast32_t thread_count; /**< Number of active threads */
  atomic_uint_fast32_t
    initialization_flag; /**< Ensures single initialization */
  PoolMetrics metrics;	 /**< Pool usage statistics */
} MemoryPool;

/**
 * @brief Create a new memory pool strategy
 * @return Initialized MemoryStrategy with pool implementation
 * @security Thread-safe, null-checked, memory-safe
 */
MemoryStrategy *
create_pool_strategy (void);

/**
 * @brief Clean up and free a pool strategy
 * @param strategy Strategy to clean up
 * @security Thread-safe, null-checked, double-free protected
 */
void
destroy_pool_strategy (MemoryStrategy *strategy);

#endif /* MEMORY_POOL_STRATEGY_H_ */
