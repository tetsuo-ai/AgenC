#include "default_strategy.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <unistd.h>
#include <errno.h>
#include <memory_stats.h>

static bool
validate_pointer (const void *ptr)
{
  return ptr != NULL;
}

static bool
validate_size (size_t size)
{
  return size > 0 && size <= (SIZE_MAX / 4);
}

static bool
validate_strategy_base (MemoryStrategy *base)
{
  return validate_pointer (base) && validate_pointer (base->strategy_data);
}

static void
update_peak_usage (DefaultStrategy *strategy, size_t current_usage)
{
  if (!validate_pointer (strategy))
  {
    return;
  }

  atomic_thread_fence (memory_order_seq_cst);
  size_t old_peak
    = atomic_load_explicit (&strategy->peak_usage, memory_order_acquire);

  if (current_usage > old_peak)
  {
    atomic_compare_exchange_strong_explicit (&strategy->peak_usage, &old_peak,
					     current_usage,
					     memory_order_release,
					     memory_order_acquire);
  }
}

static bool
is_valid_allocation_size (size_t current_total, size_t new_size)
{
  if (!validate_size (new_size))
  {
    return false;
  }
  if (current_total > SIZE_MAX - new_size)
  {
    return false;
  }
  if (current_total + new_size > (SIZE_MAX / 4))
  {
    return false;
  }
  return true;
}

static bool
initialize_strategy_state (DefaultStrategy *strategy)
{
  atomic_init (&strategy->total_allocated, 0);
  atomic_init (&strategy->total_freed, 0);
  atomic_init (&strategy->peak_usage, 0);
  atomic_init (&strategy->usage_count, 0);
  atomic_init (&strategy->operation_count, 0);

  atomic_thread_fence (memory_order_seq_cst);

  return transition_status (&strategy->status_tracker, STRATEGY_STATE_ACTIVE)
	 == STRATEGY_SUCCESS;
}

static void
initialize_strategy_functions (DefaultStrategy *strategy)
{
  strategy->base.allocate = default_allocate;
  strategy->base.deallocate = default_deallocate;
  strategy->base.get_status = default_get_status;
  strategy->base.validate = default_validate;
  strategy->base.strategy_data = strategy;
}

static bool
initialize_memory_stats (DefaultStrategy *strategy)
{
  strategy->stats = (memory_stats_t *) calloc (1, sizeof (memory_stats_t));
  if (!validate_pointer (strategy->stats))
  {
    return false;
  }
  memory_stats_init (strategy->stats);
  return true;
}

static void
cleanup_memory_stats (DefaultStrategy *strategy)
{
  if (validate_pointer (strategy->stats))
  {
    memory_stats_reset (strategy->stats);
    free (strategy->stats);
    strategy->stats = NULL;
  }
}

static void
update_allocation_stats (DefaultStrategy *strategy, void *ptr, size_t size)
{
  memory_stats_update_allocation (strategy->stats, ptr, size, __FILE__,
				  __LINE__);
  atomic_thread_fence (memory_order_seq_cst);
  atomic_fetch_add_explicit (&strategy->total_allocated, size,
			     memory_order_release);
}

static void *
perform_allocation (DefaultStrategy *strategy, size_t size)
{
  // Initialize ptr to NULL before any operations
  void *ptr = malloc (size);

  // Handle allocation failure
  if (ptr == NULL)
  {
    if (errno == ENOMEM)
    {
      transition_status (&strategy->status_tracker, STRATEGY_STATE_ERROR);
    }
    return NULL;
  }

  // Update stats only if allocation succeeded
  update_allocation_stats (strategy, ptr, size);
  return ptr;
}

static bool
check_strategy_status (DefaultStrategy *strategy)
{
  StrategyStatus status;
  if (get_current_status (&strategy->status_tracker, &status)
	!= STRATEGY_SUCCESS
      || status != STRATEGY_STATE_ACTIVE)
  {
    return false;
  }
  return true;
}

static void
handle_deallocation (DefaultStrategy *strategy, void *ptr)
{
  size_t dealloc_size = 0;
  if (memory_stats_get_allocation_size (strategy->stats, ptr, &dealloc_size)
      == MEMORY_STATS_SUCCESS)
  {
    atomic_fetch_add_explicit (&strategy->total_freed, dealloc_size,
			       memory_order_release);
  }

  memory_stats_update_deallocation (strategy->stats, ptr);
  atomic_thread_fence (memory_order_seq_cst);

  free (ptr);
}

static void
check_and_report_leaks (DefaultStrategy *strategy)
{
  size_t total_alloc
    = atomic_load_explicit (&strategy->total_allocated, memory_order_acquire);
  size_t total_freed
    = atomic_load_explicit (&strategy->total_freed, memory_order_acquire);

  if (total_alloc > total_freed)
  {
    char *leak_report = memory_stats_check_leaks (strategy->stats);
    if (validate_pointer (leak_report))
    {
      fprintf (stderr, "Memory leaks detected during cleanup:\n%s\n",
	       leak_report);
      free (leak_report);
    }
  }
}

DefaultStrategy *
create_default_strategy (void)
{
  DefaultStrategy *strategy
    = (DefaultStrategy *) calloc (1, sizeof (DefaultStrategy));
  if (!validate_pointer (strategy))
  {
    return NULL;
  }

  if (!initialize_memory_stats (strategy))
  {
    free (strategy);
    return NULL;
  }

  initialize_strategy_functions (strategy);

  if (initialize_status (&strategy->status_tracker) != STRATEGY_SUCCESS)
  {
    cleanup_memory_stats (strategy);
    free (strategy);
    return NULL;
  }

  if (!initialize_strategy_state (strategy))
  {
    cleanup_memory_stats (strategy);
    free (strategy);
    return NULL;
  }

  return strategy;
}

