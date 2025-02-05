/**
 * @file strategy_status.c
 * @brief Thread-safe state management system
 */

#include "../include/strategy_status.h"
#include <string.h>
#include <stddef.h>
#include <limits.h>

_Static_assert (STRATEGY_MAX_STATE == 3,
		"StrategyStatus enum has unexpected number of states");

/**
 * @brief State transition validation matrix
 * Each row represents the current state, each column represents the next state.
 * A value of 1 indicates a valid transition, 0 indicates invalid.
 * @security Matrix bounds are checked at runtime and compile time
 */
static const uint8_t VALID_TRANSITIONS[4][4] = {
  /*                    TO_STATE                        */
  /* FROM_STATE     INIT  ACTIVE  ERROR  TRANS         */
  /* INITIALIZED */ {0, 1, 1, 1},
  /* ACTIVE      */ {0, 0, 1, 1},
  /* ERROR       */ {1, 1, 0, 1},
  /* TRANS       */ {1, 1, 1, 0}};

_Static_assert (sizeof (VALID_TRANSITIONS) / sizeof (VALID_TRANSITIONS[0])
		  == STRATEGY_MAX_STATE + 1,
		"Transition matrix size mismatch");

/**
 * @brief Status string lookup table for thread-safe access
 * @note Array size is validated at compile time
 */
static const char *const STATUS_STRINGS[] = {
  "INITIALIZED", "ACTIVE", "ERROR", "TRANSITIONING",
  "UNKNOWN" /* Used for out-of-bounds status values */
};

_Static_assert (sizeof (STATUS_STRINGS) / sizeof (STATUS_STRINGS[0])
		  == STRATEGY_MAX_STATE + 2,
		"Status strings array size mismatch");

static StrategyResult
check_counter_overflow (const uint64_t current_value)
{
  return (current_value >= UINT64_MAX) ? STRATEGY_OVERFLOW : STRATEGY_SUCCESS;
}

static StrategyResult
perform_atomic_increment (volatile _Atomic (uint64_t) *const counter,
			  uint64_t old_value)
{
  bool success
    = atomic_compare_exchange_weak_explicit (counter, &old_value, old_value + 1,
					     memory_order_seq_cst,
					     memory_order_seq_cst);
  return success ? STRATEGY_SUCCESS : STRATEGY_ATOMIC_FAILURE;
}

static StrategyResult
atomic_increment_with_check (volatile _Atomic (uint64_t) *const counter)
{
  if (counter == NULL)
    return STRATEGY_NULL_POINTER;

  uint64_t old_count;
  bool counter_updated = false;

  for (int retry = 0; retry < STRATEGY_MAX_RETRIES && !counter_updated; retry++)
  {
    old_count = atomic_load_explicit (counter, memory_order_acquire);

    StrategyResult overflow_check = check_counter_overflow (old_count);
    if (overflow_check != STRATEGY_SUCCESS)
      return overflow_check;

    StrategyResult increment_result
      = perform_atomic_increment (counter, old_count);
    if (increment_result == STRATEGY_SUCCESS)
      counter_updated = true;
  }

  return counter_updated ? STRATEGY_SUCCESS : STRATEGY_ATOMIC_FAILURE;
}

static StrategyResult
validate_state_transition (const StrategyStatus current,
			   const StrategyStatus next)
{
  if (current > STRATEGY_MAX_STATE || next > STRATEGY_MAX_STATE)
    return STRATEGY_INVALID_STATE;

  return VALID_TRANSITIONS[current][next] ? STRATEGY_SUCCESS
					  : STRATEGY_INVALID_STATE;
}

static StrategyResult
perform_atomic_operation (volatile _Atomic (StrategyStatus) *const status,
			  StrategyStatus current_status,
			  const StrategyStatus new_status)
{
  bool success
    = atomic_compare_exchange_strong_explicit (status, &current_status,
					       new_status, memory_order_seq_cst,
					       memory_order_seq_cst);

  if (!atomic_is_lock_free (status))
    return STRATEGY_ATOMIC_FAILURE;

  return success ? STRATEGY_SUCCESS : STRATEGY_ATOMIC_FAILURE;
}

static StrategyResult
atomic_transition_status (volatile _Atomic (StrategyStatus) *const status,
			  const StrategyStatus new_status)
{
  if (status == NULL)
    return STRATEGY_NULL_POINTER;

  StrategyStatus current_status;
  bool success = false;

  for (int retry = 0; retry < STRATEGY_MAX_RETRIES && !success; retry++)
  {
    current_status = atomic_load_explicit (status, memory_order_acquire);

    StrategyResult validation_result
      = validate_state_transition (current_status, new_status);
    if (validation_result != STRATEGY_SUCCESS)
      return validation_result;

    StrategyResult operation_result
      = perform_atomic_operation (status, current_status, new_status);
    if (operation_result == STRATEGY_SUCCESS)
      success = true;
  }

  return success ? STRATEGY_SUCCESS : STRATEGY_ATOMIC_FAILURE;
}

