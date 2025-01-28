#include "memory_pool_strategy.h"
#include "strategy_validator.h"
#include <stdlib.h>
#include <string.h>
#include <stdatomic.h>

static void *
pool_allocate (struct MemoryStrategy *self, size_t size);
static void
pool_deallocate (struct MemoryStrategy *self, void *ptr);
static StrategyStatus
pool_get_status (struct MemoryStrategy *self);
static bool
pool_validate (struct MemoryStrategy *self);

static bool
is_block_used (const uint64_t *bitmap, size_t block);
static size_t
blocks_needed (size_t size);
static bool
is_ptr_in_pool_range (const void *ptr, const void *pool_start,
		      size_t pool_size);
static void
secure_clear_memory (volatile void *memory, size_t size);
static bool
find_contiguous_blocks (const uint64_t *bitmap, size_t bitmap_size,
			size_t blocks_needed, size_t *start_block);
static void
mark_blocks (uint64_t *bitmap, size_t start_block, size_t num_blocks,
	     bool used);

static void *
pool_allocate (struct MemoryStrategy *self, size_t size)
{
  if (!validate_allocation (self, size))
  {
    return NULL;
  }

  MemoryPool *pool = (MemoryPool *) self->strategy_data;
  if (!pool || !pool->pool_memory || !pool->block_bitmap)
  {
    transition_status (self->status_tracker, STRATEGY_STATE_ERROR);
    return NULL;
  }

  uint32_t current_ops
    = atomic_fetch_add_explicit (&pool->metrics.concurrent_ops, 1,
				 memory_order_acquire);
  if (current_ops >= MAX_ALLOCATION_RETRIES)
  {
    atomic_fetch_sub_explicit (&pool->metrics.concurrent_ops, 1,
			       memory_order_release);
    atomic_fetch_add_explicit (&pool->metrics.failed_allocations, 1,
			       memory_order_relaxed);
    return NULL;
  }

  const size_t needed = blocks_needed (size);
  if (needed == 0)
  {
    atomic_fetch_sub_explicit (&pool->metrics.concurrent_ops, 1,
			       memory_order_release);
    atomic_fetch_add_explicit (&pool->metrics.failed_allocations, 1,
			       memory_order_relaxed);
    return NULL;
  }

  uint64_t *bitmap = (uint64_t *) atomic_load_explicit (&pool->block_bitmap,
							memory_order_acquire);
  size_t bitmap_size
    = atomic_load_explicit (&pool->bitmap_size, memory_order_acquire);

  size_t start_block;
  if (!find_contiguous_blocks (bitmap, bitmap_size, needed, &start_block))
  {
    atomic_fetch_sub_explicit (&pool->metrics.concurrent_ops, 1,
			       memory_order_release);
    atomic_fetch_add_explicit (&pool->metrics.failed_allocations, 1,
			       memory_order_relaxed);
    return NULL;
  }

  mark_blocks (bitmap, start_block, needed, true);

  uint32_t current_blocks
    = atomic_load_explicit (&pool->metrics.blocks_used, memory_order_relaxed);
  if (current_blocks > UINT32_MAX - needed)
  {
    mark_blocks (bitmap, start_block, needed, false);
    atomic_fetch_sub_explicit (&pool->metrics.concurrent_ops, 1,
			       memory_order_release);
    atomic_fetch_add_explicit (&pool->metrics.failed_allocations, 1,
			       memory_order_relaxed);
    return NULL;
  }

  atomic_fetch_add_explicit (&pool->metrics.blocks_used, needed,
			     memory_order_relaxed);
  atomic_fetch_add_explicit (&pool->metrics.total_allocations, 1,
			     memory_order_relaxed);

  void *pool_memory
    = (void *) atomic_load_explicit (&pool->pool_memory, memory_order_acquire);
  void *block_start = (char *) pool_memory + (start_block * POOL_BLOCK_SIZE);

  atomic_thread_fence (memory_order_release);
  *(size_t *) block_start = needed;
  atomic_thread_fence (memory_order_release);

  void *user_ptr = (char *) block_start + POOL_METADATA_SIZE;
  secure_clear_memory (user_ptr,
		       (needed * POOL_BLOCK_SIZE) - POOL_METADATA_SIZE);

  atomic_fetch_sub_explicit (&pool->metrics.concurrent_ops, 1,
			     memory_order_release);
  atomic_thread_fence (memory_order_seq_cst);

  return user_ptr;
}

