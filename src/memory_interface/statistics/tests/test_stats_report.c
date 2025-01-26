#include <assert.h>
#include <string.h>
#include <stdio.h>
#include "../include/stats_report.h"

void
test_stats_report_to_string ()
{
  stats_report_t report = {.alloc_count = 100,
			   .free_count = 90,
			   .current_bytes = 1024,
			   .peak_bytes = 2048};

  const char *report_str = stats_report_to_string (&report);
  (void) report_str;

  assert (strstr (report_str, "100") != NULL);
  assert (strstr (report_str, "90") != NULL);
  assert (strstr (report_str, "1024") != NULL);
  assert (strstr (report_str, "2048") != NULL);

  const char *null_report = stats_report_to_string (NULL);
  (void) null_report;
  assert (strcmp (null_report, "Invalid report") == 0);

  printf ("Stats report string conversion test passed\n");
}

int
main (int argc, char **argv)
{
  (void) argc;
  (void) argv;

  test_stats_report_to_string ();
  printf ("All stats report tests passed!\n");
  return 0;
}
