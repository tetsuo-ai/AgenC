/**
 * @file main.c
 * @brief Example usage of the memory management strategy API
 */

#include "include/memory_strategy.h"
#include "include/memory_pool_strategy.h"
#include <stdio.h>
#include <string.h>

#define ALLOCATION_SIZE 1024
#define SMALL_ALLOC 64

int
main (void)
{
  // Create and initialize pool strategy
  MemoryStrategy *strategy = create_pool_strategy ();
  if (!strategy)
  {
    fprintf (stderr, "Failed to create memory pool strategy\n");
    return 1;
  }

  // Verify strategy is active
  if (strategy->get_status (strategy) != STRATEGY_STATE_ACTIVE)
  {
    fprintf (stderr, "Strategy initialization failed\n");
    destroy_pool_strategy (strategy);
    return 1;
  }

  printf ("Memory pool strategy initialized successfully\n");

  // Test allocation
  void *ptr = strategy->allocate (strategy, ALLOCATION_SIZE);
  if (!ptr)
  {
    fprintf (stderr, "Memory allocation failed\n");
    destroy_pool_strategy (strategy);
    return 1;
  }

  // Use the allocated memory
  memset (ptr, 0xAA, ALLOCATION_SIZE);
  printf ("Successfully allocated and wrote to %zu bytes\n",
	  (size_t) ALLOCATION_SIZE);

  // Multiple small allocations
  void *small_ptrs[5];
  for (int i = 0; i < 5; i++)
  {
    small_ptrs[i] = strategy->allocate (strategy, SMALL_ALLOC);
    if (!small_ptrs[i])
    {
      fprintf (stderr, "Small allocation %d failed\n", i);
      destroy_pool_strategy (strategy);
      return 1;
    }
    memset (small_ptrs[i], i, SMALL_ALLOC);
  }
  printf ("Successfully performed 5 small allocations\n");

  // Deallocate memory
  strategy->deallocate (strategy, ptr);
  for (int i = 0; i < 5; i++)
  {
    strategy->deallocate (strategy, small_ptrs[i]);
  }
  printf ("Successfully deallocated all memory\n");

  // Cleanup
  destroy_pool_strategy (strategy);
  printf ("Memory pool strategy destroyed successfully\n");

  return 0;
}
