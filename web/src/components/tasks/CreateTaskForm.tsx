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
        className="w-full px-4 py-2.5 border border-dashed border-tetsuo-600 rounded-lg text-sm text-tetsuo-400 hover:border-accent hover:text-accent transition-colors"
      >
        + Create Task
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 p-4 bg-tetsuo-800 rounded-lg border border-tetsuo-700">
      <div>
        <label className="text-xs text-tetsuo-500 block mb-1">Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full bg-tetsuo-900 text-tetsuo-100 border border-tetsuo-600 rounded px-3 py-2 text-sm resize-none focus:outline-none focus:border-accent"
          rows={3}
          placeholder="Task description..."
        />
      </div>
      <div>
        <label className="text-xs text-tetsuo-500 block mb-1">Reward (lamports)</label>
        <input
          type="number"
          value={reward}
          onChange={(e) => setReward(e.target.value)}
          className="w-full bg-tetsuo-900 text-tetsuo-100 border border-tetsuo-600 rounded px-3 py-2 text-sm focus:outline-none focus:border-accent"
          placeholder="0"
        />
      </div>
      <div className="flex gap-2">
        <button
          type="submit"
          className="px-4 py-2 bg-accent text-white rounded text-sm font-medium hover:bg-accent-dark transition-colors"
        >
          Create
        </button>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="px-4 py-2 text-tetsuo-400 text-sm hover:text-tetsuo-200 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