static void
pool_deallocate (struct MemoryStrategy *self, void *ptr)
{
  if (!validate_deallocation (self, ptr))
  {
    return;
  }

  MemoryPool *pool = (MemoryPool *) self->strategy_data;
  if (!pool || !pool->pool_memory || !pool->block_bitmap)
  {
    transition_status (self->status_tracker, STRATEGY_STATE_ERROR);
    return;
  }

  uint32_t current_ops
    = atomic_fetch_add_explicit (&pool->metrics.concurrent_ops, 1,
				 memory_order_acquire);
  if (current_ops >= MAX_ALLOCATION_RETRIES)
  {
    atomic_fetch_sub_explicit (&pool->metrics.concurrent_ops, 1,
			       memory_order_release);
    return;
  }

  void *block_start = (char *) ptr - POOL_METADATA_SIZE;
  const size_t pool_size = POOL_BLOCK_SIZE * POOL_BLOCK_COUNT;
  void *pool_memory
    = (void *) atomic_load_explicit (&pool->pool_memory, memory_order_acquire);

  if (!is_ptr_in_pool_range (block_start, pool_memory, pool_size))
  {
    atomic_fetch_sub_explicit (&pool->metrics.concurrent_ops, 1,
			       memory_order_release);
    return;
  }

  const size_t block_index
    = ((char *) block_start - (char *) pool_memory) / POOL_BLOCK_SIZE;
  uint64_t *bitmap = (uint64_t *) atomic_load_explicit (&pool->block_bitmap,
							memory_order_acquire);

  if (!is_block_used (bitmap, block_index))
  {
    atomic_fetch_sub_explicit (&pool->metrics.concurrent_ops, 1,
			       memory_order_release);
    return;
  }

  atomic_thread_fence (memory_order_acquire);
  const size_t num_blocks = *(size_t *) block_start;

  if (num_blocks == 0 || block_index + num_blocks > POOL_BLOCK_COUNT)
  {
    atomic_fetch_sub_explicit (&pool->metrics.concurrent_ops, 1,
			       memory_order_release);
    return;
  }

  secure_clear_memory (block_start, num_blocks * POOL_BLOCK_SIZE);
  atomic_thread_fence (memory_order_release);

  mark_blocks (bitmap, block_index, num_blocks, false);

  uint32_t current_blocks
    = atomic_load_explicit (&pool->metrics.blocks_used, memory_order_relaxed);
  if (current_blocks >= num_blocks)
  {
    atomic_fetch_sub_explicit (&pool->metrics.blocks_used, num_blocks,
			       memory_order_relaxed);
  }

  atomic_fetch_sub_explicit (&pool->metrics.concurrent_ops, 1,
			     memory_order_release);
  atomic_thread_fence (memory_order_seq_cst);
}

static StrategyStatus
pool_get_status (struct MemoryStrategy *self)
{
  StrategyStatus current_status = STRATEGY_STATE_ERROR;
  if (validate_strategy (self)
      && get_current_status (self->status_tracker, &current_status)
	   == STRATEGY_SUCCESS)
  {
    return current_status;
  }
  return STRATEGY_STATE_ERROR;
}

static bool
pool_validate (struct MemoryStrategy *self)
{
  return validate_strategy (self);
}

MemoryStrategy *
create_pool_strategy (void)
{
  MemoryStrategy *strategy = calloc (1, sizeof (MemoryStrategy));
  if (!strategy)
  {
    return NULL;
  }

  if (!initialize_strategy (strategy))
  {
    free (strategy);
    return NULL;
  }

  MemoryPool *pool = calloc (1, sizeof (MemoryPool));
  if (!pool)
  {
    cleanup_strategy (strategy);
    free (strategy);
    return NULL;
  }

  void *pool_memory
    = aligned_alloc (sizeof (void *), POOL_BLOCK_SIZE * POOL_BLOCK_COUNT);
  size_t bitmap_size
    = (POOL_BLOCK_COUNT + BLOCKS_PER_BITMAP - 1) / BLOCKS_PER_BITMAP;
  uint64_t *block_bitmap = calloc (bitmap_size, sizeof (uint64_t));

  if (!pool_memory || !block_bitmap)
  {
    free (pool_memory);
    free (block_bitmap);
    free (pool);
    cleanup_strategy (strategy);
    free (strategy);
    return NULL;
  }

  secure_clear_memory (pool_memory, POOL_BLOCK_SIZE * POOL_BLOCK_COUNT);
  memset (block_bitmap, 0, bitmap_size * sizeof (uint64_t));

  atomic_store_explicit (&pool->pool_memory, (uintptr_t) pool_memory,
			 memory_order_release);
  atomic_store_explicit (&pool->block_bitmap, (uintptr_t) block_bitmap,
			 memory_order_release);
  atomic_store_explicit (&pool->bitmap_size, bitmap_size, memory_order_release);
  atomic_store_explicit (&pool->thread_count, 0, memory_order_release);
  atomic_store_explicit (&pool->initialization_flag, 0, memory_order_release);

  atomic_init (&pool->metrics.blocks_used, 0);
  atomic_init (&pool->metrics.total_allocations, 0);
  atomic_init (&pool->metrics.failed_allocations, 0);
  atomic_init (&pool->metrics.concurrent_ops, 0);

  strategy->allocate = pool_allocate;
  strategy->deallocate = pool_deallocate;
  strategy->get_status = pool_get_status;
  strategy->validate = pool_validate;
  strategy->strategy_data = pool;

  return strategy;
}

