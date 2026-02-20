/**
 * Unit tests for the prover backends.
 *
 * Local binary tests mock child_process.spawn with EventEmitter-based stubs.
 * Remote tests mock globalThis.fetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  prove,
  ProverError,
  type ProverInput,
  type LocalBinaryProverConfig,
  type RemoteProverConfig,
} from '../prover';
import {
  RISC0_SEAL_BORSH_LEN,
  RISC0_JOURNAL_LEN,
  RISC0_IMAGE_ID_LEN,
} from '../constants';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validInput(): ProverInput {
  return {
    taskPda: new Uint8Array(32).fill(1),
    agentAuthority: new Uint8Array(32).fill(2),
    constraintHash: new Uint8Array(32).fill(3),
    outputCommitment: new Uint8Array(32).fill(4),
    binding: new Uint8Array(32).fill(5),
    nullifier: new Uint8Array(32).fill(6),
  };
}

function validOutputPayload() {
  return {
    seal_bytes: Array.from({ length: RISC0_SEAL_BORSH_LEN }, (_, i) => i & 0xff),
    journal: Array.from({ length: RISC0_JOURNAL_LEN }, (_, i) => (i * 3) & 0xff),
    image_id: Array.from({ length: RISC0_IMAGE_ID_LEN }, (_, i) => (i * 7) & 0xff),
  };
}

function validOutputJson(): string {
  return JSON.stringify(validOutputPayload());
}

// ---------------------------------------------------------------------------
// Input validation (tested via remote backend to avoid child_process mocking)
// ---------------------------------------------------------------------------

describe('prove — input validation', () => {
  const remoteConfig: RemoteProverConfig = {
    kind: 'remote',
    endpoint: 'https://prover.example.com',
  };

  it('rejects taskPda that is not 32 bytes', async () => {
    const input = validInput();
    input.taskPda = new Uint8Array(16);
    await expect(prove(input, remoteConfig)).rejects.toThrow('taskPda must be exactly 32 bytes');
  });

  it('rejects agentAuthority that is not 32 bytes', async () => {
    const input = validInput();
    input.agentAuthority = new Uint8Array(0);
    await expect(prove(input, remoteConfig)).rejects.toThrow('agentAuthority must be exactly 32 bytes');
  });

  it('rejects constraintHash that is not 32 bytes', async () => {
    const input = validInput();
    input.constraintHash = new Uint8Array(64);
    await expect(prove(input, remoteConfig)).rejects.toThrow('constraintHash must be exactly 32 bytes');
  });

  it('rejects outputCommitment that is not 32 bytes', async () => {
    const input = validInput();
    input.outputCommitment = new Uint8Array(31);
    await expect(prove(input, remoteConfig)).rejects.toThrow('outputCommitment must be exactly 32 bytes');
  });

  it('rejects binding that is not 32 bytes', async () => {
    const input = validInput();
    input.binding = new Uint8Array(33);
    await expect(prove(input, remoteConfig)).rejects.toThrow('binding must be exactly 32 bytes');
  });

  it('rejects nullifier that is not 32 bytes', async () => {
    const input = validInput();
    input.nullifier = new Uint8Array(1);
    await expect(prove(input, remoteConfig)).rejects.toThrow('nullifier must be exactly 32 bytes');
  });
});

// ---------------------------------------------------------------------------
// Remote backend (uses fetch mock — reliable and straightforward)
// ---------------------------------------------------------------------------

describe('prove — remote backend', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns valid buffers on HTTP 200', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(validOutputPayload()),
    }) as unknown as typeof fetch;

    const config: RemoteProverConfig = {
      kind: 'remote',
      endpoint: 'https://prover.example.com',
    };

    const result = await prove(validInput(), config);
    expect(result.sealBytes.length).toBe(RISC0_SEAL_BORSH_LEN);
    expect(result.journal.length).toBe(RISC0_JOURNAL_LEN);
    expect(result.imageId.length).toBe(RISC0_IMAGE_ID_LEN);
    expect(Buffer.isBuffer(result.sealBytes)).toBe(true);
    expect(Buffer.isBuffer(result.journal)).toBe(true);
    expect(Buffer.isBuffer(result.imageId)).toBe(true);

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe('https://prover.example.com/prove');
    expect(calls[0][1].method).toBe('POST');
  });

  it('appends /prove to endpoint without trailing slash', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(validOutputPayload()),
    }) as unknown as typeof fetch;

    const config: RemoteProverConfig = {
      kind: 'remote',
      endpoint: 'https://prover.example.com/api',
    };

    await prove(validInput(), config);
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe('https://prover.example.com/api/prove');
  });

  it('does not double-append /prove if already present', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(validOutputPayload()),
    }) as unknown as typeof fetch;

    const config: RemoteProverConfig = {
      kind: 'remote',
      endpoint: 'https://prover.example.com/prove',
    };

    await prove(validInput(), config);
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe('https://prover.example.com/prove');
  });

  it('strips trailing slashes from endpoint', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(validOutputPayload()),
    }) as unknown as typeof fetch;

    const config: RemoteProverConfig = {
      kind: 'remote',
      endpoint: 'https://prover.example.com/api/',
    };

    await prove(validInput(), config);
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe('https://prover.example.com/api/prove');
  });

  it('wraps HTTP error in ProverError', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    }) as unknown as typeof fetch;

    const config: RemoteProverConfig = {
      kind: 'remote',
      endpoint: 'https://prover.example.com',
    };

    await expect(prove(validInput(), config)).rejects.toThrow(ProverError);
    try {
      await prove(validInput(), config);
    } catch (err) {
      expect(err).toBeInstanceOf(ProverError);
      expect((err as ProverError).backend).toBe('remote');
      expect((err as ProverError).message).toContain('HTTP 500');
    }
  });

  it('wraps network failure in ProverError', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(
      new TypeError('Failed to fetch'),
    ) as unknown as typeof fetch;

    const config: RemoteProverConfig = {
      kind: 'remote',
      endpoint: 'https://prover.example.com',
    };

    await expect(prove(validInput(), config)).rejects.toThrow(ProverError);
    try {
      await prove(validInput(), config);
    } catch (err) {
      expect(err).toBeInstanceOf(ProverError);
      expect((err as ProverError).message).toContain('request failed');
    }
  });

  it('passes custom headers', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(validOutputPayload()),
    }) as unknown as typeof fetch;

    const config: RemoteProverConfig = {
      kind: 'remote',
      endpoint: 'https://prover.example.com',
      headers: { Authorization: 'Bearer token123' },
    };

    await prove(validInput(), config);
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][1].headers).toMatchObject({
      Authorization: 'Bearer token123',
      'Content-Type': 'application/json',
    });
  });

  it('sends correct JSON body with all 6 fields', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(validOutputPayload()),
    }) as unknown as typeof fetch;

    const input = validInput();
    await prove(input, { kind: 'remote', endpoint: 'https://test.com' });

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const body = JSON.parse(calls[0][1].body);
    expect(body.task_pda).toHaveLength(32);
    expect(body.agent_authority).toHaveLength(32);
    expect(body.constraint_hash).toHaveLength(32);
    expect(body.output_commitment).toHaveLength(32);
    expect(body.binding).toHaveLength(32);
    expect(body.nullifier).toHaveLength(32);
    // Verify values match input
    expect(body.task_pda).toEqual(Array.from(input.taskPda));
    expect(body.nullifier).toEqual(Array.from(input.nullifier));
  });
});

// ---------------------------------------------------------------------------
// Output validation (tested via remote backend)
// ---------------------------------------------------------------------------

describe('prove — output validation', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('rejects seal_bytes with wrong length', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        seal_bytes: [1, 2, 3],
        journal: Array.from({ length: RISC0_JOURNAL_LEN }, () => 0),
        image_id: Array.from({ length: RISC0_IMAGE_ID_LEN }, () => 0),
      }),
    }) as unknown as typeof fetch;

    const config: RemoteProverConfig = { kind: 'remote', endpoint: 'https://test.com' };
    await expect(prove(validInput(), config)).rejects.toThrow(
      `seal_bytes must be ${RISC0_SEAL_BORSH_LEN} bytes`,
    );
  });

  it('rejects journal with wrong length', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        seal_bytes: Array.from({ length: RISC0_SEAL_BORSH_LEN }, () => 0),
        journal: [1, 2],
        image_id: Array.from({ length: RISC0_IMAGE_ID_LEN }, () => 0),
      }),
    }) as unknown as typeof fetch;

    const config: RemoteProverConfig = { kind: 'remote', endpoint: 'https://test.com' };
    await expect(prove(validInput(), config)).rejects.toThrow(
      `journal must be ${RISC0_JOURNAL_LEN} bytes`,
    );
  });

  it('rejects image_id with wrong length', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        seal_bytes: Array.from({ length: RISC0_SEAL_BORSH_LEN }, () => 0),
        journal: Array.from({ length: RISC0_JOURNAL_LEN }, () => 0),
        image_id: [1],
      }),
    }) as unknown as typeof fetch;

    const config: RemoteProverConfig = { kind: 'remote', endpoint: 'https://test.com' };
    await expect(prove(validInput(), config)).rejects.toThrow(
      `image_id must be ${RISC0_IMAGE_ID_LEN} bytes`,
    );
  });

  it('rejects missing seal_bytes array', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        journal: Array.from({ length: RISC0_JOURNAL_LEN }, () => 0),
        image_id: Array.from({ length: RISC0_IMAGE_ID_LEN }, () => 0),
      }),
    }) as unknown as typeof fetch;

    const config: RemoteProverConfig = { kind: 'remote', endpoint: 'https://test.com' };
    await expect(prove(validInput(), config)).rejects.toThrow(
      'prover output missing seal_bytes array',
    );
  });

  it('rejects missing journal array', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        seal_bytes: Array.from({ length: RISC0_SEAL_BORSH_LEN }, () => 0),
        image_id: Array.from({ length: RISC0_IMAGE_ID_LEN }, () => 0),
      }),
    }) as unknown as typeof fetch;

    const config: RemoteProverConfig = { kind: 'remote', endpoint: 'https://test.com' };
    await expect(prove(validInput(), config)).rejects.toThrow(
      'prover output missing journal array',
    );
  });

  it('rejects missing image_id array', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        seal_bytes: Array.from({ length: RISC0_SEAL_BORSH_LEN }, () => 0),
        journal: Array.from({ length: RISC0_JOURNAL_LEN }, () => 0),
      }),
    }) as unknown as typeof fetch;

    const config: RemoteProverConfig = { kind: 'remote', endpoint: 'https://test.com' };
    await expect(prove(validInput(), config)).rejects.toThrow(
      'prover output missing image_id array',
    );
  });
});

// ---------------------------------------------------------------------------
// Local binary backend
// ---------------------------------------------------------------------------

describe('prove — local-binary backend', () => {
  // We test local-binary by mocking child_process.spawn at the module level
  let spawnMock: ReturnType<typeof vi.fn>;

  function mockSpawnWith(stdout: string, stderr: string, exitCode: number) {
    const { EventEmitter } = require('node:events');

    const child = new EventEmitter();
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    child.stdout = stdoutEmitter;
    child.stderr = stderrEmitter;
    child.stdin = {
      write: vi.fn(),
      end: vi.fn(),
    };

    // Schedule data + close events after listeners have been attached
    setImmediate(() => {
      if (stdout) stdoutEmitter.emit('data', Buffer.from(stdout));
      if (stderr) stderrEmitter.emit('data', Buffer.from(stderr));
      setImmediate(() => child.emit('close', exitCode));
    });

    spawnMock.mockReturnValue(child);
    return child;
  }

  function mockSpawnError(errorMessage: string) {
    const { EventEmitter } = require('node:events');

    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      write: vi.fn(),
      end: vi.fn(),
    };

    setImmediate(() => {
      const err = new Error(errorMessage) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      child.emit('error', err);
    });

    spawnMock.mockReturnValue(child);
    return child;
  }

  beforeEach(() => {
    spawnMock = vi.fn();
    vi.doMock('node:child_process', () => ({
      spawn: spawnMock,
    }));
  });

  afterEach(() => {
    vi.doUnmock('node:child_process');
    vi.restoreAllMocks();
  });

  it('returns valid buffers on successful spawn', async () => {
    mockSpawnWith(validOutputJson(), '', 0);

    const { prove: proveMocked } = await import('../prover');
    const config: LocalBinaryProverConfig = {
      kind: 'local-binary',
      binaryPath: '/test/bin',
    };

    const result = await proveMocked(validInput(), config);
    expect(result.sealBytes.length).toBe(RISC0_SEAL_BORSH_LEN);
    expect(result.journal.length).toBe(RISC0_JOURNAL_LEN);
    expect(result.imageId.length).toBe(RISC0_IMAGE_ID_LEN);
    expect(Buffer.isBuffer(result.sealBytes)).toBe(true);
  });

  it('passes correct args to spawn', async () => {
    mockSpawnWith(validOutputJson(), '', 0);

    const { prove: proveMocked } = await import('../prover');
    await proveMocked(validInput(), {
      kind: 'local-binary',
      binaryPath: '/usr/local/bin/agenc-zkvm-host',
    });

    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/local/bin/agenc-zkvm-host',
      ['prove', '--stdin'],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    );
  });

  it('writes JSON to stdin', async () => {
    const child = mockSpawnWith(validOutputJson(), '', 0);

    const { prove: proveMocked } = await import('../prover');
    await proveMocked(validInput(), {
      kind: 'local-binary',
      binaryPath: '/test/bin',
    });

    expect(child.stdin.write).toHaveBeenCalled();
    const writtenJson = JSON.parse(child.stdin.write.mock.calls[0][0]);
    expect(writtenJson.task_pda).toHaveLength(32);
    expect(writtenJson.nullifier).toHaveLength(32);
    expect(child.stdin.end).toHaveBeenCalled();
  });

  it('wraps non-zero exit code in ProverError', async () => {
    mockSpawnWith('', 'something went wrong', 1);

    const { prove: proveMocked } = await import('../prover');
    const config: LocalBinaryProverConfig = {
      kind: 'local-binary',
      binaryPath: '/test/bin',
    };

    try {
      await proveMocked(validInput(), config);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProverError);
      expect((err as ProverError).backend).toBe('local-binary');
      expect((err as ProverError).message).toContain('exited with code 1');
      expect((err as ProverError).message).toContain('something went wrong');
    }
  });

  it('wraps spawn ENOENT in ProverError', async () => {
    mockSpawnError('spawn ENOENT');

    const { prove: proveMocked } = await import('../prover');
    const config: LocalBinaryProverConfig = {
      kind: 'local-binary',
      binaryPath: '/nonexistent/bin',
    };

    try {
      await proveMocked(validInput(), config);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProverError);
      expect((err as ProverError).backend).toBe('local-binary');
      expect((err as ProverError).message).toContain('failed to spawn');
    }
  });

  it('wraps invalid JSON output in ProverError', async () => {
    mockSpawnWith('not valid json!', '', 0);

    const { prove: proveMocked } = await import('../prover');
    const config: LocalBinaryProverConfig = {
      kind: 'local-binary',
      binaryPath: '/test/bin',
    };

    try {
      await proveMocked(validInput(), config);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProverError);
      expect((err as ProverError).message).toContain('failed to parse prover output');
    }
  });
});

// ---------------------------------------------------------------------------
// ProverError
// ---------------------------------------------------------------------------

describe('ProverError', () => {
  it('has correct name property', () => {
    const err = new ProverError('test', 'local-binary');
    expect(err.name).toBe('ProverError');
    expect(err instanceof Error).toBe(true);
  });

  it('preserves backend type', () => {
    const local = new ProverError('msg', 'local-binary');
    expect(local.backend).toBe('local-binary');

    const remote = new ProverError('msg', 'remote');
    expect(remote.backend).toBe('remote');
  });

  it('preserves cause', () => {
    const originalError = new Error('original');
    const err = new ProverError('wrapped', 'remote', originalError);
    expect(err.cause).toBe(originalError);
  });

  it('message is accessible', () => {
    const err = new ProverError('test message', 'local-binary');
    expect(err.message).toBe('test message');
  });
});
