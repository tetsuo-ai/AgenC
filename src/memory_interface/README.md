# Thread-Safe Memory Management System

A high-performance, thread-safe memory management system designed for concurrent applications that require precise memory tracking, leak detection, and usage statistics. This system provides a robust implementation of memory management strategies with comprehensive monitoring capabilities.

## Key Features

- Thread-safe memory operations with atomic guarantees
- Real-time memory usage tracking and statistics
- Automatic leak detection and reporting
- Peak memory usage monitoring
- Comprehensive error handling and validation
- Performance overhead less than 5% compared to raw malloc/free
- Support for concurrent operations across multiple threads
- Status tracking and state management
- Memory operation debugging capabilities

## Installation

### Prerequisites

The system requires the following libraries:
- libmemstats
- libmemstrategy
- libstatetracker

### Build System

The project uses a Makefile-based build system with several targets:

#### Building the Static Library

```bash
make lib
```

This command:
1. Creates necessary directories (`lib/`, `build/obj/`)
2. Builds all required dependencies
3. Compiles the default strategy implementation
4. Creates `lib/libdefault_strategy.a`
5. Copies header files to `lib/`

#### Library Output

The `lib/` directory will contain:
- `libdefault_strategy.a` - The static library
- All necessary header files

#### Using the Library

To link against the built library:

```bash
gcc your_program.c -L./lib -ldefault_strategy \
    -L./library -lmemstats -lmemstrategy -lstatetracker
```

#### Additional Make Targets

- `make` - Builds everything (library, tests, main program)
- `make test` - Builds and prepares tests
- `make check` - Runs the test suite
- `make clean` - Removes all built files

### Build Configuration

Include the following directories in your build path:
```bash
- ./memstats/include
- ./memstrategy/include
- ./statetracker/include
- ./src
```

### Compilation

Build with threading support enabled:

```bash
gcc -pthread \
    -I./src \
    -I./memstats/include \
    -I./memstrategy/include \
    -I./statetracker/include \
    your_program.c src/default_strategy.c \
    -L./memstats/lib \
    -L./memstrategy/lib \
    -L./statetracker/lib \
    -lmemstats -lmemstrategy -lstatetracker
```

## API Reference

### Core Functions

#### Strategy Creation and Destruction

```c
DefaultStrategy* create_default_strategy(void);
void destroy_default_strategy(DefaultStrategy* strategy);
```

#### Memory Operations

```c
void* default_allocate(MemoryStrategy* base, size_t size);
void default_deallocate(MemoryStrategy* base, void* ptr);
```

#### Status and Validation

```c
StrategyStatus default_get_status(MemoryStrategy* base);
bool default_validate(MemoryStrategy* base);
```

#### Usage Statistics

```c
size_t get_current_usage(const DefaultStrategy* strategy);
size_t get_peak_usage(const DefaultStrategy* strategy);
size_t get_total_allocated(const DefaultStrategy* strategy);
size_t get_total_freed(const DefaultStrategy* strategy);
```

### Basic Usage Example

```c
#include "default_strategy.h"

int main() 
{
    // Create strategy instance
    DefaultStrategy* strategy = create_default_strategy();
    if (!strategy) {
        return 1;
    }

    // Allocate memory
    void* memory = strategy->base.allocate(&strategy->base, 1024);
    if (!memory) {
        destroy_default_strategy(strategy);
        return 1;
    }

    // Use memory...

    // Deallocate memory
    strategy->base.deallocate(&strategy->base, memory);

    // Check for leaks and cleanup
    destroy_default_strategy(strategy);
    return 0;
}
```

### Thread-Safe Usage Example

```c
void* thread_function(void* arg) 
{
    DefaultStrategy* strategy = (DefaultStrategy*)arg;
    
    // Thread-safe memory operations
    void* memory = strategy->base.allocate(&strategy->base, 1024);
    if (memory) {
        // Use memory...
        strategy->base.deallocate(&strategy->base, memory);
    }
    
    return NULL;
}

// Create multiple threads
pthread_t threads[4];
for (int i = 0; i < 4; i++) {
    pthread_create(&threads[i], NULL, thread_function, strategy);
}
```

## Memory Statistics and Monitoring

The system provides comprehensive memory usage statistics:

```c
DefaultStrategy* strategy = create_default_strategy();

// Get current memory usage
size_t current = get_current_usage(strategy);

// Get peak memory usage
size_t peak = get_peak_usage(strategy);

// Get total allocation statistics
size_t total_alloc = get_total_allocated(strategy);
size_t total_freed = get_total_freed(strategy);
```

## Error Handling

The system includes robust error handling:

- Null pointer validation
- Size validation
- Thread safety violations detection
- Memory exhaustion handling
- Status tracking and state transitions
- Automatic leak detection during cleanup

## Thread Safety Guarantees

The implementation ensures thread safety through:

- Atomic operations for all counters
- Memory barriers for proper synchronization
- Thread-safe status management
- Safe state transitions
- Protection against concurrent access issues

## Best Practices

1. Always initialize the strategy using `create_default_strategy()`
2. Check return values from allocation operations
3. Properly deallocate all memory before strategy destruction
4. Monitor memory usage using the provided statistics functions
5. Implement appropriate error handling
6. Use the validation interface before critical operations
7. Clean up resources with `destroy_default_strategy()`

## Performance Considerations

- Less than 5% overhead compared to raw malloc/free
- Atomic operations used judiciously to minimize contention
- Efficient thread-local storage where appropriate
- Optimized status tracking and state transitions
- Minimal lock contention in concurrent scenarios

## Debugging

The system provides several debugging capabilities:

- Detailed memory statistics
- Leak detection and reporting
- Operation counting for tracking
- Status monitoring
- Comprehensive validation checks

## Limitations

- Not intended for use in signal handlers or interrupt contexts
- Maximum allocation size limited to SIZE_MAX/4
- Requires proper cleanup to prevent resource leaks
- Thread safety adds minimal performance overhead