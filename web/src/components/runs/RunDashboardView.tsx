import { useEffect, useState } from 'react';
import type { RunControlAction, RunDetail, RunSummary } from '../../types';
import {
  buildRunEditorState,
  EMPTY_RUN_EDITOR_STATE,
  RunDashboardContent,
  RunDashboardHeader,
  RunEditorState,
  RunSidebar,
} from './RunDashboardSections.js';

interface RunDashboardViewProps {
  runs: RunSummary[];
  selectedRun: RunDetail | null;
  selectedSessionId: string | null;
  loading: boolean;
  error: string | null;
  browserNotificationsEnabled: boolean;
  notificationPermission: NotificationPermission | 'unsupported';
  onSelectRun: (sessionId: string) => void;
  onRefresh: () => void;
  onInspect: (sessionId?: string) => void;
  onControl: (action: RunControlAction) => void;
  onEnableBrowserNotifications: () => Promise<void>;
}

export function RunDashboardView(props: RunDashboardViewProps) {
  const {
    runs,
    selectedRun,
    selectedSessionId,
    loading,
    error,
    browserNotificationsEnabled,
    notificationPermission,
    onSelectRun,
    onRefresh,
    onInspect,
    onControl,
    onEnableBrowserNotifications,
  } = props;

  const [editor, setEditor] = useState<RunEditorState>(EMPTY_RUN_EDITOR_STATE);

  useEffect(() => {
    setEditor(buildRunEditorState(selectedRun));
  }, [selectedRun]);

  const updateEditor = <K extends keyof RunEditorState>(
    key: K,
    value: RunEditorState[K],
  ) => {
    setEditor((current) => ({ ...current, [key]: value }));
  };

  return (
    <div className="flex flex-col h-full">
      <RunDashboardHeader
        browserNotificationsEnabled={browserNotificationsEnabled}
        notificationPermission={notificationPermission}
        onRefresh={onRefresh}
        onEnableBrowserNotifications={onEnableBrowserNotifications}
      />

      <div className="flex-1 min-h-0 grid grid-cols-[20rem,1fr]">
        <aside className="border-r border-tetsuo-200 overflow-y-auto p-4 space-y-3">
          <RunSidebar
            runs={runs}
            selectedSessionId={selectedSessionId}
            onSelectRun={onSelectRun}
            onInspect={onInspect}
          />
        </aside>

        <section className="min-h-0 overflow-y-auto p-6 space-y-6">
          <RunDashboardContent
            selectedRun={selectedRun}
            selectedSessionId={selectedSessionId}
            loading={loading}
            error={error}
            editor={editor}
            onEditorChange={updateEditor}
            onControl={onControl}
          />
        </section>
      </div>
    </div>
  );
}
