import { useCallback, useState } from 'react';

interface CreateTaskFormProps {
  onCreate: (params: Record<string, unknown>) => void;
}

export function CreateTaskForm({ onCreate }: CreateTaskFormProps) {
  const [description, setDescription] = useState('');
  const [reward, setReward] = useState('');
  const [expanded, setExpanded] = useState(false);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!description.trim()) return;
      onCreate({
        description: description.trim(),
        reward: reward ? Number(reward) : undefined,
      });
      setDescription('');
      setReward('');
      setExpanded(false);
    },
    [description, reward, onCreate],
  );

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="w-full flex items-center justify-center gap-2 px-4 py-3 border border-dashed border-tetsuo-200 rounded-xl text-sm text-tetsuo-400 hover:border-accent hover:text-accent hover:bg-accent-bg/30 transition-all duration-200"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
        Create Task
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 p-4 rounded-xl border border-accent/20 bg-accent-bg/30 animate-panel-enter">
      <div>
        <label className="text-[10px] text-tetsuo-400 uppercase tracking-[0.15em] font-medium block mb-1.5">Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full bg-surface border border-tetsuo-200 rounded-lg px-3 py-2.5 text-sm text-tetsuo-700 resize-none focus:outline-none focus:border-accent focus:shadow-[0_0_0_3px_rgba(var(--accent),0.1)] transition-all duration-200 placeholder:text-tetsuo-400"
          rows={3}
          placeholder="Task description..."
          autoFocus
        />
      </div>
      <div>
        <label className="text-[10px] text-tetsuo-400 uppercase tracking-[0.15em] font-medium block mb-1.5">Reward (SOL)</label>
        <input
          type="number"
          value={reward}
          onChange={(e) => setReward(e.target.value)}
          className="w-full bg-surface border border-tetsuo-200 rounded-lg px-3 py-2.5 text-sm text-tetsuo-700 focus:outline-none focus:border-accent focus:shadow-[0_0_0_3px_rgba(var(--accent),0.1)] transition-all duration-200 placeholder:text-tetsuo-400"
          placeholder="0"
        />
      </div>
      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:opacity-90 hover:shadow-lg hover:shadow-accent/20 active:scale-[0.98] transition-all duration-200"
        >
          Create
        </button>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="px-4 py-2 text-tetsuo-500 text-sm hover:text-tetsuo-700 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
