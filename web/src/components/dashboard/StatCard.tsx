import type { ReactNode } from 'react';

type StatCardTone = 'default' | 'accent' | 'success' | 'warn' | 'danger';

interface StatCardProps {
  label: string;
  value: string | number;
  subtext?: string;
  icon?: ReactNode;
  tone?: StatCardTone;
}

const TONE_STYLES: Record<StatCardTone, {
  border: string;
  bg: string;
  label: string;
  value: string;
  icon: string;
  subtext: string;
}> = {
  default: {
    border: 'border-bbs-border',
    bg: 'bg-bbs-dark',
    label: 'text-bbs-gray',
    value: 'text-bbs-lightgray',
    icon: 'text-bbs-gray',
    subtext: 'text-bbs-gray',
  },
  accent: {
    border: 'border-bbs-purple-dim',
    bg: 'bg-bbs-surface',
    label: 'text-bbs-purple',
    value: 'text-bbs-white',
    icon: 'text-bbs-purple',
    subtext: 'text-bbs-lightgray',
  },
  success: {
    border: 'border-bbs-green-dim',
    bg: 'bg-bbs-surface',
    label: 'text-bbs-green',
    value: 'text-bbs-green',
    icon: 'text-bbs-green',
    subtext: 'text-bbs-lightgray',
  },
  warn: {
    border: 'border-bbs-yellow/40',
    bg: 'bg-bbs-surface',
    label: 'text-bbs-yellow',
    value: 'text-bbs-yellow',
    icon: 'text-bbs-yellow',
    subtext: 'text-bbs-lightgray',
  },
  danger: {
    border: 'border-bbs-red/40',
    bg: 'bg-bbs-surface',
    label: 'text-bbs-red',
    value: 'text-bbs-red',
    icon: 'text-bbs-red',
    subtext: 'text-bbs-lightgray',
  },
};

export function StatCard({ label, value, subtext, icon, tone = 'default' }: StatCardProps) {
  const styles = TONE_STYLES[tone];

  return (
    <div className={`border ${styles.border} ${styles.bg} px-3 py-3 font-mono transition-colors duration-150 hover:bg-bbs-surface`}>
      <div className="flex items-start justify-between gap-3">
        <div className={`text-[10px] uppercase tracking-[0.18em] ${styles.label}`}>{label}</div>
        {icon ? <div className={`mt-0.5 shrink-0 ${styles.icon}`}>{icon}</div> : null}
      </div>
      <div className={`mt-2 text-lg font-bold leading-tight break-words ${styles.value}`}>{value}</div>
      {subtext ? <div className={`mt-1 text-[11px] leading-relaxed ${styles.subtext}`}>{subtext}</div> : null}
    </div>
  );
}
