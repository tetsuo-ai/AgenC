# Multi-Agent Coordination Example
# Makefile

CC := gcc
CFLAGS := -Wall -Wextra -std=c11 -g
CFLAGS += -I../../src/communication/solana/include

LDFLAGS := -L../../src/communication/solana/build
LDFLAGS += -lsolana_comm -pthread

# Platform-specific
UNAME_S := $(shell uname -s 2>/dev/null || echo Windows)
ifeq ($(UNAME_S),Windows)
    LDFLAGS += -lws2_32
    EXE := multi_agent.exe
else
    EXE := multi_agent
endif

SRC := main.c
OBJ := main.o

.PHONY: all clean run

all: $(EXE)

$(EXE): $(SRC)
	@echo "Building C library first..."
	$(MAKE) -C ../../src/communication/solana
	@echo "Building example..."
	$(CC) $(CFLAGS) $< $(LDFLAGS) -o $@
	@echo "Built $(EXE)"

clean:
	rm -f $(EXE) $(OBJ)

run: $(EXE)
	./$(EXE)

# Debug build
debug: CFLAGS += -DDEBUG -O0 -g3
debug: clean all

# With address sanitizer (Linux/macOS)
asan: CFLAGS += -fsanitize=address -fno-omit-frame-pointer
asan: LDFLAGS += -fsanitize=address
asan: clean all
