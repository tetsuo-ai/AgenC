#include <stdio.h>
#include <stdlib.h>
#include <pthread.h>
#include <unistd.h>
#include <inttypes.h>
#include "../include/strategy_status.h"

#define NUM_WORKER_THREADS 4
#define ITERATIONS_PER_THREAD 5

void
print_status (const StatusTracker *tracker)
{
  StrategyStatus current;
  uint64_t transitions, errors;

  if (get_current_status (tracker, &current) == STRATEGY_SUCCESS
      && get_transition_count (tracker, &transitions) == STRATEGY_SUCCESS
      && get_error_count (tracker, &errors) == STRATEGY_SUCCESS)
  {
    printf ("Current Status: %s\n", get_state_string (current));
    printf("Total Transitions: %" PRIu64 "\n", transitions);
    printf("Total Errors: %" PRIu64 "\n\n", errors);
  }
}

void *
worker_thread (void *arg)
{
  StatusTracker *tracker = (StatusTracker *) arg;

  for (int i = 0; i < ITERATIONS_PER_THREAD; i++)
  {
    if (transition_status (tracker, STRATEGY_STATE_ACTIVE) == STRATEGY_SUCCESS)
    {
      usleep (100000); // Simulate work

      if (rand () % 4 == 0)
      { // 25% chance of error
	transition_status (tracker, STRATEGY_STATE_ERROR);
	usleep (50000);
      }

      transition_status (tracker, STRATEGY_STATE_INITIALIZED);
    }
  }

  return NULL;
}

int
main (void)
{
  StatusTracker tracker;
  pthread_t threads[NUM_WORKER_THREADS];

  printf ("Thread-Safe State Management Demo\n");
  printf ("================================\n\n");

  if (initialize_status (&tracker) != STRATEGY_SUCCESS)
  {
    fprintf (stderr, "Failed to initialize tracker\n");
    return 1;
  }

  printf ("Initial state:\n");
  print_status (&tracker);

  for (int i = 0; i < NUM_WORKER_THREADS; i++)
  {
    if (pthread_create (&threads[i], NULL, worker_thread, &tracker) != 0)
    {
      fprintf (stderr, "Failed to create thread %d\n", i);
      return 1;
    }
  }

  for (int i = 0; i < NUM_WORKER_THREADS; i++)
    pthread_join (threads[i], NULL);

  printf ("Final state:\n");
  print_status (&tracker);

  return 0;
}
