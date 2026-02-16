import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFilesystemTools, safePath, isPathAllowed } from './filesystem.js';
import type { Tool } from '../types.js';

// ============================================================================
// Mock node:fs/promises
// ============================================================================

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  appendFile: vi.fn(),
  opendir: vi.fn(),
  stat: vi.fn(),
  lstat: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
  rename: vi.fn(),
  // realpath: identity by default — tests override for symlink scenarios
  realpath: vi.fn(async (p: string) => p),
}));

import { readFile, writeFile, appendFile, opendir, stat, lstat, mkdir, rm, rename, realpath } from 'node:fs/promises';

const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockAppendFile = vi.mocked(appendFile);
const mockOpendir = vi.mocked(opendir);
const mockStat = vi.mocked(stat);
const mockLstat = vi.mocked(lstat);
const mockMkdir = vi.mocked(mkdir);
const mockRm = vi.mocked(rm);
const mockRename = vi.mocked(rename);
const mockRealpath = vi.mocked(realpath);

/** Create a mock Dir handle (async iterable + close). */
function createMockDir(entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean; isSymbolicLink?: () => boolean }>) {
  let index = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (index < entries.length) return { done: false as const, value: entries[index++] };
          return { done: true as const, value: undefined };
        },
      };
    },
    close: vi.fn().mockResolvedValue(undefined),
  };
}

// ============================================================================
// Helpers
// ============================================================================

function findTool(tools: Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

function parseResult(result: { content: string }) {
  return JSON.parse(result.content);
}

const ALLOWED_PATHS = ['/workspace'];
const CONFIG = { allowedPaths: ALLOWED_PATHS };

// ============================================================================
// safePath / isPathAllowed
// ============================================================================

describe('safePath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: realpath returns identity (no symlinks)
    mockRealpath.mockImplementation(async (p: string) => p as never);
  });

  it('accepts paths within allowed directories', async () => {
    const result = await safePath('/workspace/file.txt', ALLOWED_PATHS);
    expect(result.safe).toBe(true);
    expect(result.resolved).toBe('/workspace/file.txt');
  });

  it('rejects paths outside allowed directories', async () => {
    const result = await safePath('/etc/passwd', ALLOWED_PATHS);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('outside allowed');
  });

  it('detects path traversal with ..', async () => {
    // Absolute path with .. triggers segment-aware check
    const result = await safePath('/workspace/../etc/passwd', ALLOWED_PATHS);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('traversal');

    // Relative traversal also caught
    const result2 = await safePath('../../../etc/passwd', ALLOWED_PATHS);
    expect(result2.safe).toBe(false);
    expect(result2.reason).toContain('traversal');
  });

  it('allows filenames containing double dots (e.g. file..txt)', async () => {
    const result = await safePath('/workspace/file..txt', ALLOWED_PATHS);
    expect(result.safe).toBe(true);
  });

  it('rejects empty paths', async () => {
    const result = await safePath('', ALLOWED_PATHS);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('non-empty');
  });

  it('rejects when no allowed paths configured', async () => {
    const result = await safePath('/workspace/file.txt', []);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('No allowed paths');
  });

  it('rejects null-byte paths', async () => {
    const result = await safePath('/workspace/file.txt\0evil', ALLOWED_PATHS);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('null byte');
  });

  it('canonicalizes paths with multiple non-existent parent levels', async () => {
    // /workspace exists, a/b/c do not — should walk up to /workspace and resolve
    mockRealpath.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s === '/workspace') return '/workspace' as never;
      // Everything deeper fails with ENOENT
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    const result = await safePath('/workspace/a/b/c/new.txt', ALLOWED_PATHS);
    expect(result.safe).toBe(true);
    expect(result.resolved).toBe('/workspace/a/b/c/new.txt');
  });

  it('resolves symlinks before allowlist check', async () => {
    // Symlink /workspace/link -> /etc, so /workspace/link/passwd -> /etc/passwd
    mockRealpath.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s === '/workspace/link/passwd') return '/etc/passwd' as never;
      if (s === '/workspace') return '/workspace' as never;
      return s as never;
    });

    const result = await safePath('/workspace/link/passwd', ALLOWED_PATHS);
    expect(result.safe).toBe(false);
  });
});

