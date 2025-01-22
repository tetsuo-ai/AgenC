#include "../include/agent_framework.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct AgentManager
{
  Agent **agents;
  size_t agent_count;
  int running;
};

Agent *
create_agent (const char *name, AgentBehavior behavior)
{
  Agent *agent = (Agent *) malloc (sizeof (Agent));
  if (!agent)
  {
    fprintf (stderr, "Failed to allocate Agent\n");
    return NULL;
  }
  agent->name = strdup (name);
  agent->behavior = behavior;
  return agent;
}

void
destroy_agent (Agent *agent)
{
  if (agent)
  {
    free (agent->name);
    free (agent);
  }
}

AgentManager *
create_agent_manager (void)
{
  AgentManager *manager = (AgentManager *) malloc (sizeof (AgentManager));
  if (!manager)
  {
    fprintf (stderr, "Failed to allocate AgentManager\n");
    return NULL;
  }
  manager->agents = NULL;
  manager->agent_count = 0;
  manager->running = 0;
  return manager;
}

void
destroy_agent_manager (AgentManager *manager)
{
  if (!manager)
    return;

  for (size_t i = 0; i < manager->agent_count; i++)
    if (manager->agents[i])
      destroy_agent (manager->agents[i]);

  free (manager->agents);
  free (manager);
}

void
register_agent (AgentManager *manager, Agent *agent)
{
  if (!manager || !agent)
    return;

  Agent **new_array
    = (Agent **) realloc (manager->agents,
			  (manager->agent_count + 1) * sizeof (Agent *));
  if (!new_array)
  {
    fprintf (stderr, "Failed to reallocate agent array\n");
    return;
  }

  manager->agents = new_array;
  manager->agents[manager->agent_count] = agent;
  manager->agent_count++;
}

void
start_agent_manager (AgentManager *manager)
{
  if (!manager)
    return;

  manager->running = 1;
  for (size_t i = 0; i < manager->agent_count; i++)
    if (manager->agents[i] && manager->agents[i]->behavior)
      manager->agents[i]->behavior (manager->agents[i]);
}

void
stop_agent_manager (AgentManager *manager)
{
  if (manager)
    manager->running = 0;
}
