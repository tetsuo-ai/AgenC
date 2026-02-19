import type { SkillInfo } from '../../types';

interface SkillCardProps {
  skill: SkillInfo;
  onToggle: (name: string, enabled: boolean) => void;
}

export function SkillCard({ skill, onToggle }: SkillCardProps) {
  return (
    <div className="flex items-center justify-between px-4 py-3 bg-tetsuo-50 rounded-lg border border-tetsuo-200">
      <div>
        <div className="text-sm font-medium text-tetsuo-800">{skill.name}</div>
        <div className="text-xs text-tetsuo-500 mt-0.5">{skill.description}</div>
      </div>
      <button
        onClick={() => onToggle(skill.name, !skill.enabled)}
        className={`relative w-10 h-5 rounded-full transition-colors ${
          skill.enabled ? 'bg-accent' : 'bg-tetsuo-300'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
            skill.enabled ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  );
}
