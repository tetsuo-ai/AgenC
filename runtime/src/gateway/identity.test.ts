import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdentityResolver } from './identity.js';
import type { IdentityLink } from './identity.js';

describe('IdentityResolver', () => {
  let resolver: IdentityResolver;

  beforeEach(() => {
    resolver = new IdentityResolver();
  });

  // ---- register ----

  it('register creates a new identity for an unlinked account', () => {
    const identity = resolver.register('telegram', 'user123', 'Alice');

    expect(identity.identityId).toBeDefined();
    expect(identity.accounts).toHaveLength(1);
    expect(identity.accounts[0].channel).toBe('telegram');
    expect(identity.accounts[0].senderId).toBe('user123');
    expect(identity.accounts[0].displayName).toBe('Alice');
    expect(identity.createdAt).toBeGreaterThan(0);
    expect(resolver.identityCount).toBe(1);
  });

  it('register returns existing identity if account is already linked', () => {
    const first = resolver.register('telegram', 'user123', 'Alice');
    const second = resolver.register('telegram', 'user123', 'Alice');

    expect(second.identityId).toBe(first.identityId);
    expect(resolver.identityCount).toBe(1);
  });

  // ---- resolve ----

  it('resolve returns identityId for a registered account', () => {
    const identity = resolver.register('discord', 'user456', 'Bob');
    const resolved = resolver.resolve('discord', 'user456');

    expect(resolved).toBe(identity.identityId);
  });

  it('resolve returns undefined for an unregistered account', () => {
    expect(resolver.resolve('telegram', 'unknown')).toBeUndefined();
  });

  // ---- getIdentity / getIdentityByAccount ----

  it('getIdentity returns identity by ID', () => {
    const identity = resolver.register('telegram', 'user1', 'Alice');
    const found = resolver.getIdentity(identity.identityId);

    expect(found).toBeDefined();
    expect(found!.identityId).toBe(identity.identityId);
  });

  it('getIdentityByAccount returns identity for a linked account', () => {
    resolver.register('telegram', 'user1', 'Alice');
    const found = resolver.getIdentityByAccount('telegram', 'user1');

    expect(found).toBeDefined();
    expect(found!.accounts[0].senderId).toBe('user1');
  });

  it('getIdentityByAccount returns undefined for unlinked account', () => {
    expect(resolver.getIdentityByAccount('telegram', 'nope')).toBeUndefined();
  });

  // ---- initLink + completeLink ----

  it('initLink returns a 6-character uppercase code', () => {
    resolver.register('telegram', 'user1', 'Alice');
    const code = resolver.initLink('telegram', 'user1', 'Alice');

    expect(code).toHaveLength(6);
    expect(code).toBe(code.toUpperCase());
  });

  it('initLink auto-registers account if not already registered', () => {
    const code = resolver.initLink('telegram', 'user1', 'Alice');

    expect(code).toBeDefined();
    expect(resolver.identityCount).toBe(1);
    expect(resolver.resolve('telegram', 'user1')).toBeDefined();
  });

  it('completeLink merges two accounts into one identity', () => {
    resolver.register('telegram', 'user1', 'Alice');
    const code = resolver.initLink('telegram', 'user1', 'Alice');

    const merged = resolver.completeLink(code, 'discord', 'user2', 'Alice_Discord');

    expect(merged).not.toBeNull();
    expect(merged!.accounts).toHaveLength(2);
    expect(merged!.accounts.some((a) => a.channel === 'telegram')).toBe(true);
    expect(merged!.accounts.some((a) => a.channel === 'discord')).toBe(true);

    // Both accounts resolve to the same identity
    const id1 = resolver.resolve('telegram', 'user1');
    const id2 = resolver.resolve('discord', 'user2');
    expect(id1).toBe(id2);
  });

  it('completeLink returns null for invalid code', () => {
    const result = resolver.completeLink('BADCODE', 'discord', 'user2', 'Bob');
    expect(result).toBeNull();
  });

  it('completeLink returns null for expired code', () => {
    const resolver = new IdentityResolver({ pendingLinkTtlMs: 1 });
    resolver.register('telegram', 'user1', 'Alice');
    const code = resolver.initLink('telegram', 'user1', 'Alice');

    // Force expiration by overriding Date.now
    const originalNow = Date.now;
    Date.now = () => originalNow() + 1000;

    const result = resolver.completeLink(code, 'discord', 'user2', 'Bob');
    expect(result).toBeNull();

    Date.now = originalNow;
  });

  it('completeLink prevents self-linking (same channel + sender)', () => {
    resolver.register('telegram', 'user1', 'Alice');
    const code = resolver.initLink('telegram', 'user1', 'Alice');

    const result = resolver.completeLink(code, 'telegram', 'user1', 'Alice');
    expect(result).toBeNull();
  });

  it('completeLink merges identities when completing account already has identity', () => {
    // Register two separate identities
    resolver.register('telegram', 'user1', 'Alice');
    resolver.register('discord', 'user2', 'Alice_Discord');

    const id1Before = resolver.resolve('telegram', 'user1');
    const id2Before = resolver.resolve('discord', 'user2');
    expect(id1Before).not.toBe(id2Before);

    // Link them
    const code = resolver.initLink('telegram', 'user1', 'Alice');
    const merged = resolver.completeLink(code, 'discord', 'user2', 'Alice_Discord');

    expect(merged).not.toBeNull();
    expect(merged!.accounts).toHaveLength(2);

    // Both now resolve to the same identity (the initiator's)
    const id1After = resolver.resolve('telegram', 'user1');
    const id2After = resolver.resolve('discord', 'user2');
    expect(id1After).toBe(id2After);
    expect(id1After).toBe(id1Before);

    // Old identity removed
    expect(resolver.identityCount).toBe(1);
  });

  it('completeLink returns existing identity when already linked to same', () => {
    resolver.register('telegram', 'user1', 'Alice');
    const code1 = resolver.initLink('telegram', 'user1', 'Alice');
    resolver.completeLink(code1, 'discord', 'user2', 'Alice_Discord');

    // Try linking again
    const code2 = resolver.initLink('telegram', 'user1', 'Alice');
    const result = resolver.completeLink(code2, 'discord', 'user2', 'Alice_Discord');

    expect(result).not.toBeNull();
    expect(result!.accounts).toHaveLength(2);
  });

  // ---- unlink ----

  it('unlink removes an account from its identity', () => {
    resolver.register('telegram', 'user1', 'Alice');
    const code = resolver.initLink('telegram', 'user1', 'Alice');
    resolver.completeLink(code, 'discord', 'user2', 'Alice_Discord');

    const unlinked = resolver.unlink('discord', 'user2');
    expect(unlinked).toBe(true);
    expect(resolver.resolve('discord', 'user2')).toBeUndefined();

    // Telegram account still linked
    const identity = resolver.getIdentityByAccount('telegram', 'user1');
    expect(identity).toBeDefined();
    expect(identity!.accounts).toHaveLength(1);
  });

  it('unlink removes identity entirely when last account is unlinked', () => {
    resolver.register('telegram', 'user1', 'Alice');

    const unlinked = resolver.unlink('telegram', 'user1');
    expect(unlinked).toBe(true);
    expect(resolver.identityCount).toBe(0);
  });

  it('unlink returns false for unregistered account', () => {
    expect(resolver.unlink('telegram', 'nonexistent')).toBe(false);
  });

  // ---- setAgentPubkey ----

  it('setAgentPubkey sets on-chain pubkey for identity', () => {
    const identity = resolver.register('telegram', 'user1', 'Alice');
    const result = resolver.setAgentPubkey(identity.identityId, 'SomeSolanaPublicKey123');

    expect(result).toBe(true);
    const updated = resolver.getIdentity(identity.identityId);
    expect(updated!.agentPubkey).toBe('SomeSolanaPublicKey123');
  });

  it('setAgentPubkey returns false for unknown identity', () => {
    expect(resolver.setAgentPubkey('nonexistent', 'key')).toBe(false);
  });

  // ---- setPreferences ----

  it('setPreferences merges preferences for identity', () => {
    const identity = resolver.register('telegram', 'user1', 'Alice');
    resolver.setPreferences(identity.identityId, { theme: 'dark' });
    resolver.setPreferences(identity.identityId, { language: 'en' });

    const updated = resolver.getIdentity(identity.identityId);
    expect(updated!.preferences).toEqual({ theme: 'dark', language: 'en' });
  });

  it('setPreferences returns false for unknown identity', () => {
    expect(resolver.setPreferences('nonexistent', {})).toBe(false);
  });

  // ---- purgeExpired ----

  it('purgeExpired removes expired pending links', () => {
    const resolver = new IdentityResolver({ pendingLinkTtlMs: 1 });
    resolver.register('telegram', 'user1', 'Alice');
    resolver.initLink('telegram', 'user1', 'Alice');

    // Force expiration
    const originalNow = Date.now;
    Date.now = () => originalNow() + 1000;

    const purged = resolver.purgeExpired();
    expect(purged).toBe(1);
    expect(resolver.pendingCount).toBe(0);

    Date.now = originalNow;
  });

  it('purgeExpired does not remove active links', () => {
    resolver.register('telegram', 'user1', 'Alice');
    resolver.initLink('telegram', 'user1', 'Alice');

    const purged = resolver.purgeExpired();
    expect(purged).toBe(0);
    expect(resolver.pendingCount).toBe(1);
  });

  // ---- listIdentities ----

  it('listIdentities returns all registered identities', () => {
    resolver.register('telegram', 'user1', 'Alice');
    resolver.register('discord', 'user2', 'Bob');

    const list = resolver.listIdentities();
    expect(list).toHaveLength(2);
  });

  // ---- multi-channel linking (3+ channels) ----

  it('supports linking 3+ channels to a single identity', () => {
    resolver.register('telegram', 'user1', 'Alice');

    const code1 = resolver.initLink('telegram', 'user1', 'Alice');
    resolver.completeLink(code1, 'discord', 'user2', 'Alice_Discord');

    const code2 = resolver.initLink('telegram', 'user1', 'Alice');
    resolver.completeLink(code2, 'slack', 'user3', 'Alice_Slack');

    const identity = resolver.getIdentityByAccount('telegram', 'user1');
    expect(identity!.accounts).toHaveLength(3);

    // All three resolve to same identity
    const id1 = resolver.resolve('telegram', 'user1');
    const id2 = resolver.resolve('discord', 'user2');
    const id3 = resolver.resolve('slack', 'user3');
    expect(id1).toBe(id2);
    expect(id2).toBe(id3);
  });
});
