import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  WorkspaceManager,
  WorkspaceValidationError,
  WORKSPACE_CONFIG_FILE,
  DEFAULT_WORKSPACE_ID,
  MEMORY_NAMESPACE_PREFIX,
} from './workspace.js';

let tmpDir: string;
let manager: WorkspaceManager;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'agenc-ws-mgr-'));
  manager = new WorkspaceManager(tmpDir);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true });
});

/** Write a minimal valid workspace.json + optional AGENT.md in a workspace dir. */
async function seedWorkspace(
  id: string,
  config: Record<string, unknown> = {},
  agentMd?: string,
): Promise<string> {
  const dir = join(tmpDir, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, WORKSPACE_CONFIG_FILE), JSON.stringify(config), 'utf-8');
  if (agentMd !== undefined) {
    await writeFile(join(dir, 'AGENT.md'), agentMd, 'utf-8');
  }
  return dir;
}

describe('WorkspaceManager.load', () => {
  it('reads workspace from directory', async () => {
    await seedWorkspace('alpha', {
      name: 'Alpha Agent',
      skills: ['search', 'code'],
      capabilities: '3',
    }, '# Alpha');

    const ws = await manager.load('alpha');

    expect(ws.id).toBe('alpha');
    expect(ws.name).toBe('Alpha Agent');
    expect(ws.path).toBe(join(tmpDir, 'alpha'));
    expect(ws.files.agent).toBe('# Alpha');
    expect(ws.skills).toEqual(['search', 'code']);
    expect(ws.capabilities).toBe(3n);
    expect(ws.memoryNamespace).toBe(`${MEMORY_NAMESPACE_PREFIX}alpha:`);
  });
});

