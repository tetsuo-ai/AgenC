#include "memory_strategy.h"
#include "strategy_validator.h"
#include <stdlib.h>
#include <string.h>

static void *
default_allocate (MemoryStrategy *self, size_t size);
static void
default_deallocate (MemoryStrategy *self, void *ptr);
static StrategyStatus
default_get_status (MemoryStrategy *self);
static bool
default_validate (MemoryStrategy *self);

static void *
default_allocate (MemoryStrategy *self, size_t size)
{
  if (!validate_allocation (self, size))
  {
    transition_status (self->status_tracker, STRATEGY_STATE_ERROR);
    return NULL;
  }

  void *ptr = malloc (size);
  if (!ptr)
  {
    transition_status (self->status_tracker, STRATEGY_STATE_ERROR);
  }
  return ptr;
}

static void
default_deallocate (MemoryStrategy *self, void *ptr)
{
  if (!validate_deallocation (self, ptr))
  {
    transition_status (self->status_tracker, STRATEGY_STATE_ERROR);
    return;
  }
  free (ptr);
}

static StrategyStatus
default_get_status (MemoryStrategy *self)
{
  StrategyStatus status;
  if (!self || !self->status_tracker
      || get_current_status (self->status_tracker, &status) != STRATEGY_SUCCESS)
  {
    return STRATEGY_STATE_ERROR;
  }
  return status;
}

static bool
default_validate (MemoryStrategy *self)
{
  return validate_strategy (self);
}

bool
initialize_strategy (MemoryStrategy *strategy)
{
  if (!strategy)
  {
    return false;
  }

  strategy->status_tracker = malloc (sizeof (StatusTracker));
  if (!strategy->status_tracker)
  {
    return false;
  }

  if (initialize_status (strategy->status_tracker) != STRATEGY_SUCCESS)
  {
    free (strategy->status_tracker);
    return false;
  }

  strategy->allocate = default_allocate;
  strategy->deallocate = default_deallocate;
  strategy->get_status = default_get_status;
  strategy->validate = default_validate;
  strategy->strategy_data = NULL;

  if (transition_status (strategy->status_tracker, STRATEGY_STATE_ACTIVE)
      != STRATEGY_SUCCESS)
  {
    free (strategy->status_tracker);
    return false;
  }

  return true;
}

void
cleanup_strategy (MemoryStrategy *strategy)
{
  if (!strategy)
  {
    return;
  }

  if (strategy->status_tracker)
  {
    free (strategy->status_tracker);
  }

  if (strategy->strategy_data)
  {
    free (strategy->strategy_data);
  }

  memset (strategy, 0, sizeof (MemoryStrategy));
}
