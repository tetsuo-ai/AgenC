#include "strategy_validator.h"
#include "memory_strategy.h"
#include <stdint.h>
#include <stdbool.h>

// clang-format off
static bool validate_function_pointers(const MemoryStrategy* strategy);
static bool validate_state(const MemoryStrategy* strategy);
static bool validate_size(size_t size);
static bool validate_pointer(const void* ptr);
// clang-format on

static bool
validate_function_pointers (const MemoryStrategy *strategy)
{
  return strategy->allocate && strategy->deallocate && strategy->get_status
	 && strategy->validate;
}

static bool
validate_state (const MemoryStrategy *strategy)
{
  if (!strategy->status_tracker)
  {
    return false;
  }

  StrategyStatus current;
  if (get_current_status (strategy->status_tracker, &current)
      != STRATEGY_SUCCESS)
  {
    return false;
  }

  return current == STRATEGY_STATE_ACTIVE;
}

static bool
validate_size (size_t size)
{
  return size > 0 && size <= SIZE_MAX / 2;
}

static bool
validate_pointer (const void *ptr)
{
  return ptr != NULL && ((uintptr_t) ptr % sizeof (void *) == 0);
}

bool
validate_strategy (const MemoryStrategy *strategy)
{
  if (!strategy)
  {
    return false;
  }

  return validate_function_pointers (strategy) && validate_state (strategy);
}

bool
validate_allocation (const MemoryStrategy *strategy, size_t size)
{
  if (!strategy)
  {
    return false;
  }

  return validate_state (strategy) && validate_size (size);
}

bool
validate_deallocation (const MemoryStrategy *strategy, const void *ptr)
{
  if (!strategy)
  {
    return false;
  }

  return validate_state (strategy) && validate_pointer (ptr);
}