void
destroy_pool_strategy (MemoryStrategy *strategy)
{
  if (!strategy || !strategy->strategy_data)
  {
    return;
  }

  MemoryPool *pool = (MemoryPool *) strategy->strategy_data;

  void *pool_memory
    = (void *) atomic_load_explicit (&pool->pool_memory, memory_order_acquire);
  void *block_bitmap
    = (void *) atomic_load_explicit (&pool->block_bitmap, memory_order_acquire);
  size_t bitmap_size
    = atomic_load_explicit (&pool->bitmap_size, memory_order_acquire);

  secure_clear_memory (pool_memory, POOL_BLOCK_SIZE * POOL_BLOCK_COUNT);
  secure_clear_memory (block_bitmap, bitmap_size * sizeof (uint64_t));
  secure_clear_memory (pool, sizeof (MemoryPool));

  strategy->strategy_data = NULL;

  free (pool_memory);
  free (block_bitmap);
  free (pool);

  cleanup_strategy (strategy);
  free (strategy);
}

static bool
is_block_used (const uint64_t *bitmap, const size_t block)
{
  if (!bitmap || block >= POOL_BLOCK_COUNT)
  {
    return false;
  }

  const size_t word_idx = block / BLOCKS_PER_BITMAP;
  const size_t bit_idx = block % BLOCKS_PER_BITMAP;

  atomic_thread_fence (memory_order_acquire);
  return (bitmap[word_idx] & (1ULL << bit_idx)) != 0;
}

static size_t
blocks_needed (const size_t size)
{
  if (size > SIZE_MAX - POOL_METADATA_SIZE)
  {
    return 0;
  }

  const size_t total_size = size + POOL_METADATA_SIZE;
  if (total_size > (SIZE_MAX - (POOL_BLOCK_SIZE - 1)))
  {
    return 0;
  }

  size_t blocks = (total_size + POOL_BLOCK_SIZE - 1) / POOL_BLOCK_SIZE;
  if (blocks == 0 || blocks > POOL_BLOCK_COUNT)
  {
    return 0;
  }

  return blocks;
}

static bool
is_ptr_in_pool_range (const void *ptr, const void *pool_start,
		      const size_t pool_size)
{
  const uintptr_t ptr_addr = (uintptr_t) ptr;
  const uintptr_t start_addr = (uintptr_t) pool_start;

  if (pool_size > SIZE_MAX - start_addr)
  {
    return false;
  }

  const uintptr_t end_addr = start_addr + pool_size;
  return !(end_addr <= start_addr || ptr_addr < start_addr
	   || ptr_addr >= end_addr);
}

static void
secure_clear_memory (volatile void *memory, const size_t size)
{
  if (!memory || size == 0 || size > POOL_BLOCK_SIZE * POOL_BLOCK_COUNT)
  {
    return;
  }

  volatile unsigned char *p = memory;
  for (size_t i = 0; i < size; i++)
  {
    p[i] = 0xFF;
    atomic_thread_fence (memory_order_release);
    p[i] = 0x00;
    atomic_thread_fence (memory_order_release);
    p[i] = 0xAA;
    atomic_thread_fence (memory_order_release);
    p[i] = 0x00;
  }

  atomic_thread_fence (memory_order_seq_cst);
}

static bool
find_contiguous_blocks (const uint64_t *bitmap, const size_t bitmap_size,
			const size_t blocks_needed, size_t *start_block)
{
  if (bitmap_size > SIZE_MAX / BLOCKS_PER_BITMAP)
  {
    return false;
  }

  size_t consecutive = 0;
  const size_t total_blocks = bitmap_size * BLOCKS_PER_BITMAP;

  if (total_blocks > POOL_BLOCK_COUNT)
  {
    return false;
  }

  for (size_t i = 0; i < total_blocks; i++)
  {
    const size_t word_idx = i / BLOCKS_PER_BITMAP;
    const size_t bit_idx = i % BLOCKS_PER_BITMAP;

    atomic_thread_fence (memory_order_acquire);

    if (!(bitmap[word_idx] & (1ULL << bit_idx)))
    {
      consecutive++;
      if (consecutive >= blocks_needed)
      {
	if (i < blocks_needed - 1)
	{
	  return false;
	}
	*start_block = i - (blocks_needed - 1);
	return true;
      }
    }
    else
    {
      consecutive = 0;
    }
  }
  return false;
}

static void
mark_blocks (uint64_t *bitmap, const size_t start_block,
	     const size_t num_blocks, const bool used)
{
  if (!bitmap || start_block >= POOL_BLOCK_COUNT || num_blocks == 0
      || num_blocks > POOL_BLOCK_COUNT
      || start_block + num_blocks > POOL_BLOCK_COUNT)
  {
    return;
  }

  for (size_t i = 0; i < num_blocks; i++)
  {
    const size_t block = start_block + i;
    const size_t word_idx = block / BLOCKS_PER_BITMAP;
    const size_t bit_idx = block % BLOCKS_PER_BITMAP;

    atomic_thread_fence (memory_order_acquire);

    if (used)
    {
      bitmap[word_idx] |= (1ULL << bit_idx);
    }
    else
    {
      bitmap[word_idx] &= ~(1ULL << bit_idx);
    }

    atomic_thread_fence (memory_order_release);
  }

  atomic_thread_fence (memory_order_seq_cst);
}
