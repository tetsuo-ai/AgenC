# Thread-Safe Memory Management Strategy

A robust memory management system providing a flexible interface for implementing custom allocation strategies with comprehensive validation.

## Core Components

### Memory Strategy Interface (`MemoryStrategy`)

The core interface that all memory management strategies must implement:

```c
typedef struct MemoryStrategy {
    void* (*allocate)(struct MemoryStrategy* self, size_t size);
    void (*deallocate)(struct MemoryStrategy* self, void* ptr);
    StrategyStatus (*get_status)(struct MemoryStrategy* self);
    bool (*validate)(struct MemoryStrategy* self);
    void* strategy_data;           // Implementation-specific data
    StatusTracker* status_tracker; // Thread-safe status tracking
} MemoryStrategy;
```

Core Operations:
- `allocate`: Thread-safe memory allocation
- `deallocate`: Thread-safe memory deallocation
- `get_status`: Check strategy health
- `validate`: Verify strategy state

### Strategy Validator

Independent validation system for memory operations:

```c
// Validate strategy state and interface compliance
bool validate_strategy(const MemoryStrategy* strategy);

// Validate allocation parameters
bool validate_allocation(const MemoryStrategy* strategy, size_t size);

// Validate deallocation parameters
bool validate_deallocation(const MemoryStrategy* strategy, const void* ptr);
```

### Thread Safety

All core operations are designed to be thread-safe:
- Atomic status transitions
- Re-entrant validation operations
- Proper memory barriers
- Lock-free operations

## Example Implementation

A reference memory pool implementation is provided as an example of how to implement the interface. This is NOT part of the core API and should be treated as a reference only.

Find it in the `memory_pool_strategy.h/.c` files.

## Usage Example

```c
int main(void) {
    // Initialize your strategy implementation
    MemoryStrategy* strategy = initialize_your_strategy();
    if (!strategy) {
        fprintf(stderr, "Failed to initialize strategy\n");
        return 1;
    }

    // Verify strategy is valid
    if (!strategy->validate(strategy)) {
        fprintf(stderr, "Strategy validation failed\n");
        cleanup_your_strategy(strategy);
        return 1;
    }

    // Allocate memory
    void* ptr = strategy->allocate(strategy, 1024);
    if (!ptr) {
        fprintf(stderr, "Allocation failed\n");
        cleanup_your_strategy(strategy);
        return 1;
    }

    // Use the memory...

    // Free the memory
    strategy->deallocate(strategy, ptr);

    // Clean up
    cleanup_your_strategy(strategy);
    return 0;
}
```

## Thread-Safe Usage Example

```c
void* worker_thread(void* arg) {
    MemoryStrategy* strategy = (MemoryStrategy*)arg;

    // Always validate before use
    if (!validate_strategy(strategy)) {
        return NULL;
    }

    // Thread-safe operations
    void* ptr = strategy->allocate(strategy, 1024);
    if (ptr && validate_deallocation(strategy, ptr)) {
        // Use memory...
        strategy->deallocate(strategy, ptr);
    }
    return NULL;
}

int main(void) {
    MemoryStrategy* strategy = initialize_your_strategy();

    pthread_t thread1, thread2;
    pthread_create(&thread1, NULL, worker_thread, strategy);
    pthread_create(&thread2, NULL, worker_thread, strategy);

    pthread_join(thread1, NULL);
    pthread_join(thread2, NULL);

    cleanup_your_strategy(strategy);
    return 0;
}
```

## Building

```bash
make clean && make all  # Build library and tests
make test              # Run tests
make example           # Build example program
```
