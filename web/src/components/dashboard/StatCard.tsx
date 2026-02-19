interface StatCardProps {
  label: string;
  value: string | number;
  subtext?: string;
  icon?: React.ReactNode;
  accent?: boolean;
}

export function StatCard({ label, value, subtext, icon, accent }: StatCardProps) {
  return (
    <div className={`rounded-xl border p-4 transition-all duration-200 hover:shadow-md ${
      accent
        ? 'border-accent/30 bg-accent-bg shadow-[0_0_12px_rgba(var(--accent),0.08)]'
        : 'border-tetsuo-200 bg-tetsuo-50 hover:border-tetsuo-300'
    }`}>
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] text-tetsuo-400 uppercase tracking-[0.15em] font-medium">{label}</div>
        {icon && <div className={accent ? 'text-accent' : 'text-tetsuo-400'}>{icon}</div>}
      </div>
      <div className={`text-2xl font-bold tracking-tight ${accent ? 'text-accent' : 'text-tetsuo-800'}`}>{value}</div>
      {subtext && <div className="text-xs text-tetsuo-500 mt-1.5">{subtext}</div>}
    </div>
  );
}
