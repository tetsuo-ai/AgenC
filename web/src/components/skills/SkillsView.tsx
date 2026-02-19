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

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-tetsuo-200">
        <h2 className="text-sm font-semibold text-tetsuo-800">Skills</h2>
        <button
          onClick={onRefresh}
          className="text-xs text-accent hover:text-accent-dark transition-colors"
        >
          Refresh
        </button>
      </div>

      <div className="p-4">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search skills..."
          className="w-full bg-surface text-tetsuo-800 border border-tetsuo-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent placeholder:text-tetsuo-400"
        />
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-2">
        {filtered.length === 0 ? (
          <div className="text-center text-tetsuo-400 text-sm py-8">
            {skills.length === 0 ? 'No skills registered' : 'No skills match your search'}
          </div>
        ) : (
          filtered.map((skill) => (
            <SkillCard key={skill.name} skill={skill} onToggle={onToggle} />
          ))
        )}
      </div>
    </div>
  );
}
