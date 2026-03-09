import { useEffect } from 'react';
import type { ViewId } from '../types';

interface BBSMenuBarProps {
  currentView: ViewId;
  onViewChange: (view: ViewId) => void;
}

const MENU_ITEMS: { key: string; label: string; view: ViewId }[] = [
  { key: '1', label: 'CHAT', view: 'chat' },
  { key: '2', label: 'DASH', view: 'status' },
  { key: '3', label: 'RUNS', view: 'runs' },
  { key: '4', label: 'TRACE', view: 'observability' },
  { key: '5', label: 'TOOLS', view: 'skills' },
  { key: '6', label: 'TASKS', view: 'tasks' },
  { key: '7', label: 'MEMORY', view: 'memory' },
  { key: '8', label: 'DESKTOP', view: 'desktop' },
  { key: '9', label: 'FEED', view: 'activity' },
  { key: '0', label: 'SETTINGS', view: 'settings' },
];

export function BBSMenuBar({ currentView, onViewChange }: BBSMenuBarProps) {
  // Keyboard shortcuts: number keys 1-9
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't capture when typing in inputs
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const item = MENU_ITEMS.find((m) => m.key === e.key);
      if (item) {
        e.preventDefault();
        onViewChange(item.view);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onViewChange]);

  return (
    <div className="shrink-0 border-b border-bbs-purple-dim bg-bbs-surface overflow-x-auto">
      <div className="flex items-center gap-0 px-2 py-1.5 min-w-max">
        {MENU_ITEMS.map((item) => {
          const isActive = currentView === item.view;
          return (
            <button
              key={item.view}
              onClick={() => onViewChange(item.view)}
              title={item.label === 'DASH' ? 'Status' : item.label === 'TOOLS' ? 'Skills' : item.label === 'FEED' ? 'Activity' : item.label === 'TRACE' ? 'Observability' : item.label === 'CHAT' ? 'Chat' : item.label === 'RUNS' ? 'Runs' : item.label === 'DESKTOP' ? 'Desktop' : item.label === 'TASKS' ? 'Tasks' : item.label === 'MEMORY' ? 'Memory' : item.label}
              className={`flex items-center gap-1 px-3 py-1 text-xs transition-colors whitespace-nowrap ${
                isActive
                  ? 'text-bbs-white'
                  : 'text-bbs-gray hover:text-bbs-lightgray'
              }`}
            >
              <span className={isActive ? 'text-bbs-purple' : 'text-bbs-gray'}>[{item.key}]</span>
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
