import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSkills } from './useSkills';
import type { WSMessage } from '../types';

type UseSkillsHook = ReturnType<typeof useSkills> & { handleMessage: (msg: WSMessage) => void };

describe('useSkills', () => {
  it('refreshes and toggles skills', () => {
    const send = vi.fn();
    const { result } = renderHook(() => useSkills({ send }));

    act(() => {
      result.current.refresh();
      result.current.toggle('desk', true);
    });

    expect(send).toHaveBeenNthCalledWith(1, { type: 'skills.list' });
    expect(send).toHaveBeenNthCalledWith(2, { type: 'skills.toggle', payload: { skillName: 'desk', enabled: true } });
  });

  it('handles skills.list response', () => {
    const send = vi.fn();
    const { result } = renderHook(() => useSkills({ send }));

    act(() => {
      (result.current as UseSkillsHook).handleMessage({
        type: 'skills.list',
        payload: [{ name: 'math', description: 'Math', enabled: true }],
      });
    });

    expect(result.current.skills).toEqual([{ name: 'math', description: 'Math', enabled: true } as never]);
  });
});
