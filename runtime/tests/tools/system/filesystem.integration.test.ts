/**
 * Integration tests for filesystem tools — NO MOCKS.
 *
 * These tests create real files on disk inside an OS-provided temp directory,
 * execute every tool against the real filesystem, and verify:
 *   1. Functional correctness (reads, writes, listings, etc.)
 *   2. Security boundaries (path traversal, allowlist enforcement, symlink escape)
 *   3. Edge cases (binary files, empty files, nested dirs, concurrent ops)
 *
 * Cleanup is handled in afterEach/afterAll so temp dirs don't leak.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, symlink, link, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFilesystemTools, type FilesystemToolConfig } from '../../../src/tools/system/filesystem.js';
import type { Tool, ToolResult } from '../../../src/tools/types.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Create all tools with given config. */
function makeTools(config: FilesystemToolConfig): Tool[] {
  return createFilesystemTools(config);
}

/** Find tool by name. */
function findTool(tools: Tool[], name: string): Tool {
  const t = tools.find((t) => t.name === name);
  if (!t) throw new Error(`Tool ${name} not found`);
  return t;
}

/** Parse result content as JSON. */
function parse(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content);
}

// ─── Setup ─────────────────────────────────────────────────────────────────

let sandbox: string;     // allowed workspace dir
let outside: string;     // dir OUTSIDE the sandbox
let tools: Tool[];
let toolsWithDelete: Tool[];

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'agenc-fs-test-'));
  outside = await mkdtemp(join(tmpdir(), 'agenc-fs-outside-'));

  tools = makeTools({ allowedPaths: [sandbox] });
  toolsWithDelete = makeTools({ allowedPaths: [sandbox], allowDelete: true });
});

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════════════════════
// 1. FUNCTIONAL TESTS — verify each tool works on a real filesystem
// ════════════════════════════════════════════════════════════════════════════

describe('Functional: system.writeFile + system.readFile round-trip', () => {
  it('writes and reads back a text file', async () => {
    const write = findTool(tools, 'system.writeFile');
    const read = findTool(tools, 'system.readFile');
    const filePath = join(sandbox, 'hello.txt');

    const wr = await write.execute({ path: filePath, content: 'Hello AgenC!' });
    expect(wr.isError).toBeFalsy();

    const rr = await read.execute({ path: filePath });
    expect(rr.isError).toBeFalsy();
    const data = parse(rr);
    expect(data.content).toBe('Hello AgenC!');
    expect(data.encoding).toBe('utf-8');
  });

  it('writes and reads back a binary file via base64', async () => {
    const write = findTool(tools, 'system.writeFile');
    const read = findTool(tools, 'system.readFile');
    const filePath = join(sandbox, 'binary.bin');

    // 4 null bytes — triggers binary detection
    const b64 = Buffer.from([0x00, 0x01, 0x02, 0x00]).toString('base64');
    const wr = await write.execute({ path: filePath, content: b64, encoding: 'base64' });
    expect(wr.isError).toBeFalsy();

    const rr = await read.execute({ path: filePath });
    expect(rr.isError).toBeFalsy();
    const data = parse(rr);
    expect(data.encoding).toBe('base64');
    // Decode and verify round-trip
    const buf = Buffer.from(data.content as string, 'base64');
    expect(buf[0]).toBe(0x00);
    expect(buf[1]).toBe(0x01);
    expect(buf[2]).toBe(0x02);
    expect(buf[3]).toBe(0x00);
  });

  it('creates parent directories automatically', async () => {
    const write = findTool(tools, 'system.writeFile');
    const read = findTool(tools, 'system.readFile');
    const filePath = join(sandbox, 'deep', 'nested', 'dir', 'file.txt');

    const wr = await write.execute({ path: filePath, content: 'deep' });
    expect(wr.isError).toBeFalsy();

    const rr = await read.execute({ path: filePath });
    expect(rr.isError).toBeFalsy();
    expect(parse(rr).content).toBe('deep');
  });
});