/* Helper function prototypes */
static StrategyResult
validate_transition_input (const StatusTracker *tracker,
			   StrategyStatus new_status);
static StrategyResult
handle_state_transition (StatusTracker *tracker, StrategyStatus new_status);
static StrategyResult
update_transition_counters (StatusTracker *tracker, StrategyStatus new_status);

/* Input validation for transition */
static StrategyResult
validate_transition_input (const StatusTracker *tracker,
			   StrategyStatus new_status)
{
  if (tracker == NULL)
    return STRATEGY_NULL_POINTER;
  if (new_status > STRATEGY_MAX_STATE)
    return STRATEGY_INVALID_STATE;
  return STRATEGY_SUCCESS;
}

/* Handle the actual state transition */
static StrategyResult
handle_state_transition (StatusTracker *tracker, StrategyStatus new_status)
{
  atomic_thread_fence (memory_order_seq_cst);
  StrategyResult result
    = atomic_transition_status (&tracker->current_status, new_status);
  if (result != STRATEGY_SUCCESS)
    return result;
  return STRATEGY_SUCCESS;
}

/* Update transition and error counters */
static StrategyResult
update_transition_counters (StatusTracker *tracker, StrategyStatus new_status)
{
  StrategyResult result
    = atomic_increment_with_check (&tracker->transition_count);
  if (result != STRATEGY_SUCCESS)
    return result;

  if (new_status == STRATEGY_STATE_ERROR)
  {
    result = atomic_increment_with_check (&tracker->error_count);
    if (result != STRATEGY_SUCCESS)
      return result;
  }
  return STRATEGY_SUCCESS;
}

/* Main transition status function */
StrategyResult
transition_status (StatusTracker *const tracker,
		   const StrategyStatus new_status)
{
  StrategyResult result = validate_transition_input (tracker, new_status);
  if (result != STRATEGY_SUCCESS)
    return result;

  result = handle_state_transition (tracker, new_status);
  if (result != STRATEGY_SUCCESS)
    return result;

  result = update_transition_counters (tracker, new_status);
  if (result != STRATEGY_SUCCESS)
    return result;

  atomic_thread_fence (memory_order_seq_cst);
  return STRATEGY_SUCCESS;
}

StrategyResult
initialize_status (StatusTracker *const tracker)
{
  if (tracker == NULL)
    return STRATEGY_NULL_POINTER;

  atomic_thread_fence (memory_order_seq_cst);

  atomic_init (&tracker->current_status, STRATEGY_STATE_INITIALIZED);
  atomic_store_explicit (&tracker->transition_count, 0, memory_order_seq_cst);
  atomic_store_explicit (&tracker->error_count, 0, memory_order_seq_cst);

  atomic_thread_fence (memory_order_seq_cst);

  return STRATEGY_SUCCESS;
}

StrategyResult
get_current_status (const StatusTracker *const tracker,
		    StrategyStatus *const status)
{
  if (tracker == NULL || status == NULL)
    return STRATEGY_NULL_POINTER;

  atomic_thread_fence (memory_order_seq_cst);
  *status
    = atomic_load_explicit (&tracker->current_status, memory_order_acquire);
  return STRATEGY_SUCCESS;
}

StrategyResult
get_transition_count (const StatusTracker *const tracker, uint64_t *const count)
{
  if (tracker == NULL || count == NULL)
    return STRATEGY_NULL_POINTER;

  atomic_thread_fence (memory_order_acquire);
  *count
    = atomic_load_explicit (&tracker->transition_count, memory_order_acquire);
  return STRATEGY_SUCCESS;
}

StrategyResult
get_error_count (const StatusTracker *const tracker, uint64_t *const count)
{
  if (tracker == NULL || count == NULL)
  {
    return STRATEGY_NULL_POINTER;
  }

  atomic_thread_fence (memory_order_acquire);
  *count = atomic_load_explicit (&tracker->error_count, memory_order_acquire);
  return STRATEGY_SUCCESS;
}

bool
is_valid_state_transition (const StrategyStatus current,
			   const StrategyStatus next)
{
  return validate_state_transition (current, next) == STRATEGY_SUCCESS;
}

bool
is_error_state (const StrategyStatus status)
{
  return status <= STRATEGY_MAX_STATE && status == STRATEGY_STATE_ERROR;
}

bool
requires_state_recovery (const StrategyStatus status)
{
  if (status > STRATEGY_MAX_STATE)
    return false;
  return status == STRATEGY_STATE_ERROR
	 || status == STRATEGY_STATE_TRANSITIONING;
}

const char *
get_state_string (const StrategyStatus status)
{
  return (status <= STRATEGY_MAX_STATE)
	   ? STATUS_STRINGS[status]
	   : STATUS_STRINGS[STRATEGY_MAX_STATE + 1];
}
