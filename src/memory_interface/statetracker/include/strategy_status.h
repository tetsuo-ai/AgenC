/**
 * @file strategy_status.h
 * @brief Thread-safe state management system for memory allocation strategies
 */

#ifndef MEMORY_STRATEGY_STATUS_H_
#define MEMORY_STRATEGY_STATUS_H_

#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>

/* Configuration Constants */
/**
 * @brief System configuration constants
 */
#define STRATEGY_MAX_RETRIES 3
#define STRATEGY_ERROR_STRING "ERROR"

/* Error Codes */
/**
 * @brief Operation result codes
 */
typedef enum
{
  STRATEGY_SUCCESS = 0,	       /**< Operation completed successfully */
  STRATEGY_NULL_POINTER = -1,  /**< Null pointer provided */
  STRATEGY_INVALID_STATE = -2, /**< Invalid state requested */
  STRATEGY_OVERFLOW = -3,      /**< Counter overflow detected */
  STRATEGY_ATOMIC_FAILURE = -4 /**< Atomic operation failed */
} StrategyResult;

/* State Definitions */
/**
 * @brief Memory allocation strategy states
 * @security All transitions between states are validated at compile time and
 * runtime
 */
typedef enum
{
  STRATEGY_STATE_INITIALIZED = 0, /**< Initial state after creation */
  STRATEGY_STATE_ACTIVE,	  /**< Normal operating state */
  STRATEGY_STATE_ERROR,		  /**< Error condition detected */
  STRATEGY_STATE_TRANSITIONING,	  /**< Temporarily between states */
  STRATEGY_MAX_STATE = STRATEGY_STATE_TRANSITIONING /**< Bound checking value */
} StrategyStatus;

/**
 * @brief Thread-safe status tracking structure
 * @security All members are protected by atomic operations with sequential
 * consistency
 */
typedef struct
{
  volatile _Atomic (StrategyStatus)
    current_status; /**< Current state (atomic for thread safety) */
  volatile _Atomic (uint64_t)
    transition_count;			   /**< Number of state transitions */
  volatile _Atomic (uint64_t) error_count; /**< Number of errors encountered */
} StatusTracker;

/* Core Functions */
/**
 * @brief Initialize a new status tracker
 * @param tracker Pointer to the StatusTracker to initialize
 * @return StrategyResult indicating success or failure
 * @security Thread-safe, NULL-pointer protected, sequential consistency
 */
StrategyResult
initialize_status (StatusTracker *const tracker);

/**
 * @brief Attempt to transition to a new state
 * @param tracker Pointer to the StatusTracker
 * @param new_status The target state
 * @return StrategyResult indicating success or failure
 * @security Thread-safe, bounds-checked, overflow-protected
 */
StrategyResult
transition_status (StatusTracker *const tracker,
		   const StrategyStatus new_status);

/* Status Query Functions */
/**
 * @brief Get the current status
 * @param tracker Pointer to the StatusTracker
 * @param[out] status Pointer to store the current status
 * @return StrategyResult indicating success or failure
 * @security Thread-safe, const-correct
 */
StrategyResult
get_current_status (const StatusTracker *const tracker,
		    StrategyStatus *const status);

/**
 * @brief Get the number of state transitions
 * @param tracker Pointer to the StatusTracker
 * @param[out] count Pointer to store the transition count
 * @return StrategyResult indicating success or failure
 * @security Thread-safe, overflow-protected
 */
StrategyResult
get_transition_count (const StatusTracker *const tracker,
		      uint64_t *const count);

/**
 * @brief Get the number of errors encountered
 * @param tracker Pointer to the StatusTracker
 * @param[out] count Pointer to store the error count
 * @return StrategyResult indicating success or failure
 * @security Thread-safe, overflow-protected
 */
StrategyResult
get_error_count (const StatusTracker *const tracker, uint64_t *const count);

/* State Validation Functions */
/**
 * @brief Check if a state transition is valid
 * @param current Current state
 * @param next Proposed next state
 * @return true if transition is valid, false otherwise
 * @security Const function, bounds-checked
 */
bool
is_valid_state_transition (const StrategyStatus current,
			   const StrategyStatus next);

/**
 * @brief Check if a state is an error state
 * @param status State to check
 * @return true if state is an error state, false otherwise
 * @security Const function, bounds-checked
 */
bool
is_error_state (const StrategyStatus status);

/**
 * @brief Check if a state requires recovery action
 * @param status State to check
 * @return true if state requires recovery, false otherwise
 * @security Const function, bounds-checked
 */
bool
requires_state_recovery (const StrategyStatus status);

/**
 * @brief Get string representation of a status
 * @param status State to convert to string
 * @return Constant string representing the status
 * @security Const function, bounds-checked
 */
const char *
get_state_string (const StrategyStatus status);

#endif /* MEMORY_STRATEGY_STATUS_H_ */
