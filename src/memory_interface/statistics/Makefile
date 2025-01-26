# Compiler and tools
CC := gcc
CFLAGS := -Wall -Wextra -Werror -pedantic -g
CPPFLAGS := -I./include
LDFLAGS := -pthread

# Build type specific flags
DEBUG_FLAGS := -g -DDEBUG -fsanitize=address
RELEASE_FLAGS := -O2 -DNDEBUG
COVERAGE_FLAGS := --coverage -fprofile-arcs -ftest-coverage

# Directories
SRC_DIR := src
TEST_DIR := tests
BUILD_DIR := build
COV_DIR := $(BUILD_DIR)/coverage

# Source files
LIB_SOURCES := $(wildcard $(SRC_DIR)/*.c)
LIB_OBJECTS := $(LIB_SOURCES:$(SRC_DIR)/%.c=$(BUILD_DIR)/%.o)
LIB_DEPS := $(LIB_OBJECTS:.o=.d)

TEST_SOURCES := $(wildcard $(TEST_DIR)/*.c)
TEST_BINS := $(TEST_SOURCES:$(TEST_DIR)/%.c=$(BUILD_DIR)/%)
TEST_OBJECTS := $(TEST_SOURCES:$(TEST_DIR)/%.c=$(BUILD_DIR)/%.o)
TEST_DEPS := $(TEST_OBJECTS:.o=.d)

# Add main program
MAIN_PROGRAM := $(BUILD_DIR)/memory_stats_example
MAIN_OBJECT := $(BUILD_DIR)/main.o

# Default target builds both tests and example
.PHONY: all
all: release example

# Build type targets
.PHONY: debug release coverage
debug: CFLAGS += $(DEBUG_FLAGS)
debug: LDFLAGS += -lasan # Added -lasan to link the ASAN library in debug mode
debug: dirs $(TEST_BINS)

release: CFLAGS += $(RELEASE_FLAGS)
release: dirs $(TEST_BINS)

coverage: CFLAGS += $(COVERAGE_FLAGS)
coverage: LDFLAGS += $(COVERAGE_FLAGS)
coverage: clean dirs $(TEST_BINS)
	@mkdir -p $(COV_DIR)
	@for test in $(TEST_BINS); do \
		./$$test || exit 1; \
	done
	gcov -o $(BUILD_DIR) $(LIB_SOURCES)
	mv *.gcov $(COV_DIR)/

# Create build directories
.PHONY: dirs
dirs:
	@mkdir -p $(BUILD_DIR)

# Dependency generation
$(BUILD_DIR)/%.d: $(SRC_DIR)/%.c
	@mkdir -p $(dir $@)
	@$(CC) $(CPPFLAGS) -MM -MT '$(BUILD_DIR)/$*.o' $< > $@

$(BUILD_DIR)/%.d: $(TEST_DIR)/%.c
	@mkdir -p $(dir $@)
	@$(CC) $(CPPFLAGS) -MM -MT '$(BUILD_DIR)/$*.o' $< > $@

# Compilation rules
$(BUILD_DIR)/%.o: $(SRC_DIR)/%.c
	@echo "Compiling $<..."
	@$(CC) $(CFLAGS) $(CPPFLAGS) -c $< -o $@

$(BUILD_DIR)/%.o: $(TEST_DIR)/%.c
	@echo "Compiling $<..."
	@$(CC) $(CFLAGS) $(CPPFLAGS) -c $< -o $@

# Build test executables
$(BUILD_DIR)/test_%: $(BUILD_DIR)/test_%.o $(LIB_OBJECTS)
	@echo "Linking $@..."
	@$(CC) $(CFLAGS) $^ $(LDFLAGS) -o $@

# Run all tests
.PHONY: test
test: debug
	@echo "Running all tests..."
	@for test in $(TEST_BINS); do \
		echo "\nRunning $$test:"; \
		./$$test || exit 1; \
	done

# Run specific test suites
.PHONY: test-memory-stats test-edge-cases test-stats-report
test-memory-stats: $(BUILD_DIR)/test_memory_stats
	@echo "Running memory stats tests..."
	./$(BUILD_DIR)/test_memory_stats

test-edge-cases: $(BUILD_DIR)/test_edge_cases
	@echo "Running edge cases tests..."
	./$(BUILD_DIR)/test_edge_cases

test-stats-report: $(BUILD_DIR)/test_stats_report
	@echo "Running stats report tests..."
	./$(BUILD_DIR)/test_stats_report

# Static analysis
.PHONY: analyze
analyze:
	@echo "Running static analysis..."
	cppcheck --enable=all --suppress=missingIncludeSystem $(SRC_DIR) $(TEST_DIR)

# Clean build artifacts
.PHONY: clean
clean:
	@echo "Cleaning build artifacts..."
	@rm -rf $(BUILD_DIR)
	@rm -f $(SRC_DIR)/*.gc* $(TEST_DIR)/*.gc*

# Build example program
.PHONY: example
example: CFLAGS += $(RELEASE_FLAGS)
example: $(MAIN_PROGRAM)

$(MAIN_PROGRAM): $(MAIN_OBJECT) $(LIB_OBJECTS)
	@echo "Building example program..."
	@$(CC) $(CFLAGS) $^ $(LDFLAGS) -o $@

$(MAIN_OBJECT): main.c
	@echo "Compiling main.c..."
	@mkdir -p $(BUILD_DIR)
	@$(CC) $(CFLAGS) $(CPPFLAGS) -c $< -o $@

# Show help
.PHONY: help
help:
	@echo "Available targets:"
	@echo "  all            - Build tests and example program"
	@echo "  debug          - Build with debug symbols and sanitizers"
	@echo "  release        - Build with optimizations"
	@echo "  coverage       - Build and run tests with coverage analysis"
	@echo "  test           - Build and run all tests"
	@echo "  test-memory-stats  - Run memory stats tests only"
	@echo "  test-edge-cases    - Run edge case tests only"
	@echo "  test-stats-report  - Run stats report tests only"
	@echo "  analyze        - Run static code analysis"
	@echo "  example        - Build the example program"
	@echo "  clean          - Remove build artifacts"
	@echo "  help           - Show this help message"

# Include generated dependencies
-include $(LIB_DEPS) $(TEST_DEPS)
