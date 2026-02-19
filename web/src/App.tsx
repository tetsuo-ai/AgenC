import { useCallback, useState } from 'react';
import type { ViewId, WSMessage, ApprovalRequest } from './types';
import { useWebSocket } from './hooks/useWebSocket';
import { useTheme } from './hooks/useTheme';
import { useChat } from './hooks/useChat';
import { useVoice } from './hooks/useVoice';
import { useAgentStatus } from './hooks/useAgentStatus';
import { useSkills } from './hooks/useSkills';
import { useTasks } from './hooks/useTasks';
import { useMemory } from './hooks/useMemory';
import { useApprovals } from './hooks/useApprovals';
import { useSettings } from './hooks/useSettings';
import { useWallet } from './hooks/useWallet';
import { useActivityFeed } from './hooks/useActivityFeed';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Sidebar } from './components/Sidebar';
import { RightPanel } from './components/RightPanel';
import { MobileHeader } from './components/MobileHeader';
import { ApprovalBanner } from './components/approvals/ApprovalBanner';
import { ApprovalDialog } from './components/approvals/ApprovalDialog';
import { ChatView } from './components/chat/ChatView';
import { AgentStatusView } from './components/dashboard/AgentStatusView';
import { SkillsView } from './components/skills/SkillsView';
import { TasksView } from './components/tasks/TasksView';
import { MemoryView } from './components/memory/MemoryView';
import { ActivityFeedView } from './components/activity/ActivityFeedView';
import { SettingsView } from './components/settings/SettingsView';
import { PaymentView } from './components/payment/PaymentView';

// Type helper: extract handleMessage from hook return
type WithHandler<T> = T & { handleMessage: (msg: WSMessage) => void };

export default function App() {
  const [currentView, setCurrentView] = useState<ViewId>('chat');
  const [selectedApproval, setSelectedApproval] = useState<ApprovalRequest | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { theme, toggle: toggleTheme } = useTheme();

  // WebSocket connection
  const { state: connectionState, send } = useWebSocket({
    onMessage: handleWSMessage,
  });

  const connected = connectionState === 'connected';

  // Hooks (all include handleMessage for routing WS messages)
  const chat = useChat({ send, connected }) as WithHandler<ReturnType<typeof useChat>>;
  const voice = useVoice({ send });
  const agentStatus = useAgentStatus({ send, connected }) as WithHandler<ReturnType<typeof useAgentStatus>>;
  const skills = useSkills({ send }) as WithHandler<ReturnType<typeof useSkills>>;
  const tasks = useTasks({ send }) as WithHandler<ReturnType<typeof useTasks>>;
  const memory = useMemory({ send }) as WithHandler<ReturnType<typeof useMemory>>;
  const approvals = useApprovals({ send }) as WithHandler<ReturnType<typeof useApprovals>>;
  const gatewaySettings = useSettings({ send, connected });
  const walletInfo = useWallet({ send, connected });
  const activityFeed = useActivityFeed({ send, connected }) as WithHandler<ReturnType<typeof useActivityFeed>>;

  // Voice toggle — start or stop voice session
  const handleVoiceToggle = useCallback(() => {
    if (voice.isVoiceActive) {
      voice.stopVoice();
    } else {
      void voice.startVoice();
    }
  }, [voice]);

  // Central message router — dispatches to appropriate hook handler
  function handleWSMessage(msg: WSMessage) {
    chat.handleMessage(msg);
    voice.handleMessage(msg);
    agentStatus.handleMessage(msg);
    skills.handleMessage(msg);
    tasks.handleMessage(msg);
    memory.handleMessage(msg);
    approvals.handleMessage(msg);
    gatewaySettings.handleMessage(msg);
    walletInfo.handleMessage(msg);
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
      <div className="flex h-screen bg-surface">
        {/* Desktop sidebar */}
        <div className="hidden md:flex">
          <Sidebar
            currentView={currentView}
            onNavigate={setCurrentView}
            connectionState={connectionState}
            workspace="default"
            pendingApprovals={approvals.pending.length}
          />
        </div>

        {/* Mobile sidebar overlay */}
        {sidebarOpen && (
          <div className="fixed inset-0 z-50 md:hidden">
            <div className="absolute inset-0 bg-black/40" onClick={() => setSidebarOpen(false)} />
            <div className="relative h-full w-[340px] max-w-[85vw] animate-slide-in">
              <Sidebar
                currentView={currentView}
                onNavigate={(view) => { setCurrentView(view); setSidebarOpen(false); }}
                connectionState={connectionState}
                workspace="default"
                pendingApprovals={approvals.pending.length}
                mobile
              />
            </div>
          </div>
        )}

        <main className="flex-1 flex flex-col min-w-0">
          {/* Mobile header */}
          <MobileHeader onMenuToggle={() => setSidebarOpen(true)} />

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
                voiceState={voice.voiceState}
                voiceTranscript={voice.transcript}
                voiceMode={voice.mode}
                onVoiceToggle={handleVoiceToggle}
                onVoiceModeChange={voice.setMode}
                onPushToTalkStart={voice.pushToTalkStart}
                onPushToTalkStop={voice.pushToTalkStop}
                theme={theme}
                onToggleTheme={toggleTheme}
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
            {currentView === 'settings' && (
              <SettingsView settings={gatewaySettings} />
            )}
            {currentView === 'payment' && (
              <PaymentView wallet={walletInfo} />
            )}
          </div>
        </main>

        {/* Desktop right panel */}
        <div className="hidden lg:flex">
          <RightPanel
            settings={gatewaySettings}
            wallet={walletInfo}
            chatSessions={chat.sessions}
            activeSessionId={chat.sessionId}
            onSelectSession={chat.resumeSession}
            onNewChat={chat.startNewChat}
          />
        </div>

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