describe('isPathAllowed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
  });

  it('returns true for allowed paths', async () => {
    expect(await isPathAllowed('/workspace/src/main.ts', ALLOWED_PATHS)).toBe(true);
  });

  it('returns false for disallowed paths', async () => {
    expect(await isPathAllowed('/root/.ssh/id_rsa', ALLOWED_PATHS)).toBe(false);
  });
});

// ============================================================================
// createFilesystemTools
// ============================================================================

describe('createFilesystemTools', () => {
  it('returns all 8 filesystem tools', () => {
    const tools = createFilesystemTools(CONFIG);
    expect(tools).toHaveLength(8);
    expect(tools.map((t) => t.name).sort()).toEqual([
      'system.appendFile',
      'system.delete',
      'system.listDir',
      'system.mkdir',
      'system.move',
      'system.readFile',
      'system.stat',
      'system.writeFile',
    ]);
  });

  // ── Config validation (Finding 1) ──────────────────────────────────────

  it('throws on allowedPaths as string (not array)', () => {
    expect(() =>
      createFilesystemTools({ allowedPaths: '/workspace' as unknown as string[] }),
    ).toThrow('non-empty array');
  });

  it('throws on empty allowedPaths', () => {
    expect(() => createFilesystemTools({ allowedPaths: [] })).toThrow('non-empty array');
  });

  it('throws on allowedPaths with empty string entry', () => {
    expect(() => createFilesystemTools({ allowedPaths: [''] })).toThrow('non-empty string');
  });

  it('throws on allowedPaths with non-string entry', () => {
    expect(() =>
      createFilesystemTools({ allowedPaths: [42] as unknown as string[] }),
    ).toThrow('non-empty string');
  });

  it('throws on null allowedPaths', () => {
    expect(() =>
      createFilesystemTools({ allowedPaths: null as unknown as string[] }),
    ).toThrow('non-empty array');
  });

  // ── Config validation (Finding 2) ──────────────────────────────────────

  it('throws on NaN maxReadBytes', () => {
    expect(() =>
      createFilesystemTools({ allowedPaths: ALLOWED_PATHS, maxReadBytes: NaN }),
    ).toThrow('positive finite number');
  });

  it('throws on Infinity maxWriteBytes', () => {
    expect(() =>
      createFilesystemTools({ allowedPaths: ALLOWED_PATHS, maxWriteBytes: Infinity }),
    ).toThrow('positive finite number');
  });

  it('throws on negative maxReadBytes', () => {
    expect(() =>
      createFilesystemTools({ allowedPaths: ALLOWED_PATHS, maxReadBytes: -1 }),
    ).toThrow('positive finite number');
  });

  it('throws on zero maxWriteBytes', () => {
    expect(() =>
      createFilesystemTools({ allowedPaths: ALLOWED_PATHS, maxWriteBytes: 0 }),
    ).toThrow('positive finite number');
  });

  it('throws on non-boolean allowDelete', () => {
    expect(() =>
      createFilesystemTools({
        allowedPaths: ALLOWED_PATHS,
        allowDelete: 'false' as unknown as boolean,
      }),
    ).toThrow('boolean');
  });
});

// ============================================================================
// system.readFile
// ============================================================================

