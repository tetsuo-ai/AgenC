import { useCallback, useState } from 'react';

interface CreateTaskFormProps {
  onCreate: (params: Record<string, unknown>) => void;
}

export function CreateTaskForm({ onCreate }: CreateTaskFormProps) {
  const [description, setDescription] = useState('');
  const [reward, setReward] = useState('');
  const [expanded, setExpanded] = useState(false);

  const handleSubmit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
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
        type="button"
        onClick={() => setExpanded(true)}
        className="w-full border border-dashed border-bbs-border bg-bbs-dark px-4 py-4 text-xs uppercase tracking-[0.16em] text-bbs-gray transition-colors hover:border-bbs-purple-dim hover:text-bbs-white"
      >
        [new task]
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4 border border-bbs-purple-dim bg-bbs-surface px-4 py-4 animate-panel-enter"
    >
      <div className="flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-bbs-gray">
        <span className="text-bbs-purple">TASK&gt;</span>
        <span>compose settlement request</span>
      </div>

      <div>
        <label className="mb-2 block text-[10px] uppercase tracking-[0.16em] text-bbs-gray">Description</label>
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={4}
          autoFocus
          placeholder="describe the task expected from the agent"
          className="w-full resize-none border border-bbs-border bg-bbs-dark px-3 py-3 text-sm text-bbs-white outline-none transition-colors placeholder:text-bbs-gray focus:border-bbs-purple-dim"
        />
      </div>

      <div>
        <label className="mb-2 block text-[10px] uppercase tracking-[0.16em] text-bbs-gray">Reward (SOL)</label>
        <input
          type="number"
          value={reward}
          onChange={(event) => setReward(event.target.value)}
          placeholder="0"
          className="w-full border border-bbs-border bg-bbs-dark px-3 py-3 text-sm text-bbs-white outline-none transition-colors placeholder:text-bbs-gray focus:border-bbs-purple-dim"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1 text-xs uppercase tracking-[0.14em]">
        <button
          type="submit"
          className="border border-bbs-green/40 bg-bbs-dark px-4 py-2 text-bbs-green transition-colors hover:text-bbs-white"
        >
          [create]
        </button>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="border border-bbs-border bg-bbs-dark px-4 py-2 text-bbs-gray transition-colors hover:border-bbs-purple-dim hover:text-bbs-white"
        >
          [cancel]
        </button>
      </div>
    </form>
  );
}