void *
default_allocate (MemoryStrategy *base, size_t size)
{
  if (!validate_strategy_base (base))
  {
    return NULL;
  }

  DefaultStrategy *strategy = (DefaultStrategy *) base->strategy_data;
  atomic_fetch_add_explicit (&strategy->usage_count, 1, memory_order_acquire);
  atomic_thread_fence (memory_order_seq_cst);

  if (!check_strategy_status (strategy))
  {
    atomic_fetch_sub_explicit (&strategy->usage_count, 1, memory_order_release);
    return NULL;
  }

  size_t current_total
    = atomic_load_explicit (&strategy->total_allocated, memory_order_acquire)
      - atomic_load_explicit (&strategy->total_freed, memory_order_acquire);

  if (!is_valid_allocation_size (current_total, size))
  {
    atomic_fetch_sub_explicit (&strategy->usage_count, 1, memory_order_release);
    return NULL;
  }

  void *ptr = perform_allocation (strategy, size);
  if (ptr != NULL)
  {
    update_peak_usage (strategy, current_total + size);
  }

  atomic_thread_fence (memory_order_seq_cst);
  atomic_fetch_sub_explicit (&strategy->usage_count, 1, memory_order_release);

  return ptr;
}

void
default_deallocate (MemoryStrategy *base, void *ptr)
{
  if (!validate_strategy_base (base) || !validate_pointer (ptr))
  {
    return;
  }

  DefaultStrategy *strategy = (DefaultStrategy *) base->strategy_data;
  atomic_fetch_add_explicit (&strategy->usage_count, 1, memory_order_acquire);
  atomic_thread_fence (memory_order_seq_cst);

  StrategyStatus status;
  if (get_current_status (&strategy->status_tracker, &status)
	!= STRATEGY_SUCCESS
      || status == STRATEGY_STATE_ERROR)
  {
    atomic_fetch_sub_explicit (&strategy->usage_count, 1, memory_order_release);
    return;
  }

  handle_deallocation (strategy, ptr);

  atomic_thread_fence (memory_order_seq_cst);
  atomic_fetch_sub_explicit (&strategy->usage_count, 1, memory_order_release);
}

void
destroy_default_strategy (DefaultStrategy *strategy)
{
  if (!validate_pointer (strategy))
  {
    return;
  }

  transition_status (&strategy->status_tracker, STRATEGY_STATE_ERROR);
  atomic_thread_fence (memory_order_seq_cst);

  while (atomic_load_explicit (&strategy->usage_count, memory_order_acquire)
	 > 0)
  {
    usleep (1000);
  }

  check_and_report_leaks (strategy);
  cleanup_memory_stats (strategy);

  explicit_bzero (strategy, sizeof (DefaultStrategy));
  free (strategy);
}

StrategyStatus
default_get_status (MemoryStrategy *base)
{
  if (!validate_strategy_base (base))
  {
    return STRATEGY_STATE_ERROR;
  }

  DefaultStrategy *strategy = (DefaultStrategy *) base->strategy_data;
  StrategyStatus status;
  if (get_current_status (&strategy->status_tracker, &status)
      != STRATEGY_SUCCESS)
  {
    return STRATEGY_STATE_ERROR;
  }
  return status;
}

bool
default_validate (MemoryStrategy *base)
{
  if (!validate_strategy_base (base))
  {
    return false;
  }

  DefaultStrategy *strategy = (DefaultStrategy *) base->strategy_data;
  atomic_thread_fence (memory_order_acquire);

  StrategyStatus status;
  if (get_current_status (&strategy->status_tracker, &status)
      != STRATEGY_SUCCESS)
  {
    return false;
  }

  if (status != STRATEGY_STATE_ACTIVE && status != STRATEGY_STATE_INITIALIZED)
  {
    return false;
  }

  if (!validate_pointer (strategy->stats))
  {
    return false;
  }

  return strategy->base.allocate != NULL && strategy->base.deallocate != NULL
	 && strategy->base.get_status != NULL
	 && strategy->base.validate != NULL;
}

const char *
get_strategy_name (void)
{
  return "DefaultStrategy";
}

size_t
get_current_usage (const DefaultStrategy *strategy)
{
  if (!validate_pointer (strategy))
  {
    return 0;
  }

  atomic_thread_fence (memory_order_seq_cst);
  size_t allocated
    = atomic_load_explicit (&strategy->total_allocated, memory_order_acquire);
  size_t freed
    = atomic_load_explicit (&strategy->total_freed, memory_order_acquire);
  atomic_thread_fence (memory_order_seq_cst);

  return allocated > freed ? allocated - freed : 0;
}

size_t
get_peak_usage (const DefaultStrategy *strategy)
{
  if (!validate_pointer (strategy))
  {
    return 0;
  }
  return atomic_load_explicit (&strategy->peak_usage, memory_order_acquire);
}

size_t
get_total_allocated (const DefaultStrategy *strategy)
{
  if (!validate_pointer (strategy))
  {
    return 0;
  }
  return atomic_load_explicit (&strategy->total_allocated,
			       memory_order_acquire);
}

size_t
get_total_freed (const DefaultStrategy *strategy)
{
  if (!validate_pointer (strategy))
  {
    return 0;
  }
  return atomic_load_explicit (&strategy->total_freed, memory_order_acquire);
}
