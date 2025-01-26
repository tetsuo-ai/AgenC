/**
 * @file memory_stats.c
 * @brief memory statistics tracking
 */

#include "../include/memory_stats.h"
#include <string.h>
#include <time.h>
#include <stdlib.h>
#include <stdio.h>
#include <stdatomic.h>
#include <unistd.h>
#include <sched.h>

/** Size thresholds for allocation buckets (in bytes) */
static const size_t size_thresholds[STATS_SIZE_BUCKET_COUNT]
  = {32, 64, 128, 256, 512, 1024, 4096, SIZE_MAX};

/** Maximum number of retries for atomic counter operations */
#define MAX_COUNTER_RETRIES 5

/** Maximum number of retries for high contention operations */
#define MAX_RETRY_ATTEMPTS 10
#define BACKOFF_BASE_US 50
#define MAX_BACKOFF_US 1000
#define MAX_SLOT_SEARCH_ATTEMPTS 3

/** Jitter factor for backoff randomization (percent) */
#define BACKOFF_JITTER 20

// clang-format off
static void init_pattern_history (memory_stats_t *status);
static void init_active_alloc (memory_stats_t *status);
static void init_buckets (memory_stats_t *status);
static void init_counters (memory_stats_t *stats);
// clang-format on

static void
backoff_delay (int attempt)
{
  if (attempt <= 0)
    return;

  unsigned delay = BACKOFF_BASE_US * (1 << (attempt - 1));
  if (delay > MAX_BACKOFF_US)
    delay = MAX_BACKOFF_US;

  // Add jitter to prevent thundering herd
  delay += (delay * (rand () % BACKOFF_JITTER)) / 100;

  usleep (delay);
}

static void
memory_barrier_full (void)
{
  atomic_thread_fence (memory_order_seq_cst);
}

static _Bool
update_counter_with_retry (_Atomic uint64_t *counter, uint64_t value,
			   _Bool is_increment)
{
  for (int attempt = 0; attempt < MAX_COUNTER_RETRIES; attempt++)
  {
    uint64_t current = atomic_load_explicit (counter, memory_order_acquire);
    uint64_t new_value = is_increment ? current + value : current - value;

    if (atomic_compare_exchange_strong_explicit (counter, &current, new_value,
						 memory_order_release,
						 memory_order_acquire))
      return 1;

    if (attempt < MAX_COUNTER_RETRIES - 1)
    {
      backoff_delay (attempt);
      sched_yield ();
    }
  }

  if (is_increment)
    atomic_fetch_add_explicit (counter, value, memory_order_seq_cst);
  else
    atomic_fetch_sub_explicit (counter, value, memory_order_seq_cst);

  return 0; // fallback was used
}

static void
init_counters (memory_stats_t *stats)
{
  atomic_init (&stats->alloc_count, 0);
  atomic_init (&stats->free_count, 0);
  atomic_init (&stats->current_bytes, 0);
  atomic_init (&stats->peak_bytes, 0);
  atomic_init (&stats->total_allocation_time, 0);
  atomic_init (&stats->allocation_history_index, 0);
  atomic_init (&stats->active_allocation_count, 0);
  atomic_init (&stats->total_leaked_bytes, 0);
}

static void
init_buckets (memory_stats_t *stats)
{
  for (int i = 0; i < STATS_SIZE_BUCKET_COUNT; i++)
  {
    stats->size_distribution[i].size_threshold = size_thresholds[i];
    atomic_init (&stats->size_distribution[i].count, 0);
  }
}

static void
init_active_alloc (memory_stats_t *stats)
{
  for (int i = 0; i < STATS_MAX_TRACKED_ALLOCATIONS; i++)
  {
    atomic_init (&stats->active_allocations[i].address, NULL);
    atomic_init (&stats->active_allocations[i].size, 0);
    atomic_init (&stats->active_allocations[i].timestamp, 0);
    atomic_init (&stats->active_allocations[i].valid, 0);
    atomic_init (&stats->active_allocations[i].in_use, 0);
  }
}

static void
init_pattern_history (memory_stats_t *stats)
{
  for (int i = 0; i < STATS_PATTERN_HISTORY_SIZE; i++)
  {
    atomic_init (&stats->recent_allocations[i].size, 0);
    atomic_init (&stats->recent_allocations[i].timestamp, 0);
  }
}