describe('Functional: system.appendFile', () => {
  it('appends to an existing file', async () => {
    const write = findTool(tools, 'system.writeFile');
    const append = findTool(tools, 'system.appendFile');
    const read = findTool(tools, 'system.readFile');
    const filePath = join(sandbox, 'append.txt');

    await write.execute({ path: filePath, content: 'line1\n' });
    await append.execute({ path: filePath, content: 'line2\n' });

    const rr = await read.execute({ path: filePath });
    expect(parse(rr).content).toBe('line1\nline2\n');
  });

  it('creates the file if it does not exist', async () => {
    const append = findTool(tools, 'system.appendFile');
    const read = findTool(tools, 'system.readFile');
    const filePath = join(sandbox, 'append-new.txt');

    await append.execute({ path: filePath, content: 'created' });

    const rr = await read.execute({ path: filePath });
    expect(parse(rr).content).toBe('created');
  });
});

describe('Functional: system.listDir', () => {
  it('lists files and directories with correct types', async () => {
    const dir = join(sandbox, 'listtest');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.txt'), 'aaa');
    await mkdir(join(dir, 'subdir'), { recursive: true });

    const listDir = findTool(tools, 'system.listDir');
    const rr = await listDir.execute({ path: dir });
    expect(rr.isError).toBeFalsy();

    const data = parse(rr);
    const entries = data.entries as { name: string; type: string; size: number }[];
    expect(entries.length).toBe(2);

    const file = entries.find((e) => e.name === 'a.txt');
    const sub = entries.find((e) => e.name === 'subdir');
    expect(file).toBeDefined();
    expect(file!.type).toBe('file');
    expect(file!.size).toBe(3);
    expect(sub).toBeDefined();
    expect(sub!.type).toBe('dir');
  });

  it('returns error for non-existent directory', async () => {
    const listDir = findTool(tools, 'system.listDir');
    const rr = await listDir.execute({ path: join(sandbox, 'nope') });
    expect(rr.isError).toBe(true);
  });
});

describe('Functional: system.stat', () => {
  it('returns correct metadata for a file', async () => {
    const filePath = join(sandbox, 'stat-file.txt');
    await writeFile(filePath, 'hello');

    const statTool = findTool(tools, 'system.stat');
    const rr = await statTool.execute({ path: filePath });
    expect(rr.isError).toBeFalsy();

    const data = parse(rr);
    expect(data.size).toBe(5);
    expect(data.isFile).toBe(true);
    expect(data.isDirectory).toBe(false);
    expect(typeof data.modified).toBe('string');
    expect(typeof data.permissions).toBe('string');
  });

  it('returns correct metadata for a directory', async () => {
    const dirPath = join(sandbox, 'stat-dir');
    await mkdir(dirPath, { recursive: true });

    const statTool = findTool(tools, 'system.stat');
    const rr = await statTool.execute({ path: dirPath });
    expect(rr.isError).toBeFalsy();

    const data = parse(rr);
    expect(data.isFile).toBe(false);
    expect(data.isDirectory).toBe(true);
  });
});

describe('Functional: system.mkdir', () => {
  it('creates nested directories', async () => {
    const mkdirTool = findTool(tools, 'system.mkdir');
    const dirPath = join(sandbox, 'a', 'b', 'c');

    const rr = await mkdirTool.execute({ path: dirPath });
    expect(rr.isError).toBeFalsy();

    const statTool = findTool(tools, 'system.stat');
    const sr = await statTool.execute({ path: dirPath });
    expect(parse(sr).isDirectory).toBe(true);
  });
});

