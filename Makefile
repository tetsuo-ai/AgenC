TARGET := main
BIN_DIR := bin
CC := gcc
CFLAGS := -Wall -Wextra -Iinclude -g

SRC_FILES := src/agent_framework.c main.c
OBJ_FILES := $(SRC_FILES:.c=.o)

all: $(BIN_DIR)/$(TARGET)

$(BIN_DIR)/$(TARGET): $(OBJ_FILES)
	mkdir -p $(BIN_DIR)
	$(CC) $(CFLAGS) -o $@ $(OBJ_FILES)

%.o: %.c
	$(CC) $(CFLAGS) -c $< -o $@

clean:
	rm -f $(OBJ_FILES) $(BIN_DIR)/$(TARGET)

.PHONY: all clean

