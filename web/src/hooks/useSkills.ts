import { useCallback, useState } from 'react';
import type { SkillInfo, WSMessage } from '../types';

interface UseSkillsOptions {
  send: (msg: Record<string, unknown>) => void;
}

export interface UseSkillsReturn {
  skills: SkillInfo[];
  refresh: () => void;
  toggle: (skillName: string, enabled: boolean) => void;
}

export function useSkills({ send }: UseSkillsOptions): UseSkillsReturn {
  const [skills, setSkills] = useState<SkillInfo[]>([]);

  const refresh = useCallback(() => {
    send({ type: 'skills.list' });
  }, [send]);

  const toggle = useCallback((skillName: string, enabled: boolean) => {
    send({ type: 'skills.toggle', payload: { skillName, enabled } });
  }, [send]);

  const handleMessage = useCallback((msg: WSMessage) => {
    if (msg.type === 'skills.list') {
      setSkills((msg.payload as SkillInfo[]) ?? []);
    }
  }, []);

  return { skills, refresh, toggle, handleMessage } as UseSkillsReturn & { handleMessage: (msg: WSMessage) => void };
}
