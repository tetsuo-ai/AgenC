/**
 * @file pool_strategy_test.c
 * @brief Test suite for memory pool strategy implementation
 */

#include "memory_pool_strategy.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <pthread.h>
#include <stdint.h>
#include <stdatomic.h>

#define SMALL_ALLOC_SIZE 64
#define MEDIUM_ALLOC_SIZE (POOL_BLOCK_SIZE - sizeof (size_t))
#define LARGE_ALLOC_SIZE (POOL_BLOCK_SIZE * 2)
#define NUM_THREADS 4
#define NUM_ALLOCATIONS 10
#define MAX_RETRIES 3

typedef struct
{
  MemoryStrategy *strategy;
  int thread_id;
  size_t allocation_size;
  int num_allocations;
  atomic_bool *success;
  char *error_msg;
  size_t error_msg_size;
} ThreadData;

static void
test_pool_creation (void)
{
  printf ("Testing pool creation and destruction...\n");

  // Test creation
  MemoryStrategy *strategy = create_pool_strategy ();
  assert (strategy != NULL);
  assert (strategy->strategy_data != NULL);
  assert (strategy->allocate != NULL);
  assert (strategy->deallocate != NULL);
  assert (strategy->get_status != NULL);
  assert (strategy->validate != NULL);

  // Test initial state
  assert (strategy->get_status (strategy) == STRATEGY_STATE_ACTIVE);
  assert (strategy->validate (strategy) == true);

  // Test destruction
  destroy_pool_strategy (strategy);
  printf ("Pool creation and destruction tests passed\n");
}

static void
test_basic_allocation (void)
{
  printf ("Testing basic allocation operations...\n");

  MemoryStrategy *strategy = create_pool_strategy ();
  assert (strategy != NULL);

  // Test small allocation
  void *ptr1 = strategy->allocate (strategy, SMALL_ALLOC_SIZE);
  assert (ptr1 != NULL);
  memset (ptr1, 0xAA, SMALL_ALLOC_SIZE);

  // Test medium allocation
  void *ptr2 = strategy->allocate (strategy, MEDIUM_ALLOC_SIZE);
  assert (ptr2 != NULL);
  memset (ptr2, 0xBB, MEDIUM_ALLOC_SIZE);

  // Test large allocation
  void *ptr3 = strategy->allocate (strategy, LARGE_ALLOC_SIZE);
  assert (ptr3 != NULL);
  memset (ptr3, 0xCC, LARGE_ALLOC_SIZE);

  // Verify memory isolation
  unsigned char *check1 = ptr1;
  unsigned char *check2 = ptr2;
  unsigned char *check3 = ptr3;

  for (size_t i = 0; i < SMALL_ALLOC_SIZE; i++)
  {
    assert (check1[i] == 0xAA);
  }
  for (size_t i = 0; i < MEDIUM_ALLOC_SIZE; i++)
  {
    assert (check2[i] == 0xBB);
  }
  for (size_t i = 0; i < LARGE_ALLOC_SIZE; i++)
  {
    assert (check3[i] == 0xCC);
  }

  // Test deallocation
  strategy->deallocate (strategy, ptr1);
  strategy->deallocate (strategy, ptr2);
  strategy->deallocate (strategy, ptr3);

  // Verify pool state after deallocation
  assert (strategy->get_status (strategy) == STRATEGY_STATE_ACTIVE);
  assert (strategy->validate (strategy) == true);

  destroy_pool_strategy (strategy);
  printf ("Basic allocation tests passed\n");
}

static void
test_boundary_conditions (void)
{
  printf ("Testing boundary conditions...\n");

  MemoryStrategy *strategy = create_pool_strategy ();
  assert (strategy != NULL);

  // Test zero allocation
  void *ptr = strategy->allocate (strategy, 0);
  assert (ptr == NULL);

  // Test minimum allocation
  ptr = strategy->allocate (strategy, POOL_MIN_ALLOCATION);
  assert (ptr != NULL);
  strategy->deallocate (strategy, ptr);

  // Test maximum allocation
  ptr = strategy->allocate (strategy, POOL_MAX_ALLOCATION);
  assert (ptr != NULL);
  strategy->deallocate (strategy, ptr);

  // Test overflow allocation
  ptr = strategy->allocate (strategy, SIZE_MAX);
  assert (ptr == NULL);

  // Test double free
  ptr = strategy->allocate (strategy, SMALL_ALLOC_SIZE);
  assert (ptr != NULL);
  strategy->deallocate (strategy, ptr);
  strategy->deallocate (strategy, ptr); // Should not crash

  // Test invalid pointer deallocation
  strategy->deallocate (strategy, (void *) 0x1000); // Should not crash

  destroy_pool_strategy (strategy);
  printf ("Boundary condition tests passed\n");
}