describe('Functional: system.delete', () => {
  it('deletes a file when allowDelete is true', async () => {
    const filePath = join(sandbox, 'to-delete.txt');
    await writeFile(filePath, 'bye');

    const del = findTool(toolsWithDelete, 'system.delete');
    const rr = await del.execute({ path: filePath });
    expect(rr.isError).toBeFalsy();
    expect(parse(rr).deleted).toBe(true);

    // Verify it's gone
    const statTool = findTool(tools, 'system.stat');
    const sr = await statTool.execute({ path: filePath });
    expect(sr.isError).toBe(true);
  });

  it('rejects directory deletion without recursive flag', async () => {
    const dirPath = join(sandbox, 'dir-no-recursive');
    await mkdir(dirPath, { recursive: true });

    const del = findTool(toolsWithDelete, 'system.delete');
    const rr = await del.execute({ path: dirPath });
    expect(rr.isError).toBe(true);
    expect(parse(rr).error).toContain('recursive');

    // Verify directory still exists
    const statTool = findTool(tools, 'system.stat');
    const sr = await statTool.execute({ path: dirPath });
    expect(sr.isError).toBeFalsy();
  });

  it('deletes a directory recursively with recursive: true', async () => {
    const dirPath = join(sandbox, 'dir-to-delete');
    await mkdir(join(dirPath, 'sub'), { recursive: true });
    await writeFile(join(dirPath, 'sub', 'f.txt'), 'data');

    const del = findTool(toolsWithDelete, 'system.delete');
    const rr = await del.execute({ path: dirPath, recursive: true });
    expect(rr.isError).toBeFalsy();

    const statTool = findTool(tools, 'system.stat');
    const sr = await statTool.execute({ path: dirPath });
    expect(sr.isError).toBe(true);
  });

  it('rejects deletion of sandbox root directory', async () => {
    const del = findTool(toolsWithDelete, 'system.delete');
    const rr = await del.execute({ path: sandbox, recursive: true });
    expect(rr.isError).toBe(true);
    expect(parse(rr).error).toContain('sandbox root');

    // Verify sandbox still exists
    const statTool = findTool(tools, 'system.stat');
    const sr = await statTool.execute({ path: sandbox });
    expect(sr.isError).toBeFalsy();
    expect(parse(sr).isDirectory).toBe(true);
  });

  it('rejects delete when allowDelete is false (default)', async () => {
    const filePath = join(sandbox, 'no-delete.txt');
    await writeFile(filePath, 'nope');

    const del = findTool(tools, 'system.delete'); // tools without allowDelete
    const rr = await del.execute({ path: filePath });
    expect(rr.isError).toBe(true);
    expect(parse(rr).error).toContain('disabled');
  });
});

