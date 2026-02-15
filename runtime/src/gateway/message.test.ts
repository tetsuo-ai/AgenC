import { describe, it, expect } from 'vitest';
import {
  createGatewayMessage,
  validateGatewayMessage,
  validateAttachment,
  type GatewayMessage,
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

  it('returns valid for valid message', () => {
    const result = validateGatewayMessage(validMessage());
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('returns reason for missing channel', () => {
    const msg = { ...validMessage(), channel: '' };
    const result = validateGatewayMessage(msg);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('channel');
  });

  it('returns reason for missing senderId', () => {
    const msg = { ...validMessage(), senderId: '' };
    const result = validateGatewayMessage(msg);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('senderId');
  });

  it('returns reason for missing content (non-string)', () => {
    const msg = { ...validMessage() } as Record<string, unknown>;
    delete msg.content;
    const result = validateGatewayMessage(msg);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('content');
  });

  it('returns reason for invalid scope value', () => {
    const msg = { ...validMessage(), scope: 'broadcast' };
    const result = validateGatewayMessage(msg);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('scope');
  });

  it('returns reason for null input', () => {
    const result = validateGatewayMessage(null);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('object');
  });

  it('returns reason for non-object input', () => {
    const result = validateGatewayMessage('string');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('object');
  });

  it('returns reason for missing sessionId', () => {
    const msg = { ...validMessage(), sessionId: '' };
    const result = validateGatewayMessage(msg);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('sessionId');
  });

  it('returns reason for missing senderName', () => {
    const msg = { ...validMessage(), senderName: '' };
    const result = validateGatewayMessage(msg);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('senderName');
  });

  it('accepts message with empty content string', () => {
    const msg = { ...validMessage(), content: '' };
    const result = validateGatewayMessage(msg);
    expect(result.valid).toBe(true);
  });

  it('accepts message with valid attachments', () => {
    const msg = {
      ...validMessage(),
      attachments: [{ type: 'image', mimeType: 'image/png' }],
    };
    const result = validateGatewayMessage(msg);
    expect(result.valid).toBe(true);
  });

  it('returns reason for attachment with invalid type', () => {
    const msg = {
      ...validMessage(),
      attachments: [{ type: 'gif', mimeType: 'image/gif' }],
    };
    const result = validateGatewayMessage(msg);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('attachments[0]');
  });

  it('accepts message with empty attachments array', () => {
    const msg = { ...validMessage(), attachments: [] };
    const result = validateGatewayMessage(msg);
    expect(result.valid).toBe(true);
  });

  it('accepts all valid scope values', () => {
    for (const scope of ['dm', 'group', 'thread']) {
      const msg = { ...validMessage(), scope };
      const result = validateGatewayMessage(msg);
      expect(result.valid).toBe(true);
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
