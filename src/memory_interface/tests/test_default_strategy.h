#ifndef TEST_DEFAULT_STRATEGY_H
#define TEST_DEFAULT_STRATEGY_H

#include <stdbool.h>

// clang-format off
// Standard test suite functions
bool test_strategy_creation(void);
bool test_basic_allocation(void);
bool test_concurrent_allocations(void);
bool test_error_handling(void);
bool test_memory_tracking(void);
bool test_status_transitions(void);
bool test_validation(void);
bool test_peak_usage(void);

// Fuzzing test functions
void test_allocation_pattern_fuzzing(void);
void test_edge_case_fuzzing(void);
void run_fuzz_tests(void);

// Test runners
int run_default_strategy_tests(void);
int run_all_tests(void);
// clang-format on

#endif // TEST_DEFAULT_STRATEGY_H