void
memory_stats_init (memory_stats_t *stats)
{
  if (!stats)
    return;

  init_counters (stats);
  init_buckets (stats);
  init_active_alloc (stats);
  init_pattern_history (stats);
  memory_barrier_full ();
}

static void
update_size_distribution (memory_stats_t *stats, size_t size)
{
  for (int i = 0; i < STATS_SIZE_BUCKET_COUNT; i++)
    if (size <= stats->size_distribution[i].size_threshold)
    {
      atomic_fetch_add_explicit (&stats->size_distribution[i].count, 1,
				 memory_order_seq_cst);
      break;
    }
}

static void
record_allocation (memory_stats_t *stats, size_t size)
{
  uint32_t index = atomic_fetch_add_explicit (&stats->allocation_history_index,
					      1, memory_order_seq_cst)
		   % STATS_PATTERN_HISTORY_SIZE;
  atomic_store_explicit (&stats->recent_allocations[index].size, size,
			 memory_order_seq_cst);
  atomic_store_explicit (&stats->recent_allocations[index].timestamp,
			 (uint64_t) time (NULL), memory_order_seq_cst);
}

static int
find_free_slot (memory_stats_t *stats)
{
  memory_barrier_full ();

  for (int i = 0; i < STATS_MAX_TRACKED_ALLOCATIONS; i++)
  {
    uint8_t expected_in_use = 0;

    if (atomic_load_explicit (&stats->active_allocations[i].valid,
			      memory_order_seq_cst)
	!= 0)
      continue;

    if (atomic_compare_exchange_strong_explicit (
	  &stats->active_allocations[i].in_use, &expected_in_use, 1,
	  memory_order_seq_cst, memory_order_seq_cst))
      return i;
  }

  return -1;
}

static size_t
find_and_remove_allocation (memory_stats_t *stats, void *ptr)
{
  if (!stats || !ptr)
    return 0;

  memory_barrier_full ();

  for (int i = 0; i < STATS_MAX_TRACKED_ALLOCATIONS; i++)
  {
    if (atomic_load_explicit (&stats->active_allocations[i].valid,
			      memory_order_seq_cst)
	  == 0
	|| atomic_load_explicit (&stats->active_allocations[i].address,
				 memory_order_seq_cst)
	     != ptr)
      continue;

    uint8_t expected_in_use = 0;
    if (!atomic_compare_exchange_strong_explicit (
	  &stats->active_allocations[i].in_use, &expected_in_use, 1,
	  memory_order_seq_cst, memory_order_seq_cst))
      continue;

    size_t size = atomic_load_explicit (&stats->active_allocations[i].size,
					memory_order_seq_cst);

    // Mark slot as invalid and clear data
    atomic_store_explicit (&stats->active_allocations[i].valid, 0,
			   memory_order_seq_cst);
    atomic_store_explicit (&stats->active_allocations[i].address, NULL,
			   memory_order_seq_cst);
    atomic_store_explicit (&stats->active_allocations[i].size, 0,
			   memory_order_seq_cst);
    atomic_store_explicit (&stats->active_allocations[i].timestamp, 0,
			   memory_order_seq_cst);

    // Update counters
    atomic_fetch_sub_explicit (&stats->active_allocation_count, 1,
			       memory_order_seq_cst);
    atomic_fetch_sub_explicit (&stats->total_leaked_bytes, size,
			       memory_order_seq_cst);

    // Release slot
    atomic_store_explicit (&stats->active_allocations[i].in_use, 0,
			   memory_order_seq_cst);

    memory_barrier_full ();
    return size;
  }

  return 0;
}