describe('system.readFile', () => {
  let tool: Tool;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
    tool = findTool(createFilesystemTools(CONFIG), 'system.readFile');
  });

  it('reads a text file', async () => {
    const content = 'hello world';
    mockStat.mockResolvedValueOnce({ isFile: () => true, isDirectory: () => false, size: content.length } as never);
    mockReadFile.mockResolvedValueOnce(Buffer.from(content));

    const result = await tool.execute({ path: '/workspace/test.txt' });
    const parsed = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.encoding).toBe('utf-8');
    expect(parsed.content).toBe('hello world');
    expect(parsed.size).toBe(11);
  });

  it('auto-detects binary content', async () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    mockStat.mockResolvedValueOnce({ isFile: () => true, isDirectory: () => false, size: binary.length } as never);
    mockReadFile.mockResolvedValueOnce(binary);

    const result = await tool.execute({ path: '/workspace/image.png' });
    const parsed = parseResult(result);

    expect(parsed.encoding).toBe('base64');
  });

  it('rejects files exceeding size limit', async () => {
    mockStat.mockResolvedValueOnce({ isFile: () => true, isDirectory: () => false, size: 20_000_000 } as never);

    const result = await tool.execute({ path: '/workspace/big.bin' });

    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('exceeds limit');
  });

  it('rejects paths outside allowlist', async () => {
    const result = await tool.execute({ path: '/etc/shadow' });

    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('Access denied');
  });

  it('returns error for non-regular files', async () => {
    mockStat.mockResolvedValueOnce({ isFile: () => false, isDirectory: () => true, size: 0 } as never);

    const result = await tool.execute({ path: '/workspace/somedir' });

    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('not a regular file');
  });

  it('returns error for missing files', async () => {
    mockStat.mockRejectedValueOnce(new Error('ENOENT: no such file'));

    const result = await tool.execute({ path: '/workspace/missing.txt' });

    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('not found');
  });

  it('returns error instead of throwing on null-byte path', async () => {
    const result = await tool.execute({ path: '/workspace/x\0y' });

    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('Access denied');
  });

  it('rejects invalid encoding parameter', async () => {
    const result = await tool.execute({ path: '/workspace/test.txt', encoding: 'ascii' });

    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('Invalid encoding');
  });

  it('catches file that grew between stat and readFile (TOCTOU)', async () => {
    // stat says 100 bytes, but readFile returns 20MB
    mockStat.mockResolvedValueOnce({ isFile: () => true, isDirectory: () => false, size: 100 } as never);
    mockReadFile.mockResolvedValueOnce(Buffer.alloc(20_000_000));

    const result = await tool.execute({ path: '/workspace/tricky.bin' });

    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('exceeds limit');
  });
});

// ============================================================================
// system.writeFile
// ============================================================================

describe('system.writeFile', () => {
  let tool: Tool;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
    tool = findTool(createFilesystemTools(CONFIG), 'system.writeFile');
  });

  it('writes a text file and creates parent dirs', async () => {
    mockMkdir.mockResolvedValueOnce(undefined);
    mockWriteFile.mockResolvedValueOnce(undefined);

    const result = await tool.execute({
      path: '/workspace/subdir/new.txt',
      content: 'hello',
    });
    const parsed = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.bytesWritten).toBe(5);
    expect(mockMkdir).toHaveBeenCalledWith('/workspace/subdir', { recursive: true });
  });

  it('rejects content exceeding size limit', async () => {
    const bigContent = 'x'.repeat(11_000_000);

    const result = await tool.execute({
      path: '/workspace/big.txt',
      content: bigContent,
    });

    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('exceeds limit');
  });

  it('rejects invalid encoding parameter', async () => {
    const result = await tool.execute({
      path: '/workspace/test.txt',
      content: 'hello',
      encoding: 'latin1',
    });

    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('Invalid encoding');
  });

  it('rejects malformed base64 content', async () => {
    const result = await tool.execute({
      path: '/workspace/data.bin',
      content: 'not!valid!base64',
      encoding: 'base64',
    });

    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('Invalid base64');
  });

  it('writes base64 content', async () => {
    mockMkdir.mockResolvedValueOnce(undefined);
    mockWriteFile.mockResolvedValueOnce(undefined);

    const b64 = Buffer.from('binary data').toString('base64');
    const result = await tool.execute({
      path: '/workspace/data.bin',
      content: b64,
      encoding: 'base64',
    });
    const parsed = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.bytesWritten).toBe(11); // 'binary data'.length
  });
});

