# Statistics Tracking System

C library for tracking memory allocations, detecting memory leaks, and analyzing memory usage patterns in multi-threaded applications.

## Features

- Thread-safe memory allocation tracking
- Detailed memory usage statistics
- Memory leak detection with source location tracking
- Memory allocation pattern analysis
- Atomic operations for concurrent access
- Configurable size distribution buckets
- Comprehensive test coverage

## Installation

```bash
# Build the release version (recommended for production use)
make release

# Build with debug symbols and sanitizers (for development)
make debug

# Build example program
make example

# Run all tests
make test
```

## Usage

### Basic Example

```c
#include "memory_stats.h"

int main() {
    // Initialize stats tracking
    memory_stats_t stats;
    memory_stats_init(&stats);

    // Track allocations
    void* ptr = malloc(1024);
    memory_stats_update_allocation(&stats, ptr, 1024, __FILE__, __LINE__);

    // Get current statistics
    stats_report_t report;
    memory_stats_get_report(&stats, &report);
    printf("Current memory usage: %zu bytes\n", report.current_bytes);

    // Track deallocations
    memory_stats_update_deallocation(&stats, ptr);
    free(ptr);

    return 0;
}
```

### Pattern Analysis

```c
// Analyze allocation patterns
char* analysis = memory_stats_analyze_patterns(&stats);
printf("%s\n", analysis);
free(analysis);
```

Example output:
```
Memory Allocation Pattern Analysis:
================================
Average Allocation Size: 256.43 bytes
Allocation Frequency: 1000/sec

Size Distribution:
  ≤ 32 bytes:    1500 allocations
  ≤ 64 bytes:    800 allocations
  ≤ 128 bytes:   400 allocations
  ≤ 256 bytes:   200 allocations
  ≤ 512 bytes:   100 allocations
  ≤ 1024 bytes:  50 allocations
  ≤ 4096 bytes:  25 allocations
  > 4096 bytes:  10 allocations
```

### Leak Detection

```c
// Check for memory leaks
char* leak_report = memory_stats_check_leaks(&stats);
printf("%s\n", leak_report);
free(leak_report);
```

Example output:
```
Memory Leak Analysis:
===================
Active Allocations: 2
Total Leaked Bytes: 384

Detected Leaks:
  Leak #1:
    Address: 0x7f9348000b70
    Size: 128 bytes
    Location: main.c:56
    Time: 1706198400

  Leak #2:
    Address: 0x7f9348001c80
    Size: 256 bytes
    Location: main.c:57
    Time: 1706198410
```

## Building and Testing

```bash
# Build debug version (with sanitizers)
make debug

# Build release version
make release

# Build example program
make example

# Run specific test suites
make test-memory-stats
make test-edge-cases
make test-stats-report

# Generate code coverage report
make coverage

# Run static analysis
make analyze

# Clean build artifacts
make clean
```

## Thread Safety

The library uses several techniques to ensure thread safety:

1. Atomic Operations
   - All counters use atomic types
   - Updates are performed using atomic operations
   - Memory ordering is carefully controlled

2. Lock-free Algorithms
   - No mutexes or locks are used
   - Compare-and-swap operations for updates
   - Wait-free progress for basic operations

3. Contention Management
   - Exponential backoff for high contention
   - Randomized jitter to prevent thundering herd
   - Multiple retry attempts with backoff

4. Memory Ordering
   - Acquire/Release semantics for consistency
   - Full memory barriers at critical points
   - Proper synchronization of shared data

## API Reference

### Core Functions

- `void memory_stats_init(memory_stats_t* stats)`
  - Initializes the memory statistics tracking system
  - Must be called before any other operations

- `void memory_stats_update_allocation(memory_stats_t* stats, void* ptr, size_t size, const char* file, int line)`
  - Records a new memory allocation
  - Thread-safe: Yes

- `void memory_stats_update_deallocation(memory_stats_t* stats, void* ptr)`
  - Records a memory deallocation
  - Thread-safe: Yes

- `void memory_stats_get_report(const memory_stats_t* stats, stats_report_t* report)`
  - Generates a snapshot of current memory statistics
  - Thread-safe: Yes

### Analysis Functions

- `char* memory_stats_analyze_patterns(const memory_stats_t* stats)`
  - Analyzes memory allocation patterns
  - Returns allocated string (caller must free)
  - Thread-safe: Yes

- `char* memory_stats_check_leaks(const memory_stats_t* stats)`
  - Generates a report of memory leaks
  - Returns allocated string (caller must free)
  - Thread-safe: Yes
