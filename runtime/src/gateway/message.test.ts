import { describe, it, expect } from 'vitest';
import {
  createGatewayMessage,
  createOutboundMessage,
  validateGatewayMessage,
  validateOutboundMessage,
  validateAttachment,
  type CreateGatewayMessageParams,
  type GatewayMessage,
  type MessageAttachment,
} from './message.js';

// ============================================================================
// Test helpers
// ============================================================================

function makeParams(overrides?: Partial<CreateGatewayMessageParams>): CreateGatewayMessageParams {
  return {
    channel: 'telegram',
    senderId: 'user-123',
    senderName: 'Alice',
    sessionId: 'session-abc',
    content: 'Hello world',
    scope: 'dm',
    ...overrides,
  };
}

function makeMessage(overrides?: Partial<GatewayMessage>): GatewayMessage {
  return {
    id: 'test-id',
    channel: 'telegram',
    senderId: 'user-123',
    senderName: 'Alice',
    sessionId: 'session-abc',
    content: 'Hello world',
    timestamp: Date.now(),
    scope: 'dm',
    ...overrides,
  };
}

function makeAttachment(overrides?: Partial<MessageAttachment>): MessageAttachment {
  return {
    type: 'image',
    mimeType: 'image/png',
    ...overrides,
  };
}

// ============================================================================
// createGatewayMessage
// ============================================================================

describe('createGatewayMessage', () => {
  it('generates unique UUID per call', () => {
    const a = createGatewayMessage(makeParams());
    const b = createGatewayMessage(makeParams());
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('sets timestamp to current time', () => {
    const before = Date.now();
    const msg = createGatewayMessage(makeParams());
    const after = Date.now();
    expect(msg.timestamp).toBeGreaterThanOrEqual(before);
    expect(msg.timestamp).toBeLessThanOrEqual(after);
  });

  it('preserves all provided fields', () => {
    const params = makeParams({
      identityId: 'id-xyz',
      attachments: [makeAttachment()],
      metadata: { key: 'value' },
      scope: 'group',
    });
    const msg = createGatewayMessage(params);
    expect(msg.channel).toBe('telegram');
    expect(msg.senderId).toBe('user-123');
    expect(msg.senderName).toBe('Alice');
    expect(msg.sessionId).toBe('session-abc');
    expect(msg.content).toBe('Hello world');
    expect(msg.identityId).toBe('id-xyz');
    expect(msg.attachments).toHaveLength(1);
    expect(msg.metadata).toEqual({ key: 'value' });
    expect(msg.scope).toBe('group');
  });
});

// ============================================================================
// validateGatewayMessage
// ============================================================================

describe('validateGatewayMessage', () => {
  it('returns valid for a well-formed message', () => {
    const result = validateGatewayMessage(makeMessage());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns false for missing channel', () => {
    const msg = makeMessage();
    const { channel: _, ...rest } = msg;
    const result = validateGatewayMessage(rest);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('channel must be a non-empty string');
  });

  it('returns false for missing senderId', () => {
    const msg = makeMessage();
    const { senderId: _, ...rest } = msg;
    const result = validateGatewayMessage(rest);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('senderId must be a non-empty string');
  });

  it('returns false for missing content', () => {
    const msg = makeMessage();
    const { content: _, ...rest } = msg;
    const result = validateGatewayMessage(rest);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('content must be a string');
  });

  it('returns false for invalid scope', () => {
    const result = validateGatewayMessage(makeMessage({ scope: 'invalid' as never }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('scope must be one of'))).toBe(true);
  });

  it('accepts empty string content (voice-only messages)', () => {
    const result = validateGatewayMessage(makeMessage({ content: '' }));
    expect(result.valid).toBe(true);
  });

  it('accepts empty attachments array', () => {
    const result = validateGatewayMessage(makeMessage({ attachments: [] }));
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ============================================================================
// validateAttachment
// ============================================================================

describe('validateAttachment', () => {
  it('rejects exceeding maxSizeBytes', () => {
    const att = makeAttachment({ sizeBytes: 2_000_000 });
    const result = validateAttachment(att, 1_000_000);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('exceeds maximum'))).toBe(true);
  });

  it('accepts within size limit', () => {
    const att = makeAttachment({ sizeBytes: 500_000 });
    const result = validateAttachment(att, 1_000_000);
    expect(result.valid).toBe(true);
  });

  it('rejects empty MIME type', () => {
    const result = validateAttachment({ type: 'image', mimeType: '' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('mimeType'))).toBe(true);
  });

  it('accepts attachment with both url and data', () => {
    const att = makeAttachment({
      url: 'https://example.com/img.png',
      data: new Uint8Array([1, 2, 3]),
    });
    const result = validateAttachment(att);
    expect(result.valid).toBe(true);
  });
});

// ============================================================================
// createOutboundMessage
// ============================================================================

describe('createOutboundMessage', () => {
  it('creates valid outbound message', () => {
    const msg = createOutboundMessage({
      sessionId: 'session-abc',
      content: 'Response text',
      isPartial: false,
      tts: true,
    });
    expect(msg.sessionId).toBe('session-abc');
    expect(msg.content).toBe('Response text');
    expect(msg.isPartial).toBe(false);
    expect(msg.tts).toBe(true);
  });

  it('throws on missing sessionId', () => {
    expect(() => createOutboundMessage({ sessionId: '', content: 'hi' })).toThrow(TypeError);
  });

  it('throws on missing content', () => {
    expect(() =>
      createOutboundMessage({ sessionId: 'ses', content: undefined } as never),
    ).toThrow(TypeError);
  });
});

// ============================================================================
// validateOutboundMessage
// ============================================================================

describe('validateOutboundMessage', () => {
  it('returns valid for well-formed outbound message', () => {
    const result = validateOutboundMessage({ sessionId: 'ses', content: 'hi' });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects non-object input', () => {
    const result = validateOutboundMessage(null);
    expect(result.valid).toBe(false);
  });

  it('rejects empty sessionId', () => {
    const result = validateOutboundMessage({ sessionId: '', content: 'hi' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('sessionId must be a non-empty string');
  });
});

// ============================================================================
// Type-level readonly doc test
// ============================================================================

describe('GatewayMessage readonly properties', () => {
  it('readonly fields are enforced at type level', () => {
    const msg = makeMessage();
    // Runtime shallow copy works — readonly is compile-time only
    const copy = { ...msg, content: 'modified' };
    expect(copy.content).toBe('modified');
    expect(msg.content).toBe('Hello world');
  });
});