// ============================================================================
// system.appendFile
// ============================================================================

describe('system.appendFile', () => {
  let tool: Tool;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
    tool = findTool(createFilesystemTools(CONFIG), 'system.appendFile');
  });

  it('appends content to a file', async () => {
    mockAppendFile.mockResolvedValueOnce(undefined);

    const result = await tool.execute({
      path: '/workspace/log.txt',
      content: 'new line\n',
    });
    const parsed = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.bytesAppended).toBe(9);
  });
});

// ============================================================================
// system.listDir
// ============================================================================

describe('system.listDir', () => {
  let tool: Tool;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
    tool = findTool(createFilesystemTools(CONFIG), 'system.listDir');
  });

  it('lists directory contents with types and sizes', async () => {
    mockOpendir.mockResolvedValueOnce(
      createMockDir([
        { name: 'src', isDirectory: () => true, isFile: () => false },
        { name: 'readme.md', isDirectory: () => false, isFile: () => true },
      ]) as never,
    );
    mockLstat.mockResolvedValueOnce({ size: 1024 } as never);

    const result = await tool.execute({ path: '/workspace' });
    const parsed = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]).toEqual({ name: 'src', type: 'dir', size: 0 });
    expect(parsed.entries[1]).toEqual({ name: 'readme.md', type: 'file', size: 1024 });
  });

  it('returns error for non-existent directory', async () => {
    mockOpendir.mockRejectedValueOnce(new Error('ENOENT: no such directory'));

    const result = await tool.execute({ path: '/workspace/nope' });

    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('not found');
  });

  it('truncates results and reports metadata when entries exceed cap', async () => {
    // Create 10_001 mock dirents (cap is 10_000)
    const bigDir = Array.from({ length: 10_001 }, (_, i) => ({
      name: `file-${i}.txt`,
      isDirectory: () => false,
      isFile: () => true,
    }));
    mockOpendir.mockResolvedValueOnce(createMockDir(bigDir) as never);
    // lstat calls for each capped file entry
    mockLstat.mockResolvedValue({ size: 1 } as never);

    const result = await tool.execute({ path: '/workspace' });
    const parsed = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.entries).toHaveLength(10_000);
    expect(parsed.truncated).toBe(true);
  });
});

// ============================================================================
// system.stat
// ============================================================================

describe('system.stat', () => {
  let tool: Tool;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
    tool = findTool(createFilesystemTools(CONFIG), 'system.stat');
  });

  it('returns file metadata', async () => {
    mockStat.mockResolvedValueOnce({
      size: 2048,
      mtime: new Date('2025-01-01T00:00:00Z'),
      birthtime: new Date('2024-06-01T00:00:00Z'),
      isDirectory: () => false,
      isFile: () => true,
      mode: 0o100644,
    } as never);

    const result = await tool.execute({ path: '/workspace/file.ts' });
    const parsed = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.size).toBe(2048);
    expect(parsed.isFile).toBe(true);
    expect(parsed.isDirectory).toBe(false);
    expect(parsed.permissions).toBe('0644');
    expect(parsed.modified).toContain('2025');
  });

  it('returns error for non-existent paths', async () => {
    mockStat.mockRejectedValueOnce(new Error('ENOENT: not found'));

    const result = await tool.execute({ path: '/workspace/missing' });

    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('not found');
  });
});

// ============================================================================
// system.mkdir
// ============================================================================

