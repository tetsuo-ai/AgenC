/**
 * @file strategy_validator.h
 * @brief Validation system for memory management strategies
 */

#ifndef MEMORY_STRATEGY_VALIDATOR_H_
#define MEMORY_STRATEGY_VALIDATOR_H_

#include <stdbool.h>
#include <stddef.h>

struct MemoryStrategy;

/**
 * @brief Validates strategy health and contract compliance
 * @param strategy Pointer to memory strategy
 * @return true if strategy is valid and follows interface contract
 */
bool
validate_strategy (const struct MemoryStrategy *strategy);

/**
 * @brief Validates allocation request parameters
 * @param strategy Pointer to memory strategy
 * @param size Requested allocation size
 * @return true if allocation request is valid
 */
bool
validate_allocation (const struct MemoryStrategy *strategy, size_t size);

/**
 * @brief Validates deallocation request parameters
 * @param strategy Pointer to memory strategy
 * @param ptr Pointer to memory for deallocation
 * @return true if deallocation request is valid
 */
bool
validate_deallocation (const struct MemoryStrategy *strategy, const void *ptr);

#endif /* MEMORY_STRATEGY_VALIDATOR_H_ */