void
memory_stats_update_allocation (memory_stats_t *stats, void *ptr, size_t size,
				const char *file, int line)
{
  if (!stats || !ptr)
    return;

  // Update allocation counter with retries
  update_counter_with_retry (&stats->alloc_count, 1, 1);

  // Update bytes with retries
  for (int attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++)
  {
    size_t current
      = atomic_load_explicit (&stats->current_bytes, memory_order_acquire);
    size_t new_current = current + size;

    // Update peak bytes if current exceeds it
    size_t peak
      = atomic_load_explicit (&stats->peak_bytes, memory_order_acquire);
    if (new_current > peak)
      atomic_store_explicit (&stats->peak_bytes, new_current,
			     memory_order_release);

    if (atomic_compare_exchange_strong_explicit (&stats->current_bytes,
						 &current, new_current,
						 memory_order_release,
						 memory_order_acquire))
      break;

    backoff_delay (attempt);
  }

  // Find a free slot with retries
  int slot = -1;
  for (int attempt = 0; attempt < MAX_RETRY_ATTEMPTS && slot < 0; attempt++)
  {
    slot = find_free_slot (stats);
    if (slot < 0 && attempt < MAX_RETRY_ATTEMPTS - 1)
    {
      backoff_delay (attempt);
      sched_yield ();
    }
  }

  if (slot >= 0)
  {
    atomic_store_explicit (&stats->active_allocations[slot].address, ptr,
			   memory_order_seq_cst);

    memory_barrier_full ();

    // Initialize slot data
    atomic_store_explicit (&stats->active_allocations[slot].size, size,
			   memory_order_seq_cst);
    atomic_store_explicit (&stats->active_allocations[slot].timestamp,
			   (uint64_t) time (NULL), memory_order_seq_cst);
    stats->active_allocations[slot].file = file;
    stats->active_allocations[slot].line = line;

    // Mark slot as valid
    atomic_store_explicit (&stats->active_allocations[slot].valid, 1,
			   memory_order_seq_cst);

    // Update tracking counters
    atomic_fetch_add_explicit (&stats->active_allocation_count, 1,
			       memory_order_seq_cst);
    atomic_fetch_add_explicit (&stats->total_leaked_bytes, size,
			       memory_order_seq_cst);

    // Clear in_use flag last
    atomic_store_explicit (&stats->active_allocations[slot].in_use, 0,
			   memory_order_seq_cst);

    memory_barrier_full ();
  }

  // Update analysis data
  update_size_distribution (stats, size);
  record_allocation (stats, size);

  memory_barrier_full ();
}

void
memory_stats_update_deallocation (memory_stats_t *stats, void *ptr)
{
  if (!stats || !ptr)
    return;

  memory_barrier_full ();

  // Try to find and remove the allocation
  size_t size = find_and_remove_allocation (stats, ptr);
  if (size == 0)
    return;

  memory_barrier_full ();

  // Update free counter atomically - single attempt should be sufficient
  update_counter_with_retry (&stats->free_count, 1, 1);

  memory_barrier_full ();

  // Update current bytes with retries
  for (int attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++)
  {
    size_t current
      = atomic_load_explicit (&stats->current_bytes, memory_order_acquire);

    if (current < size)
      break;

    if (atomic_compare_exchange_strong_explicit (&stats->current_bytes,
						 &current, current - size,
						 memory_order_release,
						 memory_order_acquire))
      break;
    backoff_delay (attempt);
  }

  memory_barrier_full ();
}

void
memory_stats_reset (memory_stats_t *stats)
{
  if (!stats)
  {
    return;
  }

  /* Reset all atomic counters */
  atomic_store (&stats->alloc_count, 0);
  atomic_store (&stats->free_count, 0);
  atomic_store (&stats->current_bytes, 0);
  atomic_store (&stats->peak_bytes, 0);
  atomic_store (&stats->total_allocation_time, 0);
  atomic_store (&stats->allocation_history_index, 0);
  atomic_store (&stats->active_allocation_count, 0);
  atomic_store (&stats->total_leaked_bytes, 0);

  /* Reset size distribution counters */
  for (int i = 0; i < STATS_SIZE_BUCKET_COUNT; i++)
    atomic_store (&stats->size_distribution[i].count, 0);

  /* Clear tracking arrays */
  for (int i = 0; i < STATS_MAX_TRACKED_ALLOCATIONS; i++)
    atomic_store (&stats->active_allocations[i].valid, 0);

  memset (stats->recent_allocations, 0, sizeof (stats->recent_allocations));
  memset (stats->active_allocations, 0, sizeof (stats->active_allocations));
}

