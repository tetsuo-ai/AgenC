# Compiler settings
CC = gcc
CFLAGS = -Wall -Wextra -Werror -std=c11 -I./include -g
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
# Build the library into the build folder
LIB_FILE = $(BUILD_DIR)/$(LIB_NAME)
EXAMPLE_EXEC = example

# Targets
.PHONY: all clean test example install help

all: $(LIB_FILE) $(TEST_BINS) $(EXAMPLE_EXEC)

# Create required directory (only BUILD_DIR is needed for normal build)
$(BUILD_DIR):
	@mkdir -p $@

# Build library object files
$(BUILD_DIR)/%.o: $(SRC_DIR)/%.c | $(BUILD_DIR)
	@echo "Compiling $<..."
	$(CC) $(CFLAGS) -c $< -o $@

# Build static library (built in BUILD_DIR)
$(LIB_FILE): $(OBJ_FILES) | $(BUILD_DIR)
	@echo "Creating static library $(LIB_NAME)..."
	ar rcs $@ $^

# Build test executables (linking against the library in BUILD_DIR)
$(BUILD_DIR)/%: $(TEST_DIR)/%.c $(LIB_FILE) | $(BUILD_DIR)
	@echo "Linking test executable $@..."
	$(CC) $(CFLAGS) $< -L$(BUILD_DIR) -lmemstrategy -o $@ $(LDFLAGS)

# Build example program (linking against the library in BUILD_DIR)
$(EXAMPLE_EXEC): main.c $(LIB_FILE) | $(BUILD_DIR)
	@echo "Building example program..."
	$(CC) $(CFLAGS) -L$(BUILD_DIR) main.c -o $@ $(LDFLAGS) -lmemstrategy

test: $(TEST_BINS)
	@echo "Running all tests..."
	@for test in $(TEST_BINS); do \
		echo "\nRunning $$test:"; \
		./$$test; \
	done

# Install target: copies the library and headers into LIB_DIR
install: $(LIB_FILE)
	@echo "Installing $(LIB_NAME) and headers into $(LIB_DIR)..."
	@mkdir -p $(LIB_DIR)
	@cp $(LIB_FILE) $(LIB_DIR)/
	@cp -r $(INC_DIR)/* $(LIB_DIR)/
	@echo "Installation complete: $(LIB_DIR)/$(LIB_NAME) and header files copied."

clean:
	@echo "Cleaning build artifacts..."
	@rm -rf $(BUILD_DIR) $(LIB_DIR) $(EXAMPLE_EXEC) $(TEST_BINS)

help:
	@echo "Available targets:"
	@echo "  all     - Build library, tests, and example program"
	@echo "  test    - Run all tests"
	@echo "  example - Build the example program"
	@echo "  install - Copy library and header files into ./lib"
	@echo "  clean   - Remove build artifacts"
	@echo "  help    - Show this help message"
