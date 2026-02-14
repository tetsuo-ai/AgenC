import { describe, it, expect } from 'vitest';
import {
  PluginManifestError,
  type PluginManifest,
  type PluginsConfig,
  getPluginConfigHints,
  validatePluginManifest,
  validatePluginsConfig,
} from './manifest.js';

function createManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'agenc.memory.redis',
    version: '1.0.0',
    schemaVersion: 1,
    displayName: 'Redis memory plugin',
    description: 'Persistent memory plugin integration',
    labels: ['memory', 'storage'],
    requiredCapabilities: '0x1',
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

describe('validatePluginManifest', () => {
  it('passes for a valid manifest', () => {
    expect(validatePluginManifest(createManifest())).toEqual([]);
  });

  it('reports missing id', () => {
    const manifest = createManifest({ id: '' as string });
    expect(validatePluginManifest(manifest)).toEqual([
      {
        pluginId: '',
        field: 'id',
        message: 'Plugin id is required and must be a non-empty string',
        value: '',
      },
    ]);
  });

  it('reports invalid id pattern', () => {
    const manifest = createManifest({ id: '123-bad' });
    expect(validatePluginManifest(manifest)).toEqual([
      {
        pluginId: '123-bad',
        field: 'id',
        message: 'Plugin id must match pattern: ^[a-z][a-z0-9._-]*$',
        value: '123-bad',
      },
    ]);
  });

  it('reports missing version', () => {
    const manifest = createManifest({ version: '' as string });
    expect(validatePluginManifest(manifest)).toEqual([
      {
        pluginId: 'agenc.memory.redis',
        field: 'version',
        message: 'Version is required',
        value: '',
      },
    ]);
  });

  it('reports invalid schemaVersion', () => {
    const manifest = createManifest({ schemaVersion: 0 });
    expect(validatePluginManifest(manifest)).toEqual([
      {
        pluginId: 'agenc.memory.redis',
        field: 'schemaVersion',
        message: 'schemaVersion must be a positive integer',
        value: 0,
      },
    ]);
  });

  it('reports non-array labels', () => {
    const manifest = createManifest({ labels: 'not-array' as unknown as string[] });
    expect(validatePluginManifest(manifest)).toEqual([
      {
        pluginId: 'agenc.memory.redis',
        field: 'labels',
        message: 'labels must be an array of strings',
        value: 'not-array',
      },
    ]);
  });

  it('reports invalid permission type', () => {
    const manifest = createManifest({
      permissions: [
        {
          type: 'admin' as 'tool_call',
          scope: 'tool',
          required: true,
        },
      ],
    });

    expect(validatePluginManifest(manifest)).toEqual([
      {
        pluginId: 'agenc.memory.redis',
        field: 'permissions[0].type',
        message: 'Permission type must be one of: tool_call, network, filesystem, wallet_sign',
        value: 'admin',
      },
    ]);
  });

  it('reports missing permission scope', () => {
    const manifest = createManifest({
      permissions: [
        {
          type: 'tool_call',
          scope: undefined as unknown as string,
          required: true,
        },
      ],
    });

    expect(validatePluginManifest(manifest)).toEqual([
      {
        pluginId: 'agenc.memory.redis',
        field: 'permissions[0].scope',
        message: 'Permission scope must be a string',
        value: undefined,
      },
    ]);
  });
});

describe('validatePluginsConfig', () => {
  it('passes empty config', () => {
    expect(validatePluginsConfig({ entries: {} })).toEqual([]);
  });

  it('reports undeclared allow-list plugin id', () => {
    const config = { entries: {}, allow: ['nonexistent'] } as unknown as PluginsConfig;
    expect(validatePluginsConfig(config)).toEqual([
      {
        pluginId: 'nonexistent',
        field: 'allow',
        message: 'Plugin "nonexistent" in allow list is not declared in entries',
      },
    ]);
  });

  it('reports undeclared deny-list plugin id', () => {
    const config = { entries: {}, deny: ['nonexistent'] } as unknown as PluginsConfig;
    expect(validatePluginsConfig(config)).toEqual([
      {
        pluginId: 'nonexistent',
        field: 'deny',
        message: 'Plugin "nonexistent" in deny list is not declared in entries',
      },
    ]);
  });

  it('reports manifest key mismatch', () => {
    const config = {
      entries: {
        foo: createManifest({ id: 'bar' }),
      },
    } as unknown as PluginsConfig;

    expect(validatePluginsConfig(config)).toContainEqual({
      pluginId: 'foo',
      field: 'id',
      message: 'Manifest id "bar" does not match config key "foo"',
    });
  });
});

describe('manifest helper behavior', () => {
  it('exposes structured errors via PluginManifestError', () => {
    const errors = [
      {
        pluginId: 'foo',
        field: 'id',
        message: 'Plugin id is required',
      },
    ];
    const err = new PluginManifestError(errors);

    expect(err.name).toBe('PluginManifestError');
    expect(err.errors).toEqual(errors);
  });

  it('builds plugin config hints', () => {
    const config = {
      entries: {
        alpha: createManifest({
          id: 'alpha',
          displayName: 'Alpha',
          labels: ['alpha'],
          permissions: [],
          allowDeny: { allow: ['memory:*'] },
        }),
        beta: createManifest({
          id: 'beta',
          displayName: 'Beta',
          labels: ['beta'],
          permissions: [{ type: 'network', scope: 'https://example.com', required: false }],
          allowDeny: { deny: ['network.*'] },
        }),
      },
      allow: ['alpha'],
      deny: ['beta'],
    } as PluginsConfig;

    const hints = getPluginConfigHints(config);
    const alpha = hints.find((hint) => hint.pluginId === 'alpha');
    const beta = hints.find((hint) => hint.pluginId === 'beta');

    expect(alpha).toEqual({
      pluginId: 'alpha',
      displayName: 'Alpha',
      labels: ['alpha'],
      hasPermissions: false,
      isAllowed: true,
      isDenied: false,
    });
    expect(beta).toEqual({
      pluginId: 'beta',
      displayName: 'Beta',
      labels: ['beta'],
      hasPermissions: true,
      isAllowed: false,
      isDenied: true,
    });
  });

  it('captures malformed manifest regression fixture without false positives', () => {
    const result = validatePluginManifest({
      id: '123-bad',
      version: '',
      schemaVersion: 0,
      displayName: '',
      labels: ['good'],
      permissions: [
        { type: 'admin', scope: 123, required: 'true' },
      ],
    } as unknown);

    expect(result).toHaveLength(7);
    expect(result).toEqual([
      {
        pluginId: '123-bad',
        field: 'id',
        message: 'Plugin id must match pattern: ^[a-z][a-z0-9._-]*$',
        value: '123-bad',
      },
      {
        pluginId: '123-bad',
        field: 'version',
        message: 'Version is required',
        value: '',
      },
      {
        pluginId: '123-bad',
        field: 'schemaVersion',
        message: 'schemaVersion must be a positive integer',
        value: 0,
      },
      {
        pluginId: '123-bad',
        field: 'displayName',
        message: 'displayName is required',
        value: '',
      },
      {
        pluginId: '123-bad',
        field: 'permissions[0].scope',
        message: 'Permission scope must be a string',
        value: 123,
      },
      {
        pluginId: '123-bad',
        field: 'permissions[0].required',
        message: 'Permission required flag must be a boolean',
        value: 'true',
      },
      {
        pluginId: '123-bad',
        field: 'permissions[0].type',
        message: 'Permission type must be one of: tool_call, network, filesystem, wallet_sign',
        value: 'admin',
      },
    ]);
  });
});