void
memory_stats_get_report (const memory_stats_t *stats, stats_report_t *report)
{
  if (!stats || !report)
    return;

  /* Copy basic statistics atomically */
  report->alloc_count = atomic_load (&stats->alloc_count);
  report->free_count = atomic_load (&stats->free_count);
  report->current_bytes = atomic_load (&stats->current_bytes);
  report->peak_bytes = atomic_load (&stats->peak_bytes);
  report->active_allocation_count
    = atomic_load (&stats->active_allocation_count);
  report->total_leaked_bytes = atomic_load (&stats->total_leaked_bytes);

  /* Calculate pattern analysis metrics */
  uint64_t total_size = 0;
  uint64_t total_allocs = 0;

  for (int i = 0; i < STATS_SIZE_BUCKET_COUNT; i++)
  {
    report->size_distribution[i].threshold
      = stats->size_distribution[i].size_threshold;
    report->size_distribution[i].count
      = atomic_load (&stats->size_distribution[i].count);
    total_allocs += report->size_distribution[i].count;
    total_size += report->size_distribution[i].count
		  * (i > 0 ? stats->size_distribution[i].size_threshold
			   : stats->size_distribution[i].size_threshold / 2);
  }

  report->avg_allocation_size
    = total_allocs > 0 ? (double) total_size / total_allocs : 0;

  /* Calculate allocation frequency with proper synchronization */
  uint32_t current_index = atomic_load (&stats->allocation_history_index);
  if (current_index >= 2)
  {
    atomic_thread_fence (memory_order_acquire);
    time_t latest
      = stats
	  ->recent_allocations[(current_index - 1) % STATS_PATTERN_HISTORY_SIZE]
	  .timestamp;
    time_t earliest = stats->recent_allocations[0].timestamp;
    time_t duration = latest - earliest;
    report->allocation_frequency
      = duration > 0 ? report->alloc_count / duration : 0;
  }
  else
    report->allocation_frequency = 0;

  /* Copy leak information with proper synchronization */
  uint32_t count = atomic_load (&stats->active_allocation_count);
  report->leak_count
    = count > STATS_MAX_LEAK_REPORTS ? STATS_MAX_LEAK_REPORTS : count;

  atomic_thread_fence (memory_order_acquire);
  for (uint32_t i = 0; i < report->leak_count; i++)
    report->leaks[i]
      = (stats_leak_info_t){.address = stats->active_allocations[i].address,
			    .size = stats->active_allocations[i].size,
			    .file = stats->active_allocations[i].file,
			    .line = stats->active_allocations[i].line,
			    .timestamp
			    = stats->active_allocations[i].timestamp};
}

char *
memory_stats_analyze_patterns (const memory_stats_t *stats)
{
  if (!stats)
    return NULL;

  char *analysis = malloc (4096);
  if (!analysis)
    return NULL;

  stats_report_t report;
  memory_stats_get_report (stats, &report);

  int offset
    = snprintf (analysis, 4096,
		"Memory Allocation Pattern Analysis:\n"
		"================================\n"
		"Average Allocation Size: %.2f bytes\n"
		"Allocation Frequency: %lu/sec\n\n"
		"Size Distribution:\n",
		report.avg_allocation_size, report.allocation_frequency);

  for (int i = 0; i < STATS_SIZE_BUCKET_COUNT && offset < 4096; i++)
    offset += snprintf (analysis + offset, 4096 - offset,
			"  ≤ %zu bytes: %lu allocations\n",
			report.size_distribution[i].threshold,
			report.size_distribution[i].count);

  return analysis;
}

char *
memory_stats_check_leaks (const memory_stats_t *stats)
{
  if (!stats)
    return NULL;

  char *report = malloc (8192);
  if (!report)
    return NULL;

  stats_report_t stats_report;
  memory_stats_get_report (stats, &stats_report);

  int offset = snprintf (report, 8192,
			 "Memory Leak Analysis:\n"
			 "===================\n"
			 "Active Allocations: %u\n"
			 "Total Leaked Bytes: %zu\n\n",
			 stats_report.active_allocation_count,
			 stats_report.total_leaked_bytes);

  if (stats_report.leak_count > 0)
  {
    offset += snprintf (report + offset, 8192 - offset, "Detected Leaks:\n");
    for (uint32_t i = 0; i < stats_report.leak_count; i++)
    {
      offset
	+= snprintf (report + offset, 8192 - offset,
		     "  Leak #%u:\n"
		     "    Address: %p\n"
		     "    Size: %zu bytes\n"
		     "    Location: %s:%d\n"
		     "    Time: %lu\n\n",
		     i + 1, stats_report.leaks[i].address,
		     stats_report.leaks[i].size, stats_report.leaks[i].file,
		     stats_report.leaks[i].line,
		     stats_report.leaks[i].timestamp);
    }
  }
  else
    offset += snprintf (report + offset, 8192 - offset,
			"No memory leaks detected.\n");

  return report;
}
