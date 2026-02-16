import { useState } from 'react';

interface WorkspaceSwitcherProps {
  current: string;
  workspaces: string[];
  onSwitch: (workspace: string) => void;
}

export function WorkspaceSwitcher({ current, workspaces, onSwitch }: WorkspaceSwitcherProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 text-xs text-tetsuo-300 hover:text-tetsuo-100 transition-colors"
      >
        <span className="w-2 h-2 rounded-sm bg-accent" />
        <span className="truncate max-w-[120px]">{current}</span>
        <span className="text-tetsuo-500">{open ? '\u25B2' : '\u25BC'}</span>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-48 bg-tetsuo-800 border border-tetsuo-700 rounded-lg shadow-xl z-50 py-1">
          {workspaces.map((ws) => (
            <button
              key={ws}
              onClick={() => {
                onSwitch(ws);
                setOpen(false);
              }}
              className={`w-full text-left px-3 py-2 text-xs hover:bg-tetsuo-700 transition-colors ${
                ws === current ? 'text-accent' : 'text-tetsuo-300'
              }`}
            >
              {ws}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
