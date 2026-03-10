import type { SkillInfo } from '../../types';

interface SkillCardProps {
  skill: SkillInfo;
  onToggle: (name: string, enabled: boolean) => void;
}

function statusClass(enabled: boolean): string {
  return enabled ? 'text-bbs-green' : 'text-bbs-gray';
}

export function SkillCard({ skill, onToggle }: SkillCardProps) {
  const nextEnabled = !skill.enabled;

  return (
    <div
      className={`border px-4 py-4 transition-colors ${
        skill.enabled
          ? 'border-bbs-purple-dim bg-bbs-surface'
          : 'border-bbs-border bg-bbs-dark hover:bg-bbs-surface'
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-bbs-purple shrink-0">TOOL&gt;</span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h3 className="break-words text-sm font-bold text-bbs-white">{skill.name}</h3>
                <span className={`text-[10px] font-bold uppercase tracking-[0.14em] ${statusClass(skill.enabled)}`}>
                  [{skill.enabled ? 'enabled' : 'disabled'}]
                </span>
              </div>
              <p className="mt-1 whitespace-normal break-words text-xs leading-5 text-bbs-gray">
                {skill.description}
              </p>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => onToggle(skill.name, nextEnabled)}
          className={`shrink-0 border px-3 py-2 text-xs transition-colors ${
            skill.enabled
              ? 'border-bbs-red/40 bg-bbs-dark text-bbs-red hover:text-bbs-white'
              : 'border-bbs-border bg-bbs-dark text-bbs-gray hover:border-bbs-purple-dim hover:text-bbs-white'
          }`}
        >
          [{nextEnabled ? 'enable' : 'disable'}]
        </button>
      </div>
    </div>
  );
}
