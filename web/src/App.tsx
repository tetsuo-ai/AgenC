import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ViewId, WSMessage, ApprovalRequest } from './types';
import {
  WS_VOICE_SPEECH_STOPPED,
  WS_VOICE_DELEGATION,
  WS_VOICE_USER_TRANSCRIPT,
  WS_VOICE_TRANSCRIPT,
} from './constants';
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
import { useAgents } from './hooks/useAgents';
import { useDesktop } from './hooks/useDesktop';
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
import { DesktopView } from './components/desktop/DesktopView';

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

  // Type helper for hooks that expose handleMessage as an extra property
  // not yet on their return interface. TODO: add handleMessage to each hook's
  // return interface and remove these casts.
  type WithHandler<T> = T & { handleMessage: (msg: WSMessage) => void };

  // Hooks — chat and desktop have handleMessage on their return type.
  // Other hooks still need the WithHandler cast until their interfaces are updated.
  const chat = useChat({ send, connected });
  const handleDelegationResult = useCallback((task: string, content: string) => {
    // Inject delegation result into chat panel so user can read full output
    chat.injectMessage(`[Voice] ${task}`, 'user');
    chat.injectMessage(content, 'agent');
  }, [chat]);
  const voice = useVoice({ send, onDelegationResult: handleDelegationResult });
  const agentStatus = useAgentStatus({ send, connected }) as WithHandler<ReturnType<typeof useAgentStatus>>;
  const skills = useSkills({ send }) as WithHandler<ReturnType<typeof useSkills>>;
  const tasks = useTasks({ send }) as WithHandler<ReturnType<typeof useTasks>>;
  const memory = useMemory({ send }) as WithHandler<ReturnType<typeof useMemory>>;
  const approvals = useApprovals({ send }) as WithHandler<ReturnType<typeof useApprovals>>;
  const gatewaySettings = useSettings({ send, connected });
  const walletInfo = useWallet({ send, connected });
  const activityFeed = useActivityFeed({ send, connected }) as WithHandler<ReturnType<typeof useActivityFeed>>;
  const agentsData = useAgents({ send, connected }) as WithHandler<ReturnType<typeof useAgents>>;
  const desktop = useDesktop({ send, connected });
  const [desktopPanelOpen, setDesktopPanelOpen] = useState(false);
  const prevVncUrl = useRef<string | null>(null);
  const suppressNextVoiceTranscript = useRef(false);

  // Match VNC viewer to the active chat session's container.
  // During voice delegation, sandboxes are keyed by the voice session ID
  // (not the text chat session), so fall back to any ready sandbox.
  const sessionDesktopUrl = useMemo(
    () => desktop.vncUrlForSession(chat.sessionId)
      ?? (voice.isVoiceActive ? desktop.activeVncUrl : null),
    [desktop, chat.sessionId, voice.isVoiceActive],
  );

  const toggleDesktopPanel = useCallback(() => {
    setDesktopPanelOpen((prev) => !prev);
  }, []);

  // Auto-open desktop panel when a sandbox becomes ready
  useEffect(() => {
    if (sessionDesktopUrl && !prevVncUrl.current) {
      setDesktopPanelOpen(true);
    }
    prevVncUrl.current = sessionDesktopUrl;
  }, [sessionDesktopUrl]);

  // Periodically refresh sandbox list so we pick up newly-created containers
  const desktopRefresh = desktop.refresh;
  useEffect(() => {
    if (!connected) return;
    const id = setInterval(() => desktopRefresh(), 5000);
    return () => clearInterval(id);
  }, [connected, desktopRefresh]);

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
    agentsData.handleMessage(msg);
    desktop.handleMessage(msg);

    // Voice → Chat bridge: mirror voice turns as chat messages
    const payload = (msg.payload ?? {}) as Record<string, unknown>;
    if (msg.type === WS_VOICE_DELEGATION) {
      const status = payload.status as string;
      if (status === 'completed') {
        suppressNextVoiceTranscript.current = true;
      } else if (status === 'started' || status === 'error' || status === 'blocked') {
        suppressNextVoiceTranscript.current = false;
      }
    }

    if (msg.type === WS_VOICE_SPEECH_STOPPED) {
      // Inject placeholder immediately — replaced by real transcript if available
      chat.injectMessage('[Voice]', 'user');
    }
    if (msg.type === WS_VOICE_USER_TRANSCRIPT && typeof payload.text === 'string') {
      // Replace the [Voice] placeholder with actual transcribed text
      chat.replaceLastUserMessage(payload.text);
    }
    if (msg.type === WS_VOICE_TRANSCRIPT && payload.done && typeof payload.text === 'string') {
      if (suppressNextVoiceTranscript.current) {
        suppressNextVoiceTranscript.current = false;
        return;
      }
      chat.injectMessage(payload.text, 'agent');
    }
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
            theme={theme}
            onToggleTheme={toggleTheme}
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
                theme={theme}
                onToggleTheme={toggleTheme}
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
                onStop={chat.stopGeneration}
                connected={connected}
                voiceState={voice.voiceState}
                voiceTranscript={voice.transcript}
                voiceMode={voice.mode}
                onVoiceToggle={handleVoiceToggle}
                onVoiceModeChange={voice.setMode}
                onPushToTalkStart={voice.pushToTalkStart}
                onPushToTalkStop={voice.pushToTalkStop}
                delegationTask={voice.delegationTask}
                theme={theme}
                onToggleTheme={toggleTheme}
                chatSessions={chat.sessions}
                activeSessionId={chat.sessionId}
                onSelectSession={chat.resumeSession}
                onNewChat={chat.startNewChat}
                desktopUrl={sessionDesktopUrl}
                desktopOpen={desktopPanelOpen}
                onToggleDesktop={toggleDesktopPanel}
                tokenUsage={chat.tokenUsage}
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
            {currentView === 'desktop' && (
              <DesktopView
                sandboxes={desktop.sandboxes}
                loading={desktop.loading}
                error={desktop.error}
                onRefresh={desktop.refresh}
                onCreate={desktop.create}
                onDestroy={desktop.destroy}
              />
            )}
            {currentView === 'activity' && (
              <ActivityFeedView
                events={activityFeed.events}
                onClear={activityFeed.clear}
              />
            )}
            {currentView === 'settings' && (
              <SettingsView
                settings={gatewaySettings}
                autoApprove={approvals.autoApprove}
                onAutoApproveChange={approvals.setAutoApprove}
              />
            )}
            {currentView === 'payment' && (
              <PaymentView wallet={walletInfo} />
            )}
          </div>
        </main>

        {/* Desktop right panel — hidden when desktop viewer is open */}
        <div className={`hidden lg:flex ${desktopPanelOpen && sessionDesktopUrl ? '!hidden' : ''}`}>
          <RightPanel
            settings={gatewaySettings}
            wallet={walletInfo}
            chatSessions={chat.sessions}
            activeSessionId={chat.sessionId}
            onSelectSession={chat.resumeSession}
            onNewChat={chat.startNewChat}
            autoApprove={approvals.autoApprove}
            onAutoApproveChange={approvals.setAutoApprove}
            agents={agentsData.agents}
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
