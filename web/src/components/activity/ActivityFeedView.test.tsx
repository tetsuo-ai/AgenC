import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityFeedView } from './ActivityFeedView';
import type { ActivityEvent } from '../../types';

describe('ActivityFeedView', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the empty state when there are no events', () => {
    render(<ActivityFeedView events={[]} onClear={vi.fn()} />);

    expect(screen.getByText('[no events captured]')).toBeDefined();
  });

  it('keeps following new events when the user is already near the bottom', () => {
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    const initialEvents: ActivityEvent[] = [
      { eventType: 'chat.inbound', data: { description: 'first' }, timestamp: 1 },
    ];
    const nextEvents: ActivityEvent[] = [
      ...initialEvents,
      { eventType: 'chat.response', data: { description: 'second' }, timestamp: 2 },
    ];

    const view = render(<ActivityFeedView events={initialEvents} onClear={vi.fn()} />);
    const container = view.getByTestId('activity-feed-scroll-container');

    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 300 });
    Object.defineProperty(container, 'scrollTop', { configurable: true, value: 640 });

    scrollSpy.mockClear();
    fireEvent.scroll(container);
    view.rerender(<ActivityFeedView events={nextEvents} onClear={vi.fn()} />);

    expect(scrollSpy).toHaveBeenCalledTimes(1);
  });

  it('does not yank the user back down when they have scrolled up', () => {
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    const initialEvents: ActivityEvent[] = [
      { eventType: 'chat.inbound', data: { description: 'first' }, timestamp: 1 },
    ];
    const nextEvents: ActivityEvent[] = [
      ...initialEvents,
      { eventType: 'chat.response', data: { description: 'second' }, timestamp: 2 },
    ];

    const view = render(<ActivityFeedView events={initialEvents} onClear={vi.fn()} />);
    const container = view.getByTestId('activity-feed-scroll-container');

    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 300 });
    Object.defineProperty(container, 'scrollTop', { configurable: true, value: 120 });

    scrollSpy.mockClear();
    fireEvent.scroll(container);
    view.rerender(<ActivityFeedView events={nextEvents} onClear={vi.fn()} />);

    expect(scrollSpy).not.toHaveBeenCalled();
  });
});
