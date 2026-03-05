import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ToolCallCard } from './ToolCallCard';

describe('ToolCallCard', () => {
  it('renders the tool call metadata and JSON result summary', () => {
    render(
      <ToolCallCard
        toolCall={{
          toolName: 'agenc.listTasks',
          args: { status: 'open' },
          result: JSON.stringify({ status: 'ok', resultCount: 1 }),
          status: 'completed',
          durationMs: 42,
        }}
      />,
    );

    expect(screen.getByText('agenc.listTasks')).toBeDefined();
    const expandButton = screen.getByRole('button', { name: /agenc\.listTasks/i });
    fireEvent.click(expandButton);

    expect(screen.getByText('42ms')).toBeDefined();
    expect(screen.getByText('Arguments:')).toBeDefined();
    expect(screen.getByText('Result:')).toBeDefined();
    expect(screen.getByText(/"status":\s*"open"/)).toBeDefined();
    expect(screen.getByText(/"resultCount":\s*1/)).toBeDefined();
  });

  it('renders embedded image results and redacts base64 payload text', () => {
    const embedded = '### Result\n{"type":"image","data":"aGVsbG8=","mimeType":"image/png"}';

    render(
      <ToolCallCard
        toolCall={{
          toolName: 'mcp.browser.browser_take_screenshot',
          args: { type: 'png' },
          result: embedded,
          status: 'completed',
        }}
      />,
    );

    const image = screen.getByAltText('Tool result image') as HTMLImageElement;
    expect(image.src).toContain('data:image/png;base64,aGVsbG8=');
    expect(screen.getByText(/\(base64 omitted\)/)).toBeDefined();
    expect(screen.queryByText(/aGVsbG8=/)).toBeNull();
  });
});