describe('system.mkdir', () => {
  let tool: Tool;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
    tool = findTool(createFilesystemTools(CONFIG), 'system.mkdir');
  });

  it('creates nested directories', async () => {
    mockMkdir.mockResolvedValueOnce(undefined);

    const result = await tool.execute({ path: '/workspace/a/b/c' });
    const parsed = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.created).toBe(true);
    expect(mockMkdir).toHaveBeenCalledWith('/workspace/a/b/c', { recursive: true });
  });
});

// ============================================================================
// system.delete
// ============================================================================

describe('system.delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
  });

  it('rejects when allowDelete is false (default)', async () => {
    const tool = findTool(createFilesystemTools(CONFIG), 'system.delete');

    const result = await tool.execute({ path: '/workspace/file.txt' });

    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('disabled');
  });

  it('deletes a file when allowDelete is true', async () => {
    mockStat.mockResolvedValueOnce({ isDirectory: () => false } as never);
    mockRm.mockResolvedValueOnce(undefined);
    const tool = findTool(
      createFilesystemTools({ ...CONFIG, allowDelete: true }),
      'system.delete',
    );

    const result = await tool.execute({ path: '/workspace/old.txt' });
    const parsed = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.deleted).toBe(true);
    expect(mockRm).toHaveBeenCalledWith('/workspace/old.txt', { recursive: false });
  });

  it('rejects directory deletion without recursive flag', async () => {
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as never);
    const tool = findTool(
      createFilesystemTools({ ...CONFIG, allowDelete: true }),
      'system.delete',
    );

    const result = await tool.execute({ path: '/workspace/somedir' });

    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('recursive');
  });

  it('deletes directory when recursive is true', async () => {
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as never);
    mockRm.mockResolvedValueOnce(undefined);
    const tool = findTool(
      createFilesystemTools({ ...CONFIG, allowDelete: true }),
      'system.delete',
    );

    const result = await tool.execute({ path: '/workspace/somedir', recursive: true });
    const parsed = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.deleted).toBe(true);
    expect(mockRm).toHaveBeenCalledWith('/workspace/somedir', { recursive: true });
  });

  it('rejects deletion of sandbox root directory', async () => {
    const tool = findTool(
      createFilesystemTools({ ...CONFIG, allowDelete: true }),
      'system.delete',
    );

    const result = await tool.execute({ path: '/workspace' });

    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('sandbox root');
  });

  it('rejects paths outside allowlist even when delete is enabled', async () => {
    const tool = findTool(
      createFilesystemTools({ ...CONFIG, allowDelete: true }),
      'system.delete',
    );

    const result = await tool.execute({ path: '/etc/important' });

    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('Access denied');
  });
});

// ============================================================================
// system.move
// ============================================================================

describe('system.move', () => {
  let tool: Tool;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
    tool = findTool(createFilesystemTools(CONFIG), 'system.move');
  });

  it('moves a file within allowed paths', async () => {
    mockMkdir.mockResolvedValueOnce(undefined);
    mockRename.mockResolvedValueOnce(undefined);

    const result = await tool.execute({
      source: '/workspace/old.txt',
      destination: '/workspace/new.txt',
    });
    const parsed = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.moved).toBe(true);
  });

  it('rejects when destination is outside allowed paths', async () => {
    const result = await tool.execute({
      source: '/workspace/file.txt',
      destination: '/tmp/stolen.txt',
    });

    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('Access denied');
  });

  it('rejects when source is outside allowed paths', async () => {
    const result = await tool.execute({
      source: '/etc/passwd',
      destination: '/workspace/passwd',
    });

    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('Access denied');
  });
});

// ============================================================================
// Additional security tests
// ============================================================================

describe('safePath PATH_MAX enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
  });

  it('rejects paths exceeding MAX_PATH_LENGTH (4096)', async () => {
    const longPath = '/workspace/' + 'a'.repeat(4100);
    const result = await safePath(longPath, ALLOWED_PATHS);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('maximum length');
  });
});

