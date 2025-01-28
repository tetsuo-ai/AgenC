# Compiler settings
CC = gcc
CFLAGS = -Wall -Wextra -Werror -std=c11 -I./include
LDFLAGS = -pthread

# Directories
SRC_DIR = src
INC_DIR = include
TEST_DIR = test
BUILD_DIR = build
LIB_DIR = lib

# Source files
SRC_FILES = $(wildcard $(SRC_DIR)/*.c)
OBJ_FILES = $(SRC_FILES:$(SRC_DIR)/%.c=$(BUILD_DIR)/%.o)

# Test files
TEST_FILES = $(wildcard $(TEST_DIR)/*.c)
TEST_BINS = $(TEST_FILES:$(TEST_DIR)/%.c=$(BUILD_DIR)/%)

# Output files
LIB_NAME = libmemstrategy.a
LIB_FILE = $(LIB_DIR)/$(LIB_NAME)
EXAMPLE_EXEC = example

# Targets
.PHONY: all clean test example

all: $(LIB_FILE) $(TEST_BINS) $(EXAMPLE_EXEC)

# Create required directories
$(BUILD_DIR) $(LIB_DIR):
	@mkdir -p $@

# Build library object files
$(BUILD_DIR)/%.o: $(SRC_DIR)/%.c | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c $< -o $@

# Build test executables
$(BUILD_DIR)/%: $(TEST_DIR)/%.c $(LIB_FILE) | $(BUILD_DIR)
	$(CC) $(CFLAGS) $< -L$(LIB_DIR) -lmemstrategy -o $@ $(LDFLAGS)

# Build library
$(LIB_FILE): $(OBJ_FILES) | $(LIB_DIR)
	ar rcs $@ $^

# Build example
$(EXAMPLE_EXEC): main.c $(LIB_FILE)
	$(CC) $(CFLAGS) -L$(LIB_DIR) $^ -o $@ $(LDFLAGS) -lmemstrategy

test: $(TEST_BINS)
	@echo "Running all tests..."
	@for test in $(TEST_BINS); do \
		echo "\nRunning $$test:"; \
		./$$test; \
		done

clean:
	rm -rf $(BUILD_DIR) $(LIB_DIR) $(EXAMPLE_EXEC) $(TEST_BINS)