describe('WorkspaceManager.listWorkspaces', () => {
  it('returns all workspace IDs', async () => {
    await seedWorkspace('alpha', {});
    await seedWorkspace('beta', {});
    await seedWorkspace('gamma', {});

    const list = await manager.listWorkspaces();

    expect(list).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('returns empty array when base path does not exist', async () => {
    const noExist = new WorkspaceManager(join(tmpDir, 'nonexistent'));
    const list = await noExist.listWorkspaces();
    expect(list).toEqual([]);
  });

  it('ignores directories without workspace.json', async () => {
    await seedWorkspace('valid', {});
    await mkdir(join(tmpDir, 'empty-dir'), { recursive: true });

    const list = await manager.listWorkspaces();
    expect(list).toEqual(['valid']);
  });
});

describe('WorkspaceManager.createWorkspace', () => {
  it('throws when workspace already exists', async () => {
    await manager.createWorkspace('duplicate');
    await expect(manager.createWorkspace('duplicate')).rejects.toThrow(
      WorkspaceValidationError,
    );
    await expect(manager.createWorkspace('duplicate')).rejects.toThrow(
      'Workspace already exists',
    );
  });

  it('scaffolds directory with template', async () => {
    const ws = await manager.createWorkspace('myagent', {
      name: 'My Agent',
      skills: ['search'],
      files: { agent: '# Custom Agent' },
    });

    expect(ws.name).toBe('My Agent');
    expect(ws.skills).toEqual(['search']);
    expect(ws.files.agent).toBe('# Custom Agent');
    // Default template files are present for non-overridden files
    expect(ws.files.soul).toBeDefined();
    expect(ws.files.soul!.length).toBeGreaterThan(0);

    // Verify workspace.json was written
    const configRaw = await readFile(join(tmpDir, 'myagent', WORKSPACE_CONFIG_FILE), 'utf-8');
    const config = JSON.parse(configRaw);
    expect(config.name).toBe('My Agent');
    expect(config.skills).toEqual(['search']);
  });
});

describe('WorkspaceManager.deleteWorkspace', () => {
  it('removes workspace directory and returns true', async () => {
    await seedWorkspace('ephemeral', {});

    const result = await manager.deleteWorkspace('ephemeral');
    expect(result).toBe(true);

    const list = await manager.listWorkspaces();
    expect(list).not.toContain('ephemeral');
  });

  it('returns false for nonexistent workspace', async () => {
    const result = await manager.deleteWorkspace('nonexistent');
    expect(result).toBe(false);
  });

  it('throws for default workspace', async () => {
    await seedWorkspace(DEFAULT_WORKSPACE_ID, {});

    await expect(manager.deleteWorkspace(DEFAULT_WORKSPACE_ID)).rejects.toThrow(
      WorkspaceValidationError,
    );
    await expect(manager.deleteWorkspace(DEFAULT_WORKSPACE_ID)).rejects.toThrow(
      'Cannot delete the default workspace',
    );
  });
});

describe('WorkspaceManager.getDefault', () => {
  it('returns default workspace ID', () => {
    expect(manager.getDefault()).toBe('default');
  });
});

describe('workspace memory namespace isolation', () => {
  it('two workspaces get different namespaces', async () => {
    await seedWorkspace('alpha', {});
    await seedWorkspace('beta', {});

    const wsA = await manager.load('alpha');
    const wsB = await manager.load('beta');

    expect(wsA.memoryNamespace).not.toBe(wsB.memoryNamespace);
    expect(wsA.memoryNamespace).toBe(`${MEMORY_NAMESPACE_PREFIX}alpha:`);
    expect(wsB.memoryNamespace).toBe(`${MEMORY_NAMESPACE_PREFIX}beta:`);
  });

  it('explicit namespace override from config', async () => {
    await seedWorkspace('custom', { memoryNamespace: 'custom:ns:' });

    const ws = await manager.load('custom');
    expect(ws.memoryNamespace).toBe('custom:ns:');
  });
});

describe('workspace file loading', () => {
  it('loads workspace files, undefined for missing', async () => {
    await seedWorkspace('files-test', {}, '# Test Agent');
    await writeFile(join(tmpDir, 'files-test', 'SOUL.md'), '# Test Soul', 'utf-8');

    const ws = await manager.load('files-test');

    expect(ws.files.agent).toBe('# Test Agent');
    expect(ws.files.soul).toBe('# Test Soul');
    expect(ws.files.user).toBeUndefined();
    expect(ws.files.tools).toBeUndefined();
    expect(ws.files.memory).toBeUndefined();
  });
});

describe('missing workspace directory', () => {
  it('throws WorkspaceValidationError with descriptive message', async () => {
    await expect(manager.load('nonexistent')).rejects.toThrow(WorkspaceValidationError);
    await expect(manager.load('nonexistent')).rejects.toThrow('Workspace directory not found');
  });

  it('throws when directory exists but workspace.json is missing', async () => {
    await mkdir(join(tmpDir, 'no-config'), { recursive: true });
    await expect(manager.load('no-config')).rejects.toThrow(WorkspaceValidationError);
    await expect(manager.load('no-config')).rejects.toThrow('not found');
  });
});

describe('invalid workspace config handling', () => {
  it('invalid JSON throws', async () => {
    const dir = join(tmpDir, 'bad-json');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, WORKSPACE_CONFIG_FILE), '{not valid json}', 'utf-8');

    await expect(manager.load('bad-json')).rejects.toThrow(WorkspaceValidationError);
    await expect(manager.load('bad-json')).rejects.toThrow('Invalid JSON');
  });

  it('invalid capabilities string throws', async () => {
    const dir = join(tmpDir, 'bad-caps');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, WORKSPACE_CONFIG_FILE),
      JSON.stringify({ capabilities: 'not-a-number' }),
      'utf-8',
    );

    await expect(manager.load('bad-caps')).rejects.toThrow(WorkspaceValidationError);
  });

  it('invalid workspace ID throws', async () => {
    // Uppercase
    await expect(manager.load('INVALID')).rejects.toThrow(WorkspaceValidationError);
    // Number prefix
    await expect(manager.load('123abc')).rejects.toThrow(WorkspaceValidationError);
    // Path traversal
    await expect(manager.load('../etc')).rejects.toThrow(WorkspaceValidationError);
  });
});

describe('multiple workspaces coexist', () => {
  it('independent config, skills, namespaces, and paths', async () => {
    const wsA = await manager.createWorkspace('agent-a', {
      name: 'Agent A',
      skills: ['search'],
      files: { agent: '# Agent A' },
    });

    const wsB = await manager.createWorkspace('agent-b', {
      name: 'Agent B',
      skills: ['code', 'deploy'],
      files: { agent: '# Agent B' },
    });

    // Independent config
    expect(wsA.name).toBe('Agent A');
    expect(wsB.name).toBe('Agent B');

    // Independent skills
    expect(wsA.skills).toEqual(['search']);
    expect(wsB.skills).toEqual(['code', 'deploy']);

    // Independent namespaces
    expect(wsA.memoryNamespace).toBe(`${MEMORY_NAMESPACE_PREFIX}agent-a:`);
    expect(wsB.memoryNamespace).toBe(`${MEMORY_NAMESPACE_PREFIX}agent-b:`);

    // Independent paths
    expect(wsA.path).not.toBe(wsB.path);

    // Independent files
    expect(wsA.files.agent).toBe('# Agent A');
    expect(wsB.files.agent).toBe('# Agent B');

    // Both listed
    const list = await manager.listWorkspaces();
    expect(list).toContain('agent-a');
    expect(list).toContain('agent-b');
  });
});
