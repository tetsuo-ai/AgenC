import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_RUN_EDITOR_STATE,
  RunDashboardContent,
  RunSidebar,
} from './RunDashboardSections';

describe('Run dashboard empty states', () => {
  it('shows disabled capability state in the sidebar', () => {
    render(
      <RunSidebar
        runs={[]}
        selectedSessionId={null}
        operatorAvailability={{
          enabled: false,
          operatorAvailable: false,
          inspectAvailable: false,
          controlAvailable: false,
          disabledCode: 'background_runs_feature_disabled',
          disabledReason:
            'Durable background runs are disabled in autonomy feature flags.',
        }}
        onSelectRun={vi.fn()}
        onInspect={vi.fn()}
      />,
    );

    expect(screen.getByText('[DISABLED] durable background runs are off')).toBeTruthy();
    expect(
      screen.getByText('Durable background runs are disabled in autonomy feature flags.'),
    ).toBeTruthy();
  });

  it('shows informative no-run notice without rendering an error card', () => {
    render(
      <RunDashboardContent
        selectedRun={null}
        selectedSessionId="session-run-1"
        loading={false}
        error={null}
        runNotice='No active durable background run for session "session-run-1"'
        operatorAvailability={{
          enabled: true,
          operatorAvailable: true,
          inspectAvailable: true,
          controlAvailable: true,
        }}
        editor={EMPTY_RUN_EDITOR_STATE}
        onEditorChange={vi.fn()}
        onControl={vi.fn()}
      />,
    );

    expect(
      screen.getByText('[INFO] No active durable background run for session "session-run-1"'),
    ).toBeTruthy();
  });
});
