import { describe, expect, it } from 'vitest';
import { validateToolCall } from './types.js';

describe('validateToolCall', () => {
  it('accepts a valid tool call payload', () => {
    const result = validateToolCall({
      id: 'call_1',
      name: 'lookup',
      arguments: '{"q":"hello"}',
    });

    expect(result).toEqual({
      id: 'call_1',
      name: 'lookup',
      arguments: '{"q":"hello"}',
    });
  });

  it('rejects missing ids', () => {
    expect(
      validateToolCall({
        name: 'lookup',
        arguments: '{}',
      }),
    ).toBeNull();
  });

  it('rejects empty names', () => {
    expect(
      validateToolCall({
        id: 'call_1',
        name: '',
        arguments: '{}',
      }),
    ).toBeNull();
  });

  it('rejects non-JSON argument strings', () => {
    expect(
      validateToolCall({
        id: 'call_1',
        name: 'lookup',
        arguments: '{bad-json',
      }),
    ).toBeNull();
  });
});
