# AgenC Solana Communication Module
# Makefile following AgenC build conventions

CC := gcc
AR := ar

# Compiler flags following AgenC patterns
CFLAGS := -Wall -Wextra -Werror -std=c11 -pedantic
CFLAGS += -I./include
CFLAGS += -g -O2
CFLAGS += -pthread
CFLAGS += -D_POSIX_C_SOURCE=200809L

# Platform-specific flags
UNAME_S := $(shell uname -s 2>/dev/null || echo Windows)
ifeq ($(UNAME_S),Linux)
    LDFLAGS := -pthread
endif
ifeq ($(UNAME_S),Darwin)
    LDFLAGS := -pthread
endif
ifeq ($(UNAME_S),Windows)
    LDFLAGS := -lws2_32
    CFLAGS += -D_WIN32_WINNT=0x0601
endif

# Directories
SRC_DIR := src
INC_DIR := include
TEST_DIR := tests
BUILD_DIR := build
LIB_DIR := lib

# Source files
SRC_FILES := $(wildcard $(SRC_DIR)/*.c)
OBJ_FILES := $(SRC_FILES:$(SRC_DIR)/%.c=$(BUILD_DIR)/%.o)
DEP_FILES := $(OBJ_FILES:.o=.d)

# Library
LIB_NAME := libsolana_comm.a
LIB_FILE := $(BUILD_DIR)/$(LIB_NAME)

# Test files
TEST_FILES := $(wildcard $(TEST_DIR)/*.c)
TEST_BINS := $(TEST_FILES:$(TEST_DIR)/%.c=$(BUILD_DIR)/%)

# Default target
.PHONY: all
all: $(LIB_FILE)

# Create directories
$(BUILD_DIR):
	@mkdir -p $@

$(LIB_DIR):
	@mkdir -p $@

# Compile object files
$(BUILD_DIR)/%.o: $(SRC_DIR)/%.c | $(BUILD_DIR)
	$(CC) $(CFLAGS) -MMD -MP -c $< -o $@

# Build static library
$(LIB_FILE): $(OBJ_FILES)
	$(AR) rcs $@ $^
	@echo "Built $(LIB_FILE)"

# Build tests
.PHONY: tests
tests: $(LIB_FILE) $(TEST_BINS)
	@echo "Tests built successfully"

$(BUILD_DIR)/%: $(TEST_DIR)/%.c $(LIB_FILE) | $(BUILD_DIR)
	$(CC) $(CFLAGS) $< -L$(BUILD_DIR) -lsolana_comm $(LDFLAGS) -o $@

# Run tests
.PHONY: check
check: tests
	@for test in $(TEST_BINS); do \
		echo "Running $$test..."; \
		$$test || exit 1; \
	done
	@echo "All tests passed"

# Install library
.PHONY: install
install: $(LIB_FILE) | $(LIB_DIR)
	@cp $(LIB_FILE) $(LIB_DIR)/
	@cp -r $(INC_DIR)/* $(LIB_DIR)/
	@echo "Installed to $(LIB_DIR)"

# Clean build artifacts
.PHONY: clean
clean:
	rm -rf $(BUILD_DIR) $(LIB_DIR)

# Debug build
.PHONY: debug
debug: CFLAGS += -DDEBUG -O0 -g3
debug: clean all

# Release build
.PHONY: release
release: CFLAGS += -DNDEBUG -O3
release: CFLAGS := $(filter-out -g,$(CFLAGS))
release: clean all

# Format code (requires clang-format)
.PHONY: format
format:
	@find $(SRC_DIR) $(INC_DIR) $(TEST_DIR) -name "*.c" -o -name "*.h" | \
		xargs clang-format -i -style=file

# Static analysis (requires cppcheck)
.PHONY: analyze
analyze:
	cppcheck --enable=all --suppress=missingIncludeSystem \
		-I$(INC_DIR) $(SRC_DIR) $(TEST_DIR)

# Generate documentation (requires doxygen)
.PHONY: docs
docs:
	@mkdir -p docs/html
	doxygen Doxyfile

# Include dependency files
-include $(DEP_FILES)

# Print configuration
.PHONY: info
info:
	@echo "Platform: $(UNAME_S)"
	@echo "CC: $(CC)"
	@echo "CFLAGS: $(CFLAGS)"
	@echo "LDFLAGS: $(LDFLAGS)"
	@echo "Sources: $(SRC_FILES)"
	@echo "Objects: $(OBJ_FILES)"

.PHONY: help
help:
	@echo "AgenC Solana Communication Module"
	@echo ""
	@echo "Targets:"
	@echo "  all      - Build static library (default)"
	@echo "  tests    - Build test binaries"
	@echo "  check    - Run all tests"
	@echo "  install  - Install library to lib/"
	@echo "  clean    - Remove build artifacts"
	@echo "  debug    - Build with debug symbols"
	@echo "  release  - Build optimized release"
	@echo "  format   - Format code with clang-format"
	@echo "  analyze  - Run static analysis"
	@echo "  docs     - Generate documentation"
	@echo "  info     - Print build configuration"
