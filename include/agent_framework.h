#ifndef AGENT_FRAMEWORK_H
#define AGENT_FRAMEWORK_H

typedef struct Agent
{
  char *name;
  void (*behavior) (struct Agent *);
} Agent;

typedef struct AgentManager AgentManager;
typedef void (*AgentBehavior) (Agent *);

// clang-format off
Agent *create_agent(const char *name, AgentBehavior behavior);
void destroy_agent(Agent *agent);

AgentManager *create_agent_manager(void);
void destroy_agent_manager(AgentManager *manager);

void register_agent(AgentManager *manager, Agent *agent);
void start_agent_manager(AgentManager *manager);
void stop_agent_manager(AgentManager *manager);
// clang-format on

#endif // AGENT_FRAMEWORK_H
