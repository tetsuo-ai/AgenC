/**
 * @file main.c
 * @brief Example usage of the thread-safe memory management strategy API
 */

#include "src/default_strategy.h"
#include <stdio.h>
#include <string.h>
#include <pthread.h>

#define NUM_THREADS 4
#define NUM_ALLOCATIONS 100
#define ALLOCATION_SIZE 1024

static void *
thread_worker (void *arg)
{
  DefaultStrategy *strategy = (DefaultStrategy *) arg;
  void *allocations[NUM_ALLOCATIONS];

  printf ("Thread %lu: Starting memory operations\n",
	  (unsigned long) pthread_self ());

  for (int i = 0; i < NUM_ALLOCATIONS; i++)
  {
    allocations[i] = strategy->base.allocate (&strategy->base, ALLOCATION_SIZE);
    if (allocations[i])
    {
      memset (allocations[i], i % 255, ALLOCATION_SIZE);

      unsigned char *data = (unsigned char *) allocations[i];
      for (size_t j = 0; j < ALLOCATION_SIZE; j++)
      {
	if (data[j] != (i % 255))
	{
	  printf ("Thread %lu: Memory verification failed at allocation %d\n",
		  (unsigned long) pthread_self (), i);
	  break;
	}
      }
    }
    else
    {
      printf ("Thread %lu: Allocation %d failed\n",
	      (unsigned long) pthread_self (), i);
    }
  }

  // Deallocate memory
  for (int i = 0; i < NUM_ALLOCATIONS; i++)
  {
    if (allocations[i])
    {
      strategy->base.deallocate (&strategy->base, allocations[i]);
    }
  }

  printf ("Thread %lu: Completed memory operations\n",
	  (unsigned long) pthread_self ());
  return NULL;
}

int
main (void)
{
  printf ("Starting memory management strategy example...\n\n");

  DefaultStrategy *strategy = create_default_strategy ();
  if (!strategy)
  {
    fprintf (stderr, "Failed to create memory strategy\n");
    return 1;
  }

  printf ("Memory strategy initialized successfully\n");
  printf ("Strategy name: %s\n", get_strategy_name ());

  if (strategy->base.get_status (&strategy->base) != STRATEGY_STATE_ACTIVE)
  {
    fprintf (stderr, "Strategy initialization failed\n");
    destroy_default_strategy (strategy);
    return 1;
  }

  pthread_t threads[NUM_THREADS];
  printf ("\nStarting %d threads for concurrent memory operations...\n",
	  NUM_THREADS);

  for (int i = 0; i < NUM_THREADS; i++)
  {
    if (pthread_create (&threads[i], NULL, thread_worker, strategy) != 0)
    {
      fprintf (stderr, "Failed to create thread %d\n", i);
      destroy_default_strategy (strategy);
      return 1;
    }
  }

  for (int i = 0; i < NUM_THREADS; i++)
    pthread_join (threads[i], NULL);

  printf ("\nMemory usage statistics:\n");
  printf ("Current usage: %zu bytes\n", get_current_usage (strategy));
  printf ("Peak usage: %zu bytes\n", get_peak_usage (strategy));
  printf ("Total allocated: %zu bytes\n", get_total_allocated (strategy));
  printf ("Total freed: %zu bytes\n", get_total_freed (strategy));

  printf ("\nCleaning up...\n");
  destroy_default_strategy (strategy);
  printf ("Memory strategy destroyed successfully\n");

  return 0;
}
