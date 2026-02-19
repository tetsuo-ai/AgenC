import { useEffect, useState } from 'react';
import type { SkillInfo } from '../../types';
import { SkillCard } from './SkillCard';

interface SkillsViewProps {
  skills: SkillInfo[];
  onRefresh: () => void;
  onToggle: (name: string, enabled: boolean) => void;
}

export function SkillsView({ skills, onRefresh, onToggle }: SkillsViewProps) {
  const [filter, setFilter] = useState('');

  useEffect(() => {
    onRefresh();
  }, [onRefresh]);

  const filtered = filter
    ? skills.filter(
        (s) =>
          s.name.toLowerCase().includes(filter.toLowerCase()) ||
          s.description.toLowerCase().includes(filter.toLowerCase()),
      )
    : skills;

  const enabledCount = skills.filter((s) => s.enabled).length;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-tetsuo-200">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-accent-bg flex items-center justify-center">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-accent" strokeWidth="2" strokeLinecap="round">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
          </div>
          <div>
            <h2 className="text-base font-bold text-tetsuo-800 tracking-tight">Skills</h2>
            {skills.length > 0 && (
              <div className="text-[10px] text-tetsuo-400 mt-0.5">{enabledCount} of {skills.length} enabled</div>
            )}
          </div>
        </div>
        <button
          onClick={onRefresh}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-tetsuo-400 hover:text-accent hover:bg-tetsuo-100 transition-all duration-200 active:scale-90"
          title="Refresh"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
      </div>

      {/* Search */}
      <div className="px-6 py-4 max-w-2xl mx-auto w-full">
        <div className="relative">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="absolute left-3 top-1/2 -translate-y-1/2 text-tetsuo-400" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search skills..."
            className="w-full bg-tetsuo-50 border border-tetsuo-200 rounded-xl pl-10 pr-4 py-2.5 text-sm text-tetsuo-700 placeholder:text-tetsuo-400 focus:outline-none focus:border-accent focus:shadow-[0_0_0_3px_rgba(var(--accent),0.1)] transition-all duration-200"
          />
        </div>
      </div>

      {/* Skills list */}
      <div className="flex-1 overflow-y-auto px-6 pb-6"><div className="max-w-2xl mx-auto space-y-2">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-12">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-tetsuo-200" strokeWidth="1.5" strokeLinecap="round">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
            <span className="text-sm text-tetsuo-400">
              {skills.length === 0 ? 'No skills registered' : 'No skills match your search'}
            </span>
          </div>
        ) : (
          filtered.map((skill, i) => (
            <div key={skill.name} className="animate-list-item" style={{ animationDelay: `${i * 40}ms` }}>
              <SkillCard skill={skill} onToggle={onToggle} />
            </div>
          ))
        )}
      </div></div>
    </div>
  );
}
