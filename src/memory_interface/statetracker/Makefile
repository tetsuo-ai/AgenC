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
LIB_DIR = lib

# Source files
SRC = $(wildcard $(SRC_DIR)/*.c)
TEST_SRC = $(wildcard $(TEST_DIR)/*.c)
EXAMPLE_SRC = $(wildcard $(EXAMPLES_DIR)/*.c)

# Object files
OBJ = $(SRC:$(SRC_DIR)/%.c=$(BUILD_DIR)/%.o)
TEST_OBJ = $(TEST_SRC:$(TEST_DIR)/%.c=$(BUILD_DIR)/%.o)
EXAMPLE_OBJ = $(EXAMPLE_SRC:$(EXAMPLES_DIR)/%.c=$(BUILD_DIR)/%.o)

# Library target
LIB_NAME = libstatetracker.a
LIB_FILE = $(BUILD_DIR)/$(LIB_NAME)

# Executable targets
TEST_EXEC = $(BUILD_DIR)/strategy_test
EXAMPLE_EXEC = $(BUILD_DIR)/example

.PHONY: all lib clean test example install help

all: $(LIB_FILE) $(TEST_EXEC) $(EXAMPLE_EXEC)

# Create build directory
$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

# Build object files for library
$(BUILD_DIR)/%.o: $(SRC_DIR)/%.c | $(BUILD_DIR)
	@echo "Compiling $<..."
	$(CC) $(CFLAGS) -c $< -o $@

# Build object files for tests
$(BUILD_DIR)/%.o: $(TEST_DIR)/%.c | $(BUILD_DIR)
	@echo "Compiling $<..."
	$(CC) $(CFLAGS) -c $< -o $@

# Build object files for examples
$(BUILD_DIR)/%.o: $(EXAMPLES_DIR)/%.c | $(BUILD_DIR)
	@echo "Compiling $<..."
	$(CC) $(CFLAGS) -c $< -o $@

# Build static library from SRC objects
$(LIB_FILE): $(OBJ) | $(BUILD_DIR)
	@echo "Creating static library $(LIB_NAME)..."
	ar rcs $@ $^

# Build the library only
lib: $(LIB_FILE)
	@echo "Static library $(LIB_NAME) built successfully."

# Build test executable by linking against the static library
$(TEST_EXEC): $(TEST_OBJ) $(LIB_FILE) | $(BUILD_DIR)
	@echo "Linking test executable $@..."
	$(CC) $(CFLAGS) $(TEST_OBJ) -L$(BUILD_DIR) -lstatetracker -o $@ $(LDFLAGS)

# Build example executable by linking against the static library
$(EXAMPLE_EXEC): $(EXAMPLE_OBJ) $(LIB_FILE) | $(BUILD_DIR)
	@echo "Linking example executable $@..."
	$(CC) $(CFLAGS) $(EXAMPLE_OBJ) -L$(BUILD_DIR) -lstatetracker -o $@ $(LDFLAGS)

test: $(TEST_EXEC)
	@echo "Running test executable..."
	./$(TEST_EXEC)

example: $(EXAMPLE_EXEC)
	@echo "Running example executable..."
	./$(EXAMPLE_EXEC)

install: $(LIB_FILE)
	@echo "Installing $(LIB_NAME) and headers into $(LIB_DIR)..."
	@mkdir -p $(LIB_DIR)
	@cp $(LIB_FILE) $(LIB_DIR)/
	@cp -r $(INCLUDE_DIR)/* $(LIB_DIR)/
	@echo "Installation complete: $(LIB_DIR)/$(LIB_NAME) and header files copied."

clean:
	@echo "Cleaning build artifacts and installed files..."
	@rm -rf $(BUILD_DIR) $(LIB_DIR)

help:
	@echo "Available targets:"
	@echo "  all     - Build library, tests, and example program"
	@echo "  lib     - Build the static library only"
	@echo "  test    - Run the test executable"
	@echo "  example - Run the example executable"
	@echo "  install - Copy the static library and header files into ./lib"
	@echo "  clean   - Remove build artifacts and installed files"
	@echo "  help    - Show this help message"
