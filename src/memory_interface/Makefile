# Top-level Makefile for building and organizing libraries

# Compiler and flags
CC := gcc
CFLAGS := -Wall -Wextra -pthread -fPIC
LDFLAGS := -pthread
INCLUDE_DIR := $(LIBRARY_DIR)
LIB_FLAGS := -lmemstats -lmemstrategy -lstatetracker

# Directories
MODULES := memstats memstrategy statetracker
LIBRARY_DIR := library
BUILD_DIR := build
TEST_DIR := tests
SRC_DIR := src

# Source files (move these up before they're used)
SRC_FILES := $(wildcard $(SRC_DIR)/*.c)
TEST_SRCS := $(wildcard $(TEST_DIR)/*.c)

# Additional directories and variables
LIB_DIR := lib
OBJ_DIR := $(BUILD_DIR)/obj
LIBRARY_NAME := libdefault_strategy.a
LIBRARY_OUTPUT := $(LIB_DIR)/$(LIBRARY_NAME)
OBJECTS := $(patsubst $(SRC_DIR)/%.c,$(OBJ_DIR)/%.o,$(SRC_FILES))

# Output files
TEST_RUNNER := $(BUILD_DIR)/test_runner

# Add main executable variables (updated path)
MAIN_SRC := main.c
MAIN_OBJ := $(OBJ_DIR)/main.o
MAIN_EXE := $(BUILD_DIR)/memory_interface

# Phony targets
.PHONY: all clean install $(MODULES) test check lib main

# Default target
all: install test main

# Create necessary directories (updated)
$(BUILD_DIR) $(LIBRARY_DIR) $(LIB_DIR) $(OBJ_DIR):
	mkdir -p $@

# Install target - creates library directory and builds all modules
install: $(LIBRARY_DIR) $(MODULES)
	cp memstats/lib/*.a memstats/lib/*.h $(LIBRARY_DIR)/
	cp memstrategy/lib/*.a memstrategy/lib/*.h $(LIBRARY_DIR)/
	cp statetracker/lib/*.a statetracker/lib/*.h $(LIBRARY_DIR)/

# Module targets
$(MODULES):
	$(MAKE) -C $@ install

# Clean target
clean:
	rm -rf $(LIBRARY_DIR) $(BUILD_DIR)
	for dir in $(MODULES); do \
		$(MAKE) -C $$dir clean; \
	done

# Object file compilation - fixed include paths
$(OBJ_DIR)/%.o: $(SRC_DIR)/%.c | $(OBJ_DIR)
	$(CC) $(CFLAGS) -I$(LIBRARY_DIR) -I$(SRC_DIR) -c $< -o $@

# Library target (updated)
.PHONY: lib
lib: install $(OBJECTS)
	mkdir -p $(LIB_DIR)
	ar rcs $(LIBRARY_OUTPUT) $(OBJECTS)
	cp $(SRC_DIR)/*.h $(LIB_DIR)/

# Build the default strategy test
test: $(BUILD_DIR) install
	$(CC) $(CFLAGS) \
		-I$(LIBRARY_DIR) \
		-I$(INCLUDE_DIR) \
		-I$(SRC_DIR) \
		$(SRC_FILES) \
		$(TEST_SRCS) \
		-L$(LIBRARY_DIR) \
		$(LIB_FLAGS) \
		-o $(TEST_RUNNER)

# Add main target
main: $(MAIN_EXE)

$(MAIN_EXE): $(MAIN_OBJ) lib
	$(CC) $(CFLAGS) -o $@ $(MAIN_OBJ) \
		-L$(LIB_DIR) -ldefault_strategy \
		-L$(LIBRARY_DIR) $(LIB_FLAGS)

# Update main object compilation rule
$(MAIN_OBJ): $(MAIN_SRC) | $(OBJ_DIR)
	$(CC) $(CFLAGS) -I$(LIBRARY_DIR) -I$(SRC_DIR) -c $< -o $@

# Run tests
check: test
	./$(TEST_RUNNER)