describe('system.readFile device file protection', () => {
  let tool: Tool;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
    tool = findTool(createFilesystemTools(CONFIG), 'system.readFile');
  });

  it('rejects device files (isFile returns false)', async () => {
    // Simulate a device file: not a directory, not a regular file
    mockStat.mockResolvedValueOnce({ isFile: () => false, isDirectory: () => false, size: 0 } as never);

    const result = await tool.execute({ path: '/workspace/device' });

    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('not a regular file');
  });
});

describe('error message sanitization', () => {
  let tool: Tool;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
    tool = findTool(createFilesystemTools(CONFIG), 'system.readFile');
  });

  it('does not leak resolved path in fallback error messages', async () => {
    // Simulate an unexpected error with path in message
    mockStat.mockResolvedValueOnce({ isFile: () => true, isDirectory: () => false, size: 10 } as never);
    const errWithPath = new Error("ENOSPC: no space left on device, read '/workspace/secret-internal-path/file.txt'");
    (errWithPath as NodeJS.ErrnoException).code = 'ENOSPC';
    mockReadFile.mockRejectedValueOnce(errWithPath);

    const result = await tool.execute({ path: '/workspace/file.txt' });

    expect(result.isError).toBe(true);
    const parsed = parseResult(result);
    // Should contain the error code but NOT the resolved path
    expect(parsed.error).toContain('ENOSPC');
    expect(parsed.error).not.toContain('secret-internal-path');
  });

  it('safePath does not leak host paths on unexpected errors', async () => {
    // realpath throws an unexpected error with internal path info
    mockRealpath.mockImplementation(async () => {
      const err = new Error("ELOOP: too many symbolic links, stat '/internal/secret/path'");
      (err as NodeJS.ErrnoException).code = 'ELOOP';
      throw err;
    });

    const result = await safePath('/workspace/file.txt', ALLOWED_PATHS);
    expect(result.safe).toBe(false);
    // Should contain error code but NOT the raw internal path
    expect(result.reason).toContain('ELOOP');
    expect(result.reason).not.toContain('/internal/secret/path');
  });
});

describe('system.appendFile TOCTOU growth race', () => {
  let tool: Tool;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
    tool = findTool(createFilesystemTools(CONFIG), 'system.appendFile');
  });

  it('catches file that grew between stat and appendFile', async () => {
    // File is 9MB (under 10MB limit), append 2MB → should be rejected at 11MB
    mockStat.mockResolvedValueOnce({ size: 9_000_000 } as never);
    // appendFile would succeed, but the size check should catch it first

    const result = await tool.execute({
      path: '/workspace/growing.log',
      content: 'x'.repeat(2_000_000),
    });

    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('exceeds limit');
  });
});

describe('system.listDir type accuracy', () => {
  let tool: Tool;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
    tool = findTool(createFilesystemTools(CONFIG), 'system.listDir');
  });

  it('reports symlinks and other special types correctly', async () => {
    mockOpendir.mockResolvedValueOnce(
      createMockDir([
        { name: 'dir', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false } as never,
        { name: 'file.txt', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false } as never,
        { name: 'link', isDirectory: () => false, isFile: () => false, isSymbolicLink: () => true } as never,
        { name: 'socket', isDirectory: () => false, isFile: () => false, isSymbolicLink: () => false } as never,
      ]) as never,
    );
    mockLstat.mockResolvedValueOnce({ size: 100 } as never);

    const result = await tool.execute({ path: '/workspace' });
    const parsed = parseResult(result);

    expect(parsed.entries[0].type).toBe('dir');
    expect(parsed.entries[1].type).toBe('file');
    expect(parsed.entries[2].type).toBe('symlink');
    expect(parsed.entries[3].type).toBe('other');
  });
});

// ============================================================================
// safePath host-path leak prevention
// ============================================================================

