import { describe, it, expect } from 'vitest';
import {
  createGatewayMessage,
  createOutboundMessage,
  validateGatewayMessage,
  validateAttachment,
  type GatewayMessage,
  type OutboundMessage,
  type MessageAttachment,
} from './message.js';

function validParams(): Omit<GatewayMessage, 'id' | 'timestamp'> {
  return {
    channel: 'telegram',
    senderId: 'user-123',
    senderName: 'Alice',
    sessionId: 'sess-abc',
    content: 'Hello agent',
    scope: 'dm',
  };
}

describe('createGatewayMessage', () => {
  it('generates unique UUID for each call', () => {
    const a = createGatewayMessage(validParams());
    const b = createGatewayMessage(validParams());
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('sets timestamp to current time', () => {
    const before = Date.now();
    const msg = createGatewayMessage(validParams());
    const after = Date.now();
    expect(msg.timestamp).toBeGreaterThanOrEqual(before);
    expect(msg.timestamp).toBeLessThanOrEqual(after);
  });

  it('preserves all provided fields', () => {
    const params = {
      ...validParams(),
      identityId: 'id-xyz',
      attachments: [
        { type: 'image' as const, mimeType: 'image/png', url: 'https://example.com/img.png' },
      ],
      metadata: { threadId: 't-1' },
    };
    const msg = createGatewayMessage(params);
    expect(msg.channel).toBe('telegram');
    expect(msg.senderId).toBe('user-123');
    expect(msg.senderName).toBe('Alice');
    expect(msg.sessionId).toBe('sess-abc');
    expect(msg.content).toBe('Hello agent');
    expect(msg.scope).toBe('dm');
    expect(msg.identityId).toBe('id-xyz');
    expect(msg.attachments).toHaveLength(1);
    expect(msg.metadata).toEqual({ threadId: 't-1' });
  });
});

describe('validateGatewayMessage', () => {
  function validMessage(): GatewayMessage {
    return {
      id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      channel: 'telegram',
      senderId: 'user-123',
      senderName: 'Alice',
      sessionId: 'sess-abc',
      content: 'Hello',
      timestamp: Date.now(),
      scope: 'dm',
    };
  }

  it('returns true for valid message', () => {
    expect(validateGatewayMessage(validMessage())).toBe(true);
  });

  it('returns false for missing channel', () => {
    const msg = { ...validMessage(), channel: '' };
    expect(validateGatewayMessage(msg)).toBe(false);
  });

  it('returns false for missing senderId', () => {
    const msg = { ...validMessage(), senderId: '' };
    expect(validateGatewayMessage(msg)).toBe(false);
  });

  it('returns false for missing content (non-string)', () => {
    const msg = { ...validMessage() } as Record<string, unknown>;
    delete msg.content;
    expect(validateGatewayMessage(msg)).toBe(false);
  });

  it('returns false for invalid scope value', () => {
    const msg = { ...validMessage(), scope: 'broadcast' };
    expect(validateGatewayMessage(msg)).toBe(false);
  });

  it('returns false for null input', () => {
    expect(validateGatewayMessage(null)).toBe(false);
  });

  it('returns false for non-object input', () => {
    expect(validateGatewayMessage('string')).toBe(false);
  });

  it('returns false for missing sessionId', () => {
    const msg = { ...validMessage(), sessionId: '' };
    expect(validateGatewayMessage(msg)).toBe(false);
  });

  it('returns false for missing senderName', () => {
    const msg = { ...validMessage(), senderName: '' };
    expect(validateGatewayMessage(msg)).toBe(false);
  });

  it('accepts message with empty content string', () => {
    const msg = { ...validMessage(), content: '' };
    expect(validateGatewayMessage(msg)).toBe(true);
  });

  it('accepts message with valid attachments', () => {
    const msg = {
      ...validMessage(),
      attachments: [{ type: 'image', mimeType: 'image/png' }],
    };
    expect(validateGatewayMessage(msg)).toBe(true);
  });

  it('returns false for attachment with invalid type', () => {
    const msg = {
      ...validMessage(),
      attachments: [{ type: 'gif', mimeType: 'image/gif' }],
    };
    expect(validateGatewayMessage(msg)).toBe(false);
  });

  it('accepts message with empty attachments array', () => {
    const msg = { ...validMessage(), attachments: [] };
    expect(validateGatewayMessage(msg)).toBe(true);
  });

  it('accepts all valid scope values', () => {
    for (const scope of ['dm', 'group', 'thread']) {
      const msg = { ...validMessage(), scope };
      expect(validateGatewayMessage(msg)).toBe(true);
    }
  });
});

describe('validateAttachment', () => {
  it('rejects attachment exceeding maxSizeBytes', () => {
    const att: MessageAttachment = {
      type: 'file',
      mimeType: 'application/pdf',
      sizeBytes: 10_000_000,
    };
    const result = validateAttachment(att, 5_000_000);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('exceeds limit');
  });

  it('accepts attachment within size limit', () => {
    const att: MessageAttachment = {
      type: 'file',
      mimeType: 'application/pdf',
      sizeBytes: 1_000,
    };
    const result = validateAttachment(att, 5_000_000);
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('rejects attachment with empty MIME type', () => {
    const att: MessageAttachment = {
      type: 'image',
      mimeType: '',
    };
    const result = validateAttachment(att);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('MIME type');
  });

  it('accepts attachment with both url and data', () => {
    const att: MessageAttachment = {
      type: 'image',
      mimeType: 'image/png',
      url: 'https://example.com/img.png',
      data: new Uint8Array([1, 2, 3]),
    };
    const result = validateAttachment(att);
    expect(result.valid).toBe(true);
  });

  it('accepts attachment without sizeBytes when maxSizeBytes is set', () => {
    const att: MessageAttachment = {
      type: 'voice',
      mimeType: 'audio/ogg',
    };
    const result = validateAttachment(att, 5_000_000);
    expect(result.valid).toBe(true);
  });
});

describe('createOutboundMessage', () => {
  it('creates valid outbound message', () => {
    const params: OutboundMessage = {
      sessionId: 'sess-abc',
      content: 'Hello user',
    };
    const msg = createOutboundMessage(params);
    expect(msg.sessionId).toBe('sess-abc');
    expect(msg.content).toBe('Hello user');
  });

  it('preserves optional fields', () => {
    const params: OutboundMessage = {
      sessionId: 'sess-abc',
      content: 'Reply',
      isPartial: true,
      tts: true,
      attachments: [{ type: 'image', mimeType: 'image/jpeg' }],
    };
    const msg = createOutboundMessage(params);
    expect(msg.isPartial).toBe(true);
    expect(msg.tts).toBe(true);
    expect(msg.attachments).toHaveLength(1);
  });
});