static void
test_fragmentation_handling (void)
{
  printf ("Testing fragmentation handling...\n");

  MemoryStrategy *strategy = create_pool_strategy ();
  void *ptrs[100];
  int alloc_count = 0;

  // Allocate alternating sizes to create fragmentation
  for (int i = 0; i < 100; i++)
  {
    size_t size = (i % 2) ? SMALL_ALLOC_SIZE : MEDIUM_ALLOC_SIZE;
    ptrs[i] = strategy->allocate (strategy, size);
    if (ptrs[i] != NULL)
    {
      alloc_count++;
    }
  }

  // Free every other allocation
  for (int i = 0; i < alloc_count; i += 2)
  {
    strategy->deallocate (strategy, ptrs[i]);
  }

  // Try to allocate in the gaps
  bool allocated_in_gaps = false;
  for (int i = 0; i < 10; i++)
  {
    void *ptr = strategy->allocate (strategy, SMALL_ALLOC_SIZE);
    if (ptr != NULL)
    {
      strategy->deallocate (strategy, ptr);
      allocated_in_gaps = true;
      break;
    }
  }
  assert (allocated_in_gaps);

  // Cleanup remaining allocations
  for (int i = 1; i < alloc_count; i += 2)
  {
    strategy->deallocate (strategy, ptrs[i]);
  }

  destroy_pool_strategy (strategy);
  printf ("Fragmentation handling tests passed\n");
}

static void *
concurrent_allocation_thread (void *arg)
{
  ThreadData *data = (ThreadData *) arg;
  void *ptrs[NUM_ALLOCATIONS];
  memset (ptrs, 0, sizeof (ptrs));

  // First phase: Allocations
  for (int i = 0; i < data->num_allocations; i++)
  {
    int retries = 0;
    while (retries < MAX_RETRIES)
    {
      ptrs[i]
	= data->strategy->allocate (data->strategy, data->allocation_size);
      if (ptrs[i])
	break;
      retries++;
    }

    if (!ptrs[i])
    {
      snprintf (data->error_msg, data->error_msg_size,
		"Thread %d: Failed to allocate block %d after %d retries",
		data->thread_id, i, MAX_RETRIES);
      atomic_store (data->success, false);
      goto cleanup;
    }

    // Write unique pattern
    memset (ptrs[i], (unsigned char) (data->thread_id * NUM_ALLOCATIONS + i),
	    data->allocation_size);
  }

  // Second phase: Memory verification
  for (int i = 0; i < data->num_allocations; i++)
  {
    unsigned char *check = ptrs[i];
    unsigned char pattern
      = (unsigned char) (data->thread_id * NUM_ALLOCATIONS + i);
    for (size_t j = 0; j < data->allocation_size; j++)
    {
      if (check[j] != pattern)
      {
	snprintf (
	  data->error_msg, data->error_msg_size,
	  "Thread %d: Memory corruption detected in block %d at offset %zu",
	  data->thread_id, i, j);
	atomic_store (data->success, false);
	goto cleanup;
      }
    }
  }

cleanup:
  // Final phase: Cleanup
  for (int i = 0; i < data->num_allocations; i++)
  {
    if (ptrs[i])
    {
      data->strategy->deallocate (data->strategy, ptrs[i]);
    }
  }

  return NULL;
}

static void
test_concurrent_allocations (void)
{
  printf ("Testing concurrent allocations...\n");

  MemoryStrategy *strategy = create_pool_strategy ();
  assert (strategy != NULL);

  pthread_t threads[NUM_THREADS];
  ThreadData thread_data[NUM_THREADS];
  atomic_bool success = ATOMIC_VAR_INIT (true);
  char error_msgs[NUM_THREADS][256];

  // Create threads with different allocation patterns
  for (int i = 0; i < NUM_THREADS; i++)
  {
    thread_data[i].strategy = strategy;
    thread_data[i].thread_id = i;
    thread_data[i].allocation_size = SMALL_ALLOC_SIZE;
    thread_data[i].num_allocations = NUM_ALLOCATIONS;
    thread_data[i].success = &success;
    thread_data[i].error_msg = error_msgs[i];
    thread_data[i].error_msg_size = sizeof (error_msgs[i]);

    int rc = pthread_create (&threads[i], NULL, concurrent_allocation_thread,
			     &thread_data[i]);
    assert (rc == 0);
  }

  // Wait for all threads
  for (int i = 0; i < NUM_THREADS; i++)
  {
    pthread_join (threads[i], NULL);
  }

  // Check for errors
  if (!atomic_load (&success))
  {
    for (int i = 0; i < NUM_THREADS; i++)
    {
      if (error_msgs[i][0] != '\0')
      {
	printf ("Error: %s\n", error_msgs[i]);
      }
    }
  }

  assert (atomic_load (&success));
  assert (strategy->validate (strategy));

  destroy_pool_strategy (strategy);
  printf ("Concurrent allocation tests passed\n");
}

int
main (void)
{
  printf ("Running memory pool strategy tests...\n\n");

  test_pool_creation ();
  test_basic_allocation ();
  test_boundary_conditions ();
  test_fragmentation_handling ();
  test_concurrent_allocations ();

  printf ("\nAll memory pool strategy tests passed successfully!\n");
  return 0;
}