describe('Functional: system.move', () => {
  it('moves a file within the sandbox', async () => {
    const src = join(sandbox, 'move-src.txt');
    const dst = join(sandbox, 'move-dst.txt');
    await writeFile(src, 'moveme');

    const move = findTool(tools, 'system.move');
    const rr = await move.execute({ source: src, destination: dst });
    expect(rr.isError).toBeFalsy();
    expect(parse(rr).moved).toBe(true);

    // Source should be gone
    const statTool = findTool(tools, 'system.stat');
    const sr = await statTool.execute({ path: src });
    expect(sr.isError).toBe(true);

    // Destination should exist
    const read = findTool(tools, 'system.readFile');
    const rd = await read.execute({ path: dst });
    expect(parse(rd).content).toBe('moveme');
  });

  it('creates destination parent directories', async () => {
    const src = join(sandbox, 'move-src2.txt');
    const dst = join(sandbox, 'new-parent', 'new-child', 'moved.txt');
    await writeFile(src, 'data');

    const move = findTool(tools, 'system.move');
    const rr = await move.execute({ source: src, destination: dst });
    expect(rr.isError).toBeFalsy();

    const read = findTool(tools, 'system.readFile');
    const rd = await read.execute({ path: dst });
    expect(parse(rd).content).toBe('data');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. SECURITY TESTS — verify allowlist, traversal, and symlink protections
// ════════════════════════════════════════════════════════════════════════════

describe('Security: path allowlist enforcement', () => {
  it('blocks readFile outside sandbox', async () => {
    const outsideFile = join(outside, 'secret.txt');
    await writeFile(outsideFile, 'secret data');

    const read = findTool(tools, 'system.readFile');
    const rr = await read.execute({ path: outsideFile });
    expect(rr.isError).toBe(true);
    expect(parse(rr).error).toContain('outside allowed');
  });

  it('blocks writeFile outside sandbox', async () => {
    const write = findTool(tools, 'system.writeFile');
    const rr = await write.execute({ path: join(outside, 'hack.txt'), content: 'pwned' });
    expect(rr.isError).toBe(true);
    expect(parse(rr).error).toContain('outside allowed');
  });

  it('blocks appendFile outside sandbox', async () => {
    const append = findTool(tools, 'system.appendFile');
    const rr = await append.execute({ path: join(outside, 'hack.txt'), content: 'pwned' });
    expect(rr.isError).toBe(true);
    expect(parse(rr).error).toContain('outside allowed');
  });

  it('blocks listDir outside sandbox', async () => {
    const listDir = findTool(tools, 'system.listDir');
    const rr = await listDir.execute({ path: outside });
    expect(rr.isError).toBe(true);
    expect(parse(rr).error).toContain('outside allowed');
  });

  it('blocks stat outside sandbox', async () => {
    const statTool = findTool(tools, 'system.stat');
    const rr = await statTool.execute({ path: outside });
    expect(rr.isError).toBe(true);
    expect(parse(rr).error).toContain('outside allowed');
  });

  it('blocks mkdir outside sandbox', async () => {
    const mkdirTool = findTool(tools, 'system.mkdir');
    const rr = await mkdirTool.execute({ path: join(outside, 'escape') });
    expect(rr.isError).toBe(true);
    expect(parse(rr).error).toContain('outside allowed');
  });

  it('blocks delete outside sandbox', async () => {
    const del = findTool(toolsWithDelete, 'system.delete');
    const outsideFile = join(outside, 'protected.txt');
    await writeFile(outsideFile, 'safe');

    const rr = await del.execute({ path: outsideFile });
    expect(rr.isError).toBe(true);
    expect(parse(rr).error).toContain('outside allowed');

    // Verify file is still there
    const content = await readFile(outsideFile, 'utf-8');
    expect(content).toBe('safe');
  });

  it('blocks move source outside sandbox', async () => {
    const outsideFile = join(outside, 'src.txt');
    await writeFile(outsideFile, 'data');

    const move = findTool(tools, 'system.move');
    const rr = await move.execute({ source: outsideFile, destination: join(sandbox, 'stolen.txt') });
    expect(rr.isError).toBe(true);
    expect(parse(rr).error).toContain('outside allowed');
  });

  it('blocks move destination outside sandbox (exfiltration)', async () => {
    const src = join(sandbox, 'exfil-src.txt');
    await writeFile(src, 'sensitive');

    const move = findTool(tools, 'system.move');
    const rr = await move.execute({ source: src, destination: join(outside, 'exfil.txt') });
    expect(rr.isError).toBe(true);
    expect(parse(rr).error).toContain('outside allowed');
  });
});

describe('Security: path traversal prevention', () => {
  it('blocks ../ traversal in readFile (caught by allowlist layer)', async () => {
    const read = findTool(tools, 'system.readFile');
    // path.join resolves '..', so the allowlist layer catches it as outside sandbox
    const rr = await read.execute({ path: join(sandbox, '..', '..', 'etc', 'passwd') });
    expect(rr.isError).toBe(true);
    expect(parse(rr).error).toContain('outside allowed');
  });

  it('blocks ../ traversal in writeFile (caught by allowlist layer)', async () => {
    const write = findTool(tools, 'system.writeFile');
    const rr = await write.execute({ path: join(sandbox, '..', 'escape.txt'), content: 'x' });
    expect(rr.isError).toBe(true);
    expect(parse(rr).error).toContain('outside allowed');
  });

  it('blocks ../ traversal in mkdir (caught by allowlist layer)', async () => {
    const mkdirTool = findTool(tools, 'system.mkdir');
    const rr = await mkdirTool.execute({ path: join(sandbox, '..', 'escape-dir') });
    expect(rr.isError).toBe(true);
    expect(parse(rr).error).toContain('outside allowed');
  });

  it('blocks ../ traversal in move destination (caught by allowlist layer)', async () => {
    const src = join(sandbox, 'traverse-src.txt');
    await writeFile(src, 'data');

    const move = findTool(tools, 'system.move');
    const rr = await move.execute({
      source: src,
      destination: join(sandbox, '..', 'escaped.txt'),
    });
    expect(rr.isError).toBe(true);
    expect(parse(rr).error).toContain('outside allowed');
  });

  it('blocks raw ../ segment strings (caught by traversal detector)', async () => {
    // Pass raw string with .. segment that path.join would normally resolve
    const read = findTool(tools, 'system.readFile');
    const rr = await read.execute({ path: sandbox + '/subdir/../../../etc/passwd' });
    expect(rr.isError).toBe(true);
    expect(parse(rr).error).toContain('traversal');
  });

  it('allows filenames containing double dots (file..txt)', async () => {
    const write = findTool(tools, 'system.writeFile');
    const read = findTool(tools, 'system.readFile');
    const filePath = join(sandbox, 'file..txt');

    const wr = await write.execute({ path: filePath, content: 'dots' });
    expect(wr.isError).toBeFalsy();

    const rr = await read.execute({ path: filePath });
    expect(parse(rr).content).toBe('dots');
  });
});

describe('Security: null byte injection', () => {
  it('blocks null byte in readFile path', async () => {
    const read = findTool(tools, 'system.readFile');
    const rr = await read.execute({ path: join(sandbox, 'file\x00.txt') });
    expect(rr.isError).toBe(true);
    expect(parse(rr).error).toContain('null byte');
  });

  it('blocks null byte in writeFile path', async () => {
    const write = findTool(tools, 'system.writeFile');
    const rr = await write.execute({ path: join(sandbox, 'file\x00.txt'), content: 'x' });
    expect(rr.isError).toBe(true);
    expect(parse(rr).error).toContain('null byte');
  });
});

describe('Security: symlink escape prevention', () => {
  it('blocks readFile through symlink pointing outside sandbox', async () => {
    const outsideFile = join(outside, 'symlink-target.txt');
    await writeFile(outsideFile, 'secret via symlink');

    const link = join(sandbox, 'evil-link');
    await symlink(outsideFile, link);

    const read = findTool(tools, 'system.readFile');
    const rr = await read.execute({ path: link });
    expect(rr.isError).toBe(true);
    expect(parse(rr).error).toContain('outside allowed');
  });

  it('blocks writeFile through symlink pointing outside sandbox', async () => {
    const outsideFile = join(outside, 'symlink-write-target.txt');
    await writeFile(outsideFile, 'original');

    const link = join(sandbox, 'evil-write-link');
    await symlink(outsideFile, link);

    const write = findTool(tools, 'system.writeFile');
    const rr = await write.execute({ path: link, content: 'overwritten!' });
    expect(rr.isError).toBe(true);
    expect(parse(rr).error).toContain('outside allowed');

    // Verify file was NOT modified
    const content = await readFile(outsideFile, 'utf-8');
    expect(content).toBe('original');
  });

  it('blocks delete through symlink pointing outside sandbox', async () => {
    const outsideFile = join(outside, 'symlink-delete-target.txt');
    await writeFile(outsideFile, 'protect me');

    const link = join(sandbox, 'evil-delete-link');
    await symlink(outsideFile, link);

    const del = findTool(toolsWithDelete, 'system.delete');
    const rr = await del.execute({ path: link });
    expect(rr.isError).toBe(true);
    expect(parse(rr).error).toContain('outside allowed');

    // Verify file still exists
    const content = await readFile(outsideFile, 'utf-8');
    expect(content).toBe('protect me');
  });

  it('blocks stat through symlink pointing outside sandbox', async () => {
    const outsideFile = join(outside, 'symlink-stat-target.txt');
    await writeFile(outsideFile, 'metadata');

    const link = join(sandbox, 'evil-stat-link');
    await symlink(outsideFile, link);

    const statTool = findTool(tools, 'system.stat');
    const rr = await statTool.execute({ path: link });
    expect(rr.isError).toBe(true);
    expect(parse(rr).error).toContain('outside allowed');
  });

  it('blocks move through directory symlink pointing outside', async () => {
    // Create a symlink to outside dir
    const link = join(sandbox, 'evil-dir-link');
    await symlink(outside, link);

    const src = join(sandbox, 'move-via-link.txt');
    await writeFile(src, 'data');

    const move = findTool(tools, 'system.move');
    const rr = await move.execute({
      source: src,
      destination: join(link, 'stolen.txt'),
    });
    expect(rr.isError).toBe(true);
    expect(parse(rr).error).toContain('outside allowed');
  });
});

describe('Security: hard-link escape (known limitation)', () => {
  it('allows read via in-sandbox hard link to outside inode (documents limitation)', async () => {
    // Hard links bypass path-based security: the link path IS inside the sandbox,
    // so realpath returns the sandbox path. The inode points outside, but
    // path-based checks cannot detect this. This test documents the limitation.
    const outsideFile = join(outside, 'hardlink-target.txt');
    await writeFile(outsideFile, 'secret-via-hardlink');

    const hardLink = join(sandbox, 'hardlink-inside');
    try {
      await link(outsideFile, hardLink);
    } catch {
      // Cross-device hard links fail on some systems — skip test
      return;
    }

    const read = findTool(tools, 'system.readFile');
    const rr = await read.execute({ path: hardLink });

    // This SUCCEEDS — path-based security cannot detect hard-link escapes.
    // Mitigation requires OS-level sandboxing (chroot, namespaces, seccomp).
    expect(rr.isError).toBeFalsy();
    expect(parse(rr).content).toBe('secret-via-hardlink');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. ENCODING & VALIDATION TESTS
// ════════════════════════════════════════════════════════════════════════════

describe('Validation: encoding and content', () => {
  it('rejects invalid encoding in readFile', async () => {
    const filePath = join(sandbox, 'enc-test.txt');
    await writeFile(filePath, 'data');

    const read = findTool(tools, 'system.readFile');
    const rr = await read.execute({ path: filePath, encoding: 'latin1' });
    expect(rr.isError).toBe(true);
    expect(parse(rr).error).toContain('encoding');
  });

  it('rejects invalid encoding in writeFile', async () => {
    const write = findTool(tools, 'system.writeFile');
    const rr = await write.execute({
      path: join(sandbox, 'enc-test2.txt'),
      content: 'data',
      encoding: 'ascii',
    });
    expect(rr.isError).toBe(true);
    expect(parse(rr).error).toContain('encoding');
  });

  it('rejects malformed base64 content in writeFile', async () => {
    const write = findTool(tools, 'system.writeFile');
    const rr = await write.execute({
      path: join(sandbox, 'bad-b64.bin'),
      content: 'not!valid!base64',
      encoding: 'base64',
    });
    expect(rr.isError).toBe(true);
    expect(parse(rr).error).toContain('base64');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. SIZE LIMIT TESTS
// ════════════════════════════════════════════════════════════════════════════

describe('Limits: file size enforcement', () => {
  it('rejects reading a file that exceeds maxReadBytes', async () => {
    const smallTools = makeTools({ allowedPaths: [sandbox], maxReadBytes: 10 });
    const filePath = join(sandbox, 'big-read.txt');
    await writeFile(filePath, 'A'.repeat(100));

    const read = findTool(smallTools, 'system.readFile');
    const rr = await read.execute({ path: filePath });
    expect(rr.isError).toBe(true);
    expect(parse(rr).error).toContain('exceeds');
  });

  it('rejects writing content that exceeds maxWriteBytes', async () => {
    const smallTools = makeTools({ allowedPaths: [sandbox], maxWriteBytes: 10 });
    const write = findTool(smallTools, 'system.writeFile');
    const rr = await write.execute({
      path: join(sandbox, 'big-write.txt'),
      content: 'A'.repeat(100),
    });
    expect(rr.isError).toBe(true);
    expect(parse(rr).error).toContain('exceeds');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. EDGE CASES
// ════════════════════════════════════════════════════════════════════════════

describe('Edge cases', () => {
  it('handles empty file correctly', async () => {
    const filePath = join(sandbox, 'empty.txt');
    await writeFile(filePath, '');

    const read = findTool(tools, 'system.readFile');
    const rr = await read.execute({ path: filePath });
    expect(rr.isError).toBeFalsy();
    expect(parse(rr).content).toBe('');
  });

  it('readFile returns error for non-existent file', async () => {
    const read = findTool(tools, 'system.readFile');
    const rr = await read.execute({ path: join(sandbox, 'does-not-exist.txt') });
    expect(rr.isError).toBe(true);
    expect(parse(rr).error).toContain('not found');
  });

  it('stat returns error for non-existent path', async () => {
    const statTool = findTool(tools, 'system.stat');
    const rr = await statTool.execute({ path: join(sandbox, 'ghost') });
    expect(rr.isError).toBe(true);
  });

  it('returns correct tool count (8 tools)', () => {
    expect(tools.length).toBe(8);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
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

  it('all tools have valid inputSchema', () => {
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.required).toBeDefined();
      expect(Array.isArray(tool.inputSchema.required)).toBe(true);
    }
  });

  it('handles concurrent writes to different files', async () => {
    const write = findTool(tools, 'system.writeFile');
    const read = findTool(tools, 'system.readFile');

    const promises = Array.from({ length: 10 }, (_, i) =>
      write.execute({ path: join(sandbox, `concurrent-${i}.txt`), content: `file-${i}` }),
    );
    const results = await Promise.all(promises);
    expect(results.every((r) => !r.isError)).toBe(true);

    // Verify all files
    for (let i = 0; i < 10; i++) {
      const rr = await read.execute({ path: join(sandbox, `concurrent-${i}.txt`) });
      expect(parse(rr).content).toBe(`file-${i}`);
    }
  });

  it('never throws from execute — always returns ToolResult', async () => {
    // Feed garbage inputs to every tool — none should throw
    for (const tool of tools) {
      const result = await tool.execute({});
      // Should return an error result, not throw
      expect(result).toBeDefined();
      expect(typeof result.content).toBe('string');
    }
  });
});

// ============================================================================
// Integration: listDir symlink type accuracy on real FS
// ============================================================================

describe('Integration: listDir symlink/other type accuracy', () => {
  it('reports symlink type for symlinks in directory listing', async () => {
    const dir = join(sandbox, 'listdir-symlink-types');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'real.txt'), 'hello');
    // Symlink pointing outside sandbox (to /tmp which exists on all platforms)
    await symlink('/tmp', join(dir, 'outside-link'));
    // Symlink pointing within sandbox
    await symlink(join(dir, 'real.txt'), join(dir, 'inside-link'));

    const listDir = findTool(tools, 'system.listDir');
    const rr = await listDir.execute({ path: dir });
    expect(rr.isError).toBeFalsy();

    const data = parse(rr);
    const entries = data.entries as { name: string; type: string; size: number }[];

    const realFile = entries.find((e) => e.name === 'real.txt');
    expect(realFile).toBeDefined();
    expect(realFile!.type).toBe('file');
    expect(realFile!.size).toBeGreaterThan(0);

    const outsideLink = entries.find((e) => e.name === 'outside-link');
    expect(outsideLink).toBeDefined();
    expect(outsideLink!.type).toBe('symlink');
    // Symlink size should be 0 (not the target's size, since lstat is used)
    expect(outsideLink!.size).toBe(0);

    const insideLink = entries.find((e) => e.name === 'inside-link');
    expect(insideLink).toBeDefined();
    expect(insideLink!.type).toBe('symlink');
  });
});
