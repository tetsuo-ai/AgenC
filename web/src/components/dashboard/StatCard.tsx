interface StatCardProps {
  label: string;
  value: string | number;
  subtext?: string;
}

export function StatCard({ label, value, subtext }: StatCardProps) {
  return (
    <div className="bg-tetsuo-800 border border-tetsuo-700 rounded-lg p-4">
      <div className="text-xs text-tetsuo-500 uppercase tracking-wider">{label}</div>
      <div className="text-2xl font-semibold text-tetsuo-100 mt-1">{value}</div>
      {subtext && <div className="text-xs text-tetsuo-400 mt-1">{subtext}</div>}
    </div>
  );
}
