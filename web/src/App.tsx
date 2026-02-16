import { useCallback, useState } from 'react';
import type { ViewId, WSMessage, ApprovalRequest } from './types';
import { useWebSocket } from './hooks/useWebSocket';
import { useChat } from './hooks/useChat';
import { useAgentStatus } from './hooks/useAgentStatus';
import { useSkills } from './hooks/useSkills';
import { useTasks } from './hooks/useTasks';
import { useMemory } from './hooks/useMemory';
import { useApprovals } from './hooks/useApprovals';
import { useActivityFeed } from './hooks/useActivityFeed';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Sidebar } from './components/Sidebar';
import { ApprovalBanner } from './components/approvals/ApprovalBanner';
import { ApprovalDialog } from './components/approvals/ApprovalDialog';
import { ChatView } from './components/chat/ChatView';
import { AgentStatusView } from './components/dashboard/AgentStatusView';
import { SkillsView } from './components/skills/SkillsView';
import { TasksView } from './components/tasks/TasksView';
import { MemoryView } from './components/memory/MemoryView';
import { ActivityFeedView } from './components/activity/ActivityFeedView';

// Type helper: extract handleMessage from hook return
type WithHandler<T> = T & { handleMessage: (msg: WSMessage) => void };

export default function App() {
  const [currentView, setCurrentView] = useState<ViewId>('chat');
  const [selectedApproval, setSelectedApproval] = useState<ApprovalRequest | null>(null);

  // WebSocket connection
  const { state: connectionState, send } = useWebSocket({
    onMessage: handleWSMessage,
  });

  const connected = connectionState === 'connected';

  // Hooks (all include handleMessage for routing WS messages)
  const chat = useChat({ send }) as WithHandler<ReturnType<typeof useChat>>;
  const agentStatus = useAgentStatus({ send, connected }) as WithHandler<ReturnType<typeof useAgentStatus>>;
  const skills = useSkills({ send }) as WithHandler<ReturnType<typeof useSkills>>;
  const tasks = useTasks({ send }) as WithHandler<ReturnType<typeof useTasks>>;
  const memory = useMemory({ send }) as WithHandler<ReturnType<typeof useMemory>>;
  const approvals = useApprovals({ send }) as WithHandler<ReturnType<typeof useApprovals>>;
  const activityFeed = useActivityFeed({ send, connected }) as WithHandler<ReturnType<typeof useActivityFeed>>;

  // Central message router — dispatches to appropriate hook handler
  function handleWSMessage(msg: WSMessage) {
    chat.handleMessage(msg);
    agentStatus.handleMessage(msg);
    skills.handleMessage(msg);
    tasks.handleMessage(msg);
    memory.handleMessage(msg);
    approvals.handleMessage(msg);
    activityFeed.handleMessage(msg);
  }

  const handleApprove = useCallback(
    (requestId: string) => {
      approvals.respond(requestId, true);
      setSelectedApproval(null);
    },
    [approvals],
  );

  const handleDeny = useCallback(
    (requestId: string) => {
      approvals.respond(requestId, false);
      setSelectedApproval(null);
    },
    [approvals],
  );

  return (
    <ErrorBoundary>
      <div className="flex h-screen">
        <Sidebar
          currentView={currentView}
          onNavigate={setCurrentView}
          connectionState={connectionState}
          workspace="default"
          pendingApprovals={approvals.pending.length}
        />

        <main className="flex-1 flex flex-col min-w-0">
          <ApprovalBanner
            pending={approvals.pending}
            onSelect={setSelectedApproval}
          />

          <div className="flex-1 min-h-0">
            {currentView === 'chat' && (
              <ChatView
                messages={chat.messages}
                isTyping={chat.isTyping}
                onSend={chat.sendMessage}
                connected={connected}
              />
            )}
            {currentView === 'status' && (
              <AgentStatusView
                status={agentStatus.status}
                onRefresh={agentStatus.refresh}
              />
            )}
            {currentView === 'skills' && (
              <SkillsView
                skills={skills.skills}
                onRefresh={skills.refresh}
                onToggle={skills.toggle}
              />
            )}
            {currentView === 'tasks' && (
              <TasksView
                tasks={tasks.tasks}
                onRefresh={tasks.refresh}
                onCreate={tasks.create}
                onCancel={tasks.cancel}
              />
            )}
            {currentView === 'memory' && (
              <MemoryView
                results={memory.results}
                sessions={memory.sessions}
                onSearch={memory.search}
                onRefreshSessions={memory.refreshSessions}
              />
            )}
            {currentView === 'activity' && (
              <ActivityFeedView
                events={activityFeed.events}
                onClear={activityFeed.clear}
              />
            )}
          </div>
        </main>

        {selectedApproval && (
          <ApprovalDialog
            request={selectedApproval}
            onApprove={handleApprove}
            onDeny={handleDeny}
            onClose={() => setSelectedApproval(null)}
          />
        )}
      </div>
    </ErrorBoundary>
  );
}
