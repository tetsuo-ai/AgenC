#include "./src/agent_framework.c"
#include <stdio.h>

// clang-format off
static void my_agent_behavior (Agent *agent);
// clang-format on

int
main (void)
{
  Agent *myAgent = create_agent ("Tetsuo Coin Agent", my_agent_behavior);

  AgentManager *manager = create_agent_manager ();

  register_agent (manager, myAgent);

  start_agent_manager (manager);

  stop_agent_manager (manager);

  destroy_agent_manager (manager);

  return 0;
}

static void
my_agent_behavior (Agent *agent)
{
  printf ("Executing behavior for: %s\n", agent->name);
}