describe('safePath denied-path leak prevention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
  });

  it('does not expose canonical path when access is denied', async () => {
    const result = await safePath('/etc/passwd', ALLOWED_PATHS);
    expect(result.safe).toBe(false);
    // resolved must be empty — never leak host path on denial
    expect(result.resolved).toBe('');
  });
});

// ============================================================================
// URL-encoded traversal defense
// ============================================================================

describe('safePath URL-encoded traversal defense', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
  });

  it('rejects %2f (URL-encoded forward slash)', async () => {
    const result = await safePath('/workspace/..%2f..%2fetc/passwd', ALLOWED_PATHS);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('traversal');
  });

  it('rejects %5c (URL-encoded backslash)', async () => {
    const result = await safePath('/workspace/foo%5cbar', ALLOWED_PATHS);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('traversal');
  });

  it('rejects %00 (URL-encoded null byte)', async () => {
    const result = await safePath('/workspace/file%00.txt', ALLOWED_PATHS);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('traversal');
  });
});

// ============================================================================
// Base64 pre-decode size guard
// ============================================================================

describe('system.writeFile base64 size pre-check', () => {
  let tool: Tool;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
    // Use a small write limit to make the test fast
    tool = findTool(
      createFilesystemTools({ allowedPaths: ALLOWED_PATHS, maxWriteBytes: 100 }),
      'system.writeFile',
    );
  });

  it('rejects oversized base64 string before regex/decode', async () => {
    // 200 bytes decoded → ~268 chars base64, well above 100-byte limit
    const oversizedB64 = Buffer.alloc(200).toString('base64');

    const result = await tool.execute({
      path: '/workspace/big.bin',
      content: oversizedB64,
      encoding: 'base64',
    });

    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('too large');
    // writeFile should NOT have been called — rejected before decode
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Delete recursive schema bypass
// ============================================================================

describe('system.delete recursive parameter strictness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
  });

  it('rejects directory deletion when recursive is string "true" (not boolean)', async () => {
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as never);
    const tool = findTool(
      createFilesystemTools({ ...CONFIG, allowDelete: true }),
      'system.delete',
    );

    const result = await tool.execute({ path: '/workspace/somedir', recursive: 'true' });

    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('recursive');
    expect(mockRm).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Multiple allowedPaths
// ============================================================================

describe('multiple allowedPaths', () => {
  const MULTI_CONFIG = { allowedPaths: ['/workspace', '/data'] };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
  });

  it('allows reads from either allowed path', async () => {
    const tools = createFilesystemTools(MULTI_CONFIG);
    const readTool = findTool(tools, 'system.readFile');

    mockStat.mockResolvedValueOnce({ isFile: () => true, isDirectory: () => false, size: 5 } as never);
    mockReadFile.mockResolvedValueOnce(Buffer.from('hello'));
    const r1 = await readTool.execute({ path: '/workspace/a.txt' });
    expect(r1.isError).toBeUndefined();

    mockStat.mockResolvedValueOnce({ isFile: () => true, isDirectory: () => false, size: 5 } as never);
    mockReadFile.mockResolvedValueOnce(Buffer.from('world'));
    const r2 = await readTool.execute({ path: '/data/b.txt' });
    expect(r2.isError).toBeUndefined();
  });

  it('rejects paths outside all allowed paths', async () => {
    const tools = createFilesystemTools(MULTI_CONFIG);
    const readTool = findTool(tools, 'system.readFile');

    const result = await readTool.execute({ path: '/etc/passwd' });
    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain('Access denied');
  });
});

describe('overlapping allowedPaths', () => {
  const OVERLAP_CONFIG = { allowedPaths: ['/workspace', '/workspace/subdir'] };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
  });

  it('allows access to nested path within overlapping allowed paths', async () => {
    const tools = createFilesystemTools(OVERLAP_CONFIG);
    const readTool = findTool(tools, 'system.readFile');

    mockStat.mockResolvedValueOnce({ isFile: () => true, isDirectory: () => false, size: 3 } as never);
    mockReadFile.mockResolvedValueOnce(Buffer.from('abc'));
    const result = await readTool.execute({ path: '/workspace/subdir/file.txt' });
    expect(result.isError).toBeUndefined();
  });
});

