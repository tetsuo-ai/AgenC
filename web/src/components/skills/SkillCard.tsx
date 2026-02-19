import type { SkillInfo } from '../../types';

interface SkillCardProps {
  skill: SkillInfo;
  onToggle: (name: string, enabled: boolean) => void;
}

export function SkillCard({ skill, onToggle }: SkillCardProps) {
  return (
    <div className={`flex items-center justify-between px-4 py-3.5 rounded-xl border transition-all duration-200 hover:shadow-sm ${
      skill.enabled
        ? 'border-accent/20 bg-accent-bg/50 hover:border-accent/30'
        : 'border-tetsuo-200 bg-tetsuo-50 hover:border-tetsuo-300'
    }`}>
      <div className="flex items-center gap-3 min-w-0">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
          skill.enabled ? 'bg-accent/10 text-accent' : 'bg-tetsuo-100 text-tetsuo-400'
        }`}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
          </svg>
        </div>
        <div className="min-w-0">
          <div className={`text-sm font-medium truncate ${skill.enabled ? 'text-accent' : 'text-tetsuo-700'}`}>{skill.name}</div>
          <div className="text-xs text-tetsuo-400 truncate mt-0.5">{skill.description}</div>
        </div>
      </div>
      <button
        onClick={() => onToggle(skill.name, !skill.enabled)}
        className={`relative w-10 h-6 rounded-full transition-all duration-300 shrink-0 ml-3 ${
          skill.enabled ? 'bg-accent shadow-[0_0_8px_rgba(var(--accent),0.3)]' : 'bg-tetsuo-300'
        }`}
      >
        <span
          className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow-sm transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${
            skill.enabled ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  );
}
