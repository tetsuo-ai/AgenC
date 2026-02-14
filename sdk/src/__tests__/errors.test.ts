import { describe, expect, it } from 'vitest';
import { decodeAnchorError, decodeError } from '../errors';

describe('errors', () => {
  it('decodeError returns known coordination errors', () => {
    const decoded = decodeError(6000);
    expect(decoded).not.toBeNull();
    expect(decoded?.name).toBe('AgentAlreadyRegistered');
    expect(decoded?.category).toBe('agent');
  });

  it('decodeError returns null for unknown code', () => {
    expect(decodeError(9999)).toBeNull();
  });

  it('decodeAnchorError handles direct Anchor errorCode shape', () => {
    const decoded = decodeAnchorError({ errorCode: { number: 6001 } });
    expect(decoded?.name).toBe('AgentNotFound');
  });

  it('decodeAnchorError handles nested Anchor error shape', () => {
    const decoded = decodeAnchorError({ error: { errorCode: { number: 6014 } } });
    expect(decoded?.name).toBe('TaskNotOpen');
  });

  it('decodeAnchorError handles log/message formats', () => {
    const fromLogs = decodeAnchorError({ logs: ['Program log: Error Number: 6050'] });
    expect(fromLogs?.name).toBe('DisputeNotActive');

    const fromHex = decodeAnchorError({ message: 'custom program error: 0x1770' });
    expect(fromHex?.name).toBe('AgentAlreadyRegistered');
  });
});
