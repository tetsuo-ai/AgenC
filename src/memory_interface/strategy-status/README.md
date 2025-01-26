# Thread-Safe State Management System

A thread-safe state management system for memory allocation strategies in C. This library provides atomic operations and memory barriers to ensure thread safety while managing state transitions.

This state management system helps control how a program moves between different states (like "initialized", "active", "error") in a safe way, especially when multiple parts of the program are running at the same time.

## Features

- Thread-safe state transitions with atomic operations
- Overflow protection for counters
- Memory barrier enforcement
- Compile-time bounds checking
- Comprehensive error handling
- Lock-free operations
- Built-in state validation

## Prerequisites

- GCC compiler (supporting C11 or later)
- POSIX-compliant system (Linux/Unix)
- pthread library
- Make build system

## Building

```bash
# Build everything (library, tests, and examples)
make clean && make all

# Run tests
make test

# Run example
make example
```

## API Reference

### Core Functions

#### Initialize Status Tracker
```c
StrategyResult initialize_status(StatusTracker* const tracker);
```
Initializes a new status tracker with default state STRATEGY_STATE_INITIALIZED.

#### Transition State
```c
StrategyResult transition_status(StatusTracker* const tracker, const StrategyStatus new_status);
```
Safely transitions the tracker to a new state if the transition is valid.

### Query Functions

#### Get Current Status
```c
StrategyResult get_current_status(const StatusTracker* const tracker, StrategyStatus* const status);
```
Retrieves the current state of the tracker.

#### Get Transition Count
```c
StrategyResult get_transition_count(const StatusTracker* const tracker, uint64_t* const count);
```
Returns the total number of successful state transitions.

#### Get Error Count
```c
StrategyResult get_error_count(const StatusTracker* const tracker, uint64_t* const count);
```
Returns the total number of errors encountered.

### State Validation

#### Check Valid Transition
```c
bool is_valid_state_transition(const StrategyStatus current, const StrategyStatus next);
```
Checks if a transition between states is valid.

#### Check Error State
```c
bool is_error_state(const StrategyStatus status);
```
Determines if a state is an error state.

#### Check Recovery Required
```c
bool requires_state_recovery(const StrategyStatus status);
```
Checks if a state requires recovery action.

### State String Representation
```c
const char* get_state_string(const StrategyStatus status);
```
Returns a string representation of a state.

## Example Usage

Here's a basic example of using the library:

```c
#include <stdio.h>
#include "strategy_status.h"

int main(void) 
{
    StatusTracker tracker;

    // Initialize tracker
    if (initialize_status(&tracker) != STRATEGY_SUCCESS) {
        fprintf(stderr, "Failed to initialize tracker\n");
        return 1;
    }

    // Transition to active state
    if (transition_status(&tracker, STRATEGY_STATE_ACTIVE) != STRATEGY_SUCCESS) {
        fprintf(stderr, "Failed to transition to active state\n");
        return 1;
    }

    // Get current status
    StrategyStatus current;
    if (get_current_status(&tracker, &current) == STRATEGY_SUCCESS) {
        printf("Current status: %s\n", get_state_string(current));
    }

    return 0;
}
```

See `examples/main.c` for a complete example including thread safety and error handling.

## Thread Safety Considerations

- All operations are atomic and thread-safe
- Memory barriers ensure proper synchronization
- Lock-free design prevents deadlocks
- Overflow protection for all counters
- Race condition prevention through memory ordering

### Performance Characteristics

- Lock-free operations minimize contention
- Atomic operations use hardware-level synchronization
- Minimal memory footprint
- Constant-time state transitions
- Linear scaling with number of threads

## Error Handling

The library returns `StrategyResult` for all operations:

- `STRATEGY_SUCCESS`: Operation completed successfully
- `STRATEGY_NULL_POINTER`: Null pointer provided
- `STRATEGY_INVALID_STATE`: Invalid state requested
- `STRATEGY_OVERFLOW`: Counter overflow detected
- `STRATEGY_ATOMIC_FAILURE`: Atomic operation failed

### Error Recovery Pattern

```c
if (transition_status(&tracker, STRATEGY_STATE_ERROR) == STRATEGY_SUCCESS) {
    // Handle error state
    if (requires_state_recovery(STRATEGY_STATE_ERROR)) {
        // Perform recovery actions
        transition_status(&tracker, STRATEGY_STATE_INITIALIZED);
    }
}
```

## Troubleshooting

### Common Issues and Solutions

1. Runtime Errors
   - Check for null pointer dereferences
   - Verify state transitions are valid
   - Monitor overflow conditions in counters

2. Performance Issues
   - Reduce contention by minimizing transitions
   - Use appropriate memory ordering semantics
   - Monitor error counts for excessive failures

## Security

- All operations are bounds-checked
- Memory barriers prevent reordering exploits
- Overflow protection prevents counter attacks
- Atomic operations prevent race conditions
- Constant-time operations prevent timing attacks