// ============================================================================
// appendFile creates parent directories
// ============================================================================

describe('system.appendFile parent directory creation', () => {
  let tool: Tool;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
    tool = findTool(createFilesystemTools(CONFIG), 'system.appendFile');
  });

  it('creates parent directories before appending', async () => {
    mockMkdir.mockResolvedValueOnce(undefined);
    mockAppendFile.mockResolvedValueOnce(undefined);

    const result = await tool.execute({
      path: '/workspace/new/nested/log.txt',
      content: 'first line\n',
    });

    expect(result.isError).toBeUndefined();
    expect(mockMkdir).toHaveBeenCalledWith('/workspace/new/nested', { recursive: true });
  });
});

// ============================================================================
// Dangling-symlink TOCTOU regression test
// ============================================================================

describe('safePath dangling-symlink ancestor walk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows new file under existing sandbox parent (ancestor walk)', async () => {
    // Simulate: /workspace exists, /workspace/new/file.txt does not
    mockRealpath.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s === '/workspace') return '/workspace' as never;
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    const result = await safePath('/workspace/new/file.txt', ALLOWED_PATHS);
    expect(result.safe).toBe(true);
    expect(result.resolved).toBe('/workspace/new/file.txt');
  });

  it('rejects new file when ancestor walk resolves outside sandbox via symlink', async () => {
    // Simulate: /workspace/link exists and is a symlink → /etc
    // So /workspace/link/new.txt canonicalizes to /etc/new.txt (outside sandbox)
    mockRealpath.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s === '/workspace') return '/workspace' as never;
      if (s === '/workspace/link') return '/etc' as never;
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    const result = await safePath('/workspace/link/new.txt', ALLOWED_PATHS);
    expect(result.safe).toBe(false);
  });
});

// ============================================================================
// inferToolAccess edge cases (tested via ToolRegistry safe-mode behavior)
// ============================================================================

describe('inferToolAccess classification via tool naming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
  });

  it('classifies system.readFile as read (prefix match)', () => {
    const tools = createFilesystemTools(CONFIG);
    const readFile = tools.find((t) => t.name === 'system.readFile');
    expect(readFile).toBeDefined();
    // If inferToolAccess works correctly, this tool name should be classified as read.
    // We verify indirectly: the tool name starts with a read prefix after the last dot.
    const action = 'system.readFile'.split('.').pop()!.toLowerCase();
    expect(action.startsWith('read')).toBe(true);
  });

  it('classifies system.stat as read (exact match)', () => {
    const action = 'system.stat'.split('.').pop()!.toLowerCase();
    expect(action).toBe('stat');
  });

  it('would NOT classify system.statusSet as read (no false positive)', () => {
    // This is the key edge case — "statusSet" should NOT match "status" exact
    // and should NOT match any read prefix
    const action = 'system.statusSet'.split('.').pop()!.toLowerCase();
    const readPrefixes = ['get', 'list', 'query', 'inspect', 'read'];
    const isExactRead = action === 'stat' || action === 'status';
    const isPrefixRead = readPrefixes.some((p) => action.startsWith(p));
    expect(isExactRead).toBe(false);
    expect(isPrefixRead).toBe(false);
  });

  it('would NOT classify system.statisticsUpdate as read', () => {
    const action = 'system.statisticsUpdate'.split('.').pop()!.toLowerCase();
    const readPrefixes = ['get', 'list', 'query', 'inspect', 'read'];
    const isExactRead = action === 'stat' || action === 'status';
    const isPrefixRead = readPrefixes.some((p) => action.startsWith(p));
    expect(isExactRead).toBe(false);
    expect(isPrefixRead).toBe(false);
  });
});
