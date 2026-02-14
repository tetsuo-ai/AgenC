import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginCatalog, type PluginManifest } from './catalog.js';

function createManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'agenc.memory.local',
    version: '1.0.0',
    schemaVersion: 1,
    displayName: 'Local memory plugin',
    labels: ['memory'],
    permissions: [
      {
        type: 'tool_call',
        scope: 'memory.get',
        required: true,
      },
    ],
    ...overrides,
  };
}

describe('PluginCatalog', () => {
  let statePath = '';
  let stateDir = '';

  afterEach(() => {
    if (stateDir.length > 0) {
      rmSync(stateDir, { recursive: true, force: true });
      stateDir = '';
      statePath = '';
    }
  });

  function makeCatalog(overrides: { path?: string } = {}): PluginCatalog {
    const base = mkdtempSync(join(tmpdir(), 'agenc-plugin-catalog-'));
    stateDir = base;
    statePath = join(base, '.agenc', 'plugins.json');
    mkdirSync(join(base, '.agenc'), { recursive: true });
    return new PluginCatalog(overrides.path ?? statePath);
  }

  it('installs and lists an enabled plugin', () => {
    const catalog = makeCatalog();
    const result = catalog.install(createManifest({ id: 'agenc.memory.plugin-a' }), 'workspace');

    expect(result.success).toBe(true);
    const entries = catalog.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        manifest: expect.objectContaining({ id: 'agenc.memory.plugin-a', version: '1.0.0' }),
        enabled: true,
        precedence: 'workspace',
      }),
    );
  });

  it('returns failure when installing a duplicate plugin', () => {
    const catalog = makeCatalog();
    catalog.install(createManifest({ id: 'agenc.memory.plugin-b' }), 'user');
    const result = catalog.install(createManifest({ id: 'agenc.memory.plugin-b' }), 'user');

    expect(result.success).toBe(false);
    expect(result.message).toContain('already installed');
    expect(catalog.list()).toHaveLength(1);
  });

  it('disables a plugin', () => {
    const catalog = makeCatalog();
    catalog.install(createManifest({ id: 'agenc.memory.plugin-c' }), 'user');
    const result = catalog.disable('agenc.memory.plugin-c');

    expect(result.success).toBe(true);
    const plugin = catalog.list().find((entry) => entry.manifest.id === 'agenc.memory.plugin-c');
    expect(plugin).toEqual(expect.objectContaining({ enabled: false }));
  });

  it('enables a plugin after disable', () => {
    const catalog = makeCatalog();
    catalog.install(createManifest({ id: 'agenc.memory.plugin-d' }), 'user');
    catalog.disable('agenc.memory.plugin-d');
    const result = catalog.enable('agenc.memory.plugin-d');

    expect(result.success).toBe(true);
    const plugin = catalog.list().find((entry) => entry.manifest.id === 'agenc.memory.plugin-d');
    expect(plugin).toEqual(expect.objectContaining({ enabled: true }));
  });

  it('reloads manifest and updates plugin entry', () => {
    const catalog = makeCatalog();
    catalog.install(createManifest({ id: 'agenc.memory.plugin-e', version: '1.0.0' }), 'user');
    const result = catalog.reload('agenc.memory.plugin-e', createManifest({ id: 'agenc.memory.plugin-e', version: '2.0.0' }));

    expect(result.success).toBe(true);
    expect(catalog.list().find((entry) => entry.manifest.id === 'agenc.memory.plugin-e')).toEqual(
      expect.objectContaining({
        manifest: expect.objectContaining({ version: '2.0.0' }),
      }),
    );
  });

  it('sorts list by precedence', () => {
    const catalog = makeCatalog();
    catalog.install(createManifest({ id: 'agenc.memory.alpha' }), 'builtin', { slot: 'memory' });
    catalog.install(createManifest({ id: 'agenc.llm.beta' }), 'user', { slot: 'llm' });
    catalog.install(createManifest({ id: 'agenc.proof.gamma' }), 'workspace', { slot: 'proof' });

    const precedence = catalog.list().map((entry) => entry.precedence);
    expect(precedence.slice(0, 3)).toEqual(['workspace', 'user', 'builtin']);
  });

  it('blocks slot collisions at the same precedence level', () => {
    const catalog = makeCatalog();
    catalog.install(createManifest({ id: 'agenc.memory.delta' }), 'user', { slot: 'memory' });
    const result = catalog.install(createManifest({ id: 'agenc.memory.epsilon' }), 'user', { slot: 'memory' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('occupied');
  });

  it('allows a higher-precedence plugin to take over a slot', () => {
    const catalog = makeCatalog();
    catalog.install(createManifest({ id: 'agenc.memory.zeta' }), 'builtin', { slot: 'memory' });
    const result = catalog.install(createManifest({ id: 'agenc.memory.eta' }), 'workspace', { slot: 'memory' });

    expect(result.success).toBe(true);
    expect(catalog.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ manifest: expect.objectContaining({ id: 'agenc.memory.zeta' }), enabled: false }),
        expect.objectContaining({ manifest: expect.objectContaining({ id: 'agenc.memory.eta' }), enabled: true }),
      ]),
    );
  });

  it('releases slot assignment after disable', () => {
    const catalog = makeCatalog();
    catalog.install(createManifest({ id: 'agenc.memory.theta' }), 'workspace', { slot: 'memory' });
    catalog.disable('agenc.memory.theta');
    const result = catalog.install(createManifest({ id: 'agenc.memory.iota' }), 'user', { slot: 'memory' });

    expect(result.success).toBe(true);
    expect(catalog.list().find((entry) => entry.manifest.id === 'agenc.memory.iota')).toEqual(
      expect.objectContaining({ enabled: true }),
    );
    expect(catalog.list().find((entry) => entry.manifest.id === 'agenc.memory.theta')).toEqual(
      expect.objectContaining({ enabled: false }),
    );
  });

  it('prevents enable when slot becomes occupied', () => {
    const catalog = makeCatalog();
    catalog.install(createManifest({ id: 'agenc.memory.kappa' }), 'builtin', { slot: 'memory' });
    catalog.disable('agenc.memory.kappa');
    catalog.install(createManifest({ id: 'agenc.memory.lambda' }), 'user', { slot: 'memory' });

    const result = catalog.enable('agenc.memory.kappa');

    expect(result.success).toBe(false);
    expect(result.message).toContain('occupied by');
  });

  it('persists catalog state to disk', () => {
    const catalogPathCatalog = makeCatalog();
    catalogPathCatalog.install(createManifest({ id: 'agenc.memory.mu' }), 'user');
    const reopened = new PluginCatalog(statePath);
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.list()[0]).toEqual(expect.objectContaining({ manifest: expect.objectContaining({ id: 'agenc.memory.mu' }) }));
  });

  it('returns empty list for a new catalog', () => {
    const catalog = makeCatalog();
    expect(catalog.list()).toEqual([]);
  });

  it('fails to disable an unknown plugin', () => {
    const catalog = makeCatalog();
    const result = catalog.disable('agenc.memory.missing');

    expect(result.success).toBe(false);
    expect(result.message).toContain('not found');
  });

  it('resolves precedence and collisions deterministically', () => {
    const catalog = makeCatalog();
    catalog.install(createManifest({ id: 'agenc.memory.builtin' }), 'builtin', { slot: 'memory' });
    catalog.install(createManifest({ id: 'agenc.memory.user' }), 'user', { slot: 'memory' });
    catalog.install(createManifest({ id: 'agenc.llm.workspace' }), 'workspace', { slot: 'llm' });
    const takeover = catalog.install(createManifest({ id: 'agenc.memory.workspace' }), 'workspace', { slot: 'memory' });

    expect(takeover.success).toBe(true);
    expect(catalog.list().find((entry) => entry.manifest.id === 'agenc.memory.user')).toEqual(
      expect.objectContaining({ enabled: false }),
    );
    expect(catalog.list().find((entry) => entry.manifest.id === 'agenc.memory.workspace')).toEqual(
      expect.objectContaining({ enabled: true }),
    );

    const collision = catalog.install(createManifest({ id: 'agenc.memory.user2' }), 'user', { slot: 'memory' });
    expect(collision.success).toBe(false);
    expect(collision.message).toContain('occupied by');
  });
});
