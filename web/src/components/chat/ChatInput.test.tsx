import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChatInput } from './ChatInput';

afterEach(() => {
  cleanup();
});

describe('ChatInput', () => {
  it('sends text messages and clears input', () => {
    const onSend = vi.fn();
    const { container } = render(<ChatInput onSend={onSend} />);

    const input = container.querySelector(
      'textarea[placeholder="Message to AgenC..."]',
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'hello from tests' } });

    const sendButton = input.closest('div')?.parentElement?.querySelector(
      'button[title="Send message"]',
    ) as HTMLButtonElement;
    fireEvent.click(sendButton);

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('hello from tests', undefined);
    expect((input as HTMLTextAreaElement).value).toBe('');
  });

  it('sends on Enter without shift and ignores shift+Enter submit path', () => {
    const onSend = vi.fn();
    const { container } = render(<ChatInput onSend={onSend} />);

    const input = container.querySelector(
      'textarea[placeholder="Message to AgenC..."]',
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'line one' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', shiftKey: true });

    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', shiftKey: false });
    expect(onSend).toHaveBeenCalledWith('line one', undefined);
  });

  it('attaches files and sends them with the message', async () => {
    const onSend = vi.fn();
    const { container } = render(<ChatInput onSend={onSend} />);

    const input = container.querySelector(
      'textarea[placeholder="Message to AgenC..."]',
    ) as HTMLTextAreaElement;
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

    const files = [
      new File(['alpha'], 'alpha.txt', { type: 'text/plain' }),
      new File(['beta'], 'beta.txt', { type: 'text/plain' }),
    ];

    fireEvent.change(fileInput, { target: { files } });
    fireEvent.change(input, { target: { value: 'with files' } });

    const sendButton = input.closest('div')?.parentElement?.querySelector(
      'button[title="Send message"]',
    ) as HTMLButtonElement;
    fireEvent.click(sendButton);

    expect(onSend).toHaveBeenCalledTimes(1);
    const [content, attachments] = onSend.mock.calls[0];
    expect(content).toBe('with files');
    expect(Array.isArray(attachments)).toBe(true);
    expect(attachments).toHaveLength(2);
  });

  it('shows slash command menu when typing "/"', () => {
    const onSend = vi.fn();
    const { container } = render(<ChatInput onSend={onSend} />);
    const input = container.querySelector(
      'textarea[placeholder="Message to AgenC..."]',
    ) as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: '/' } });

    expect(screen.getByText('Commands')).toBeTruthy();
    expect(screen.getByText('/help')).toBeTruthy();
    expect(screen.getByText('/status')).toBeTruthy();
  });

  it('filters slash commands by typed prefix', () => {
    const onSend = vi.fn();
    const { container } = render(<ChatInput onSend={onSend} />);
    const input = container.querySelector(
      'textarea[placeholder="Message to AgenC..."]',
    ) as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: '/res' } });

    expect(screen.queryByTestId('slash-command-help')).toBeNull();
    expect(screen.getByTestId('slash-command-reset')).toBeTruthy();
    expect(screen.getByTestId('slash-command-restart')).toBeTruthy();
    expect(screen.getByTestId('slash-command-resume')).toBeTruthy();
  });

  it('selects highlighted slash command with Enter and sends it', () => {
    const onSend = vi.fn();
    const { container } = render(<ChatInput onSend={onSend} />);
    const input = container.querySelector(
      'textarea[placeholder="Message to AgenC..."]',
    ) as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: '/res' } });
    fireEvent.keyDown(input, { key: 'ArrowDown', code: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('/restart', undefined);
  });
});
