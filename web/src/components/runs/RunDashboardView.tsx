import { useEffect, useState } from 'react';
import type {
  RunControlAction,
  RunDetail,
  RunOperatorAvailability,
  RunSummary,
} from '../../types';
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
  runNotice: string | null;
  operatorAvailability: RunOperatorAvailability | null;
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
    runNotice,
    operatorAvailability,
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
    <div className="flex flex-col h-full bg-bbs-black text-bbs-lightgray font-mono animate-chat-enter">
      <RunDashboardHeader
        browserNotificationsEnabled={browserNotificationsEnabled}
        notificationPermission={notificationPermission}
        onRefresh={onRefresh}
        onEnableBrowserNotifications={onEnableBrowserNotifications}
      />

      <div className="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-[20rem,1fr]">
        <aside className="border-b xl:border-b-0 xl:border-r border-bbs-border overflow-y-auto px-3 py-3 md:px-4 md:py-4 bg-bbs-dark/40 space-y-3">
          <RunSidebar
            runs={runs}
            selectedSessionId={selectedSessionId}
            operatorAvailability={operatorAvailability}
            onSelectRun={onSelectRun}
            onInspect={onInspect}
          />
        </aside>

        <section className="min-h-0 overflow-y-auto px-3 py-4 md:px-5 md:py-5 bg-bbs-black">
          <RunDashboardContent
            selectedRun={selectedRun}
            selectedSessionId={selectedSessionId}
            loading={loading}
            error={error}
            runNotice={runNotice}
            operatorAvailability={operatorAvailability}
            editor={editor}
            onEditorChange={updateEditor}
            onControl={onControl}
          />
        </section>
      </div>
    </div>
  );
}
