# Compiler settings
CC = gcc
CFLAGS = -Wall -Wextra -Werror -I./include \
         -fstack-protector-strong \
         -D_FORTIFY_SOURCE=2 \
         -O2 -fPIC \
         -Wformat=2 -Wformat-security \
         -fno-strict-aliasing \
         -fno-common \
         -pthread

# Directories
SRC_DIR = src
TEST_DIR = test
EXAMPLES_DIR = examples
INCLUDE_DIR = include
BUILD_DIR = build

# Source files
SRC = $(wildcard $(SRC_DIR)/*.c)
TEST_SRC = $(wildcard $(TEST_DIR)/*.c)
EXAMPLE_SRC = $(wildcard $(EXAMPLES_DIR)/*.c)

# Object files
OBJ = $(SRC:$(SRC_DIR)/%.c=$(BUILD_DIR)/%.o)
TEST_OBJ = $(TEST_SRC:$(TEST_DIR)/%.c=$(BUILD_DIR)/%.o)
EXAMPLE_OBJ = $(EXAMPLE_SRC:$(EXAMPLES_DIR)/%.c=$(BUILD_DIR)/%.o)

# Targets
.PHONY: all clean test example

all: $(BUILD_DIR)/strategy_test $(BUILD_DIR)/example

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

# Library object files
$(BUILD_DIR)/%.o: $(SRC_DIR)/%.c | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c $< -o $@

# Test object files
$(BUILD_DIR)/%.o: $(TEST_DIR)/%.c | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c $< -o $@

# Example object files
$(BUILD_DIR)/%.o: $(EXAMPLES_DIR)/%.c | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c $< -o $@

# Test executable
$(BUILD_DIR)/strategy_test: $(OBJ) $(TEST_OBJ)
	$(CC) $(CFLAGS) $^ -o $@

# Example executable
$(BUILD_DIR)/example: $(OBJ) $(EXAMPLE_OBJ)
	$(CC) $(CFLAGS) $^ -o $@

test: $(BUILD_DIR)/strategy_test
	./$(BUILD_DIR)/strategy_test

example: $(BUILD_DIR)/example
	./$(BUILD_DIR)/example

clean:
	rm -rf $(BUILD_DIR)
