import type { ViewId, ConnectionState } from '../types';
import { ConnectionStatus } from './ConnectionStatus';

interface SidebarProps {
  currentView: ViewId;
  onNavigate: (view: ViewId) => void;
  connectionState: ConnectionState;
  workspace: string;
  pendingApprovals: number;
}

interface NavItem {
  id: ViewId;
  label: string;
  icon: React.ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'chat', label: 'Chat', icon: <ChatIcon /> },
  { id: 'status', label: 'Status', icon: <StatusIcon /> },
  { id: 'skills', label: 'Skills', icon: <SkillsIcon /> },
  { id: 'tasks', label: 'Tasks', icon: <TasksIcon /> },
  { id: 'memory', label: 'Memory', icon: <MemoryIcon /> },
  { id: 'activity', label: 'Activity', icon: <ActivityIcon /> },
];

const BOTTOM_NAV: NavItem[] = [
  { id: 'settings', label: 'Settings', icon: <SettingsIcon /> },
  { id: 'payment', label: 'Payment', icon: <PaymentIcon /> },
];

export function Sidebar({
  currentView,
  onNavigate,
  connectionState,
  pendingApprovals,
}: SidebarProps) {
  return (
    <div className="w-20 h-full bg-tetsuo-50 border-r border-tetsuo-200 flex flex-col items-center py-4">
      {/* Brand Logo */}
      <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-6">
        <img src="/assets/agenc-logo.svg" alt="AgenC" className="w-8 h-8 dark:hidden" />
        <img src="/assets/agenc-logo-white.svg" alt="AgenC" className="w-8 h-8 hidden dark:block" />
      </div>

      {/* Nav Icons */}
      <nav className="flex-1 flex flex-col items-center gap-1">
        {NAV_ITEMS.map((item) => {
          const isActive = currentView === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              title={item.label}
              className={`relative w-12 h-12 rounded-xl flex items-center justify-center transition-all duration-200 active:scale-90 ${
                isActive
                  ? 'bg-accent-bg text-accent shadow-[0_0_12px_rgba(var(--accent),0.25)]'
                  : 'text-tetsuo-400 hover:text-tetsuo-600 hover:bg-tetsuo-100 hover:scale-105'
              }`}
            >
              {item.icon}
              {isActive && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-6 rounded-r-full bg-accent transition-all duration-300" />
              )}
              {item.id === 'chat' && pendingApprovals > 0 && (
                <span className="absolute top-1 right-1 w-4 h-4 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                  {pendingApprovals}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Bottom nav: Settings + Payment */}
      <div className="flex flex-col items-center gap-1 mt-auto mb-3">
        {BOTTOM_NAV.map((item) => {
          const isActive = currentView === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              title={item.label}
              className={`relative w-12 h-12 rounded-xl flex items-center justify-center transition-all duration-200 active:scale-90 ${
                isActive
                  ? 'bg-accent-bg text-accent shadow-[0_0_12px_rgba(var(--accent),0.25)]'
                  : 'text-tetsuo-400 hover:text-tetsuo-600 hover:bg-tetsuo-100 hover:scale-105'
              }`}
            >
              {item.icon}
              {isActive && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-6 rounded-r-full bg-accent transition-all duration-300" />
              )}
            </button>
          );
        })}
      </div>

      {/* Connection */}
      <div className="flex flex-col items-center gap-2">
        <ConnectionStatus state={connectionState} compact />
      </div>
    </div>
  );
}

// SVG Icons
function ChatIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function StatusIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 20V10M12 20V4M6 20v-6" />
    </svg>
  );
}

function SkillsIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
  );
}

function TasksIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function MemoryIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}

function ActivityIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function PaymentIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="4" width="22" height="16" rx="2" ry="2" /><line x1="1" y1="10" x2="23" y2="10" />
    </svg>
  );
}

