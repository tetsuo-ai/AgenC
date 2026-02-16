import type { ViewId, ConnectionState } from '../types';
import { ConnectionStatus } from './ConnectionStatus';
import { WorkspaceSwitcher } from './workspace/WorkspaceSwitcher';

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
  icon: string;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'chat', label: 'Chat', icon: '\u{1F4AC}' },
  { id: 'status', label: 'Status', icon: '\u{1F4CA}' },
  { id: 'skills', label: 'Skills', icon: '\u{1F9E9}' },
  { id: 'tasks', label: 'Tasks', icon: '\u{1F4CB}' },
  { id: 'memory', label: 'Memory', icon: '\u{1F4BE}' },
  { id: 'activity', label: 'Activity', icon: '\u{1F4E1}' },
];

export function Sidebar({
  currentView,
  onNavigate,
  connectionState,
  workspace,
  pendingApprovals,
}: SidebarProps) {
  return (
    <div className="w-56 bg-tetsuo-900 border-r border-tetsuo-700 flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-4 border-b border-tetsuo-700">
        <div className="text-sm font-bold text-tetsuo-100 tracking-wide">AgenC</div>
        <div className="text-xs text-tetsuo-500 mt-0.5">WebChat</div>
      </div>

      {/* Workspace */}
      <div className="border-b border-tetsuo-700">
        <WorkspaceSwitcher
          current={workspace}
          workspaces={['default']}
          onSwitch={() => {/* MVP: single workspace */}}
        />
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-2">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            onClick={() => onNavigate(item.id)}
            className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
              currentView === item.id
                ? 'bg-tetsuo-800 text-accent-light border-r-2 border-accent'
                : 'text-tetsuo-400 hover:text-tetsuo-200 hover:bg-tetsuo-800/50'
            }`}
          >
            <span className="text-base">{item.icon}</span>
            <span>{item.label}</span>
            {item.id === 'chat' && pendingApprovals > 0 && (
              <span className="ml-auto bg-yellow-500 text-yellow-900 text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center">
                {pendingApprovals}
              </span>
            )}
          </button>
        ))}
      </nav>

      {/* Connection status */}
      <div className="border-t border-tetsuo-700">
        <ConnectionStatus state={connectionState} />
      </div>
    </div>
  );
}
