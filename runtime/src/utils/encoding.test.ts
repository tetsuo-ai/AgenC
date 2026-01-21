import { describe, it, expect } from 'vitest';
import {
  generateAgentId,
  hexToBytes,
  bytesToHex,
  agentIdFromString,
  agentIdToString,
  agentIdToShortString,
  agentIdsEqual,
  lamportsToSol,
  solToLamports,
} from './encoding';

describe('generateAgentId', () => {
  it('produces 32-byte Uint8Array', () => {
    const id = generateAgentId();
    expect(id).toBeInstanceOf(Uint8Array);
    expect(id.length).toBe(32);
  });

  it('produces different results on each call', () => {
    const id1 = generateAgentId();
    const id2 = generateAgentId();
    expect(id1.length).toBe(32);
    expect(id2.length).toBe(32);
    expect(agentIdsEqual(id1, id2)).toBe(false);
  });

  it('produces cryptographically random bytes', () => {
    // Generate multiple IDs and verify they're not all zeros or predictable
    const ids = Array.from({ length: 10 }, () => generateAgentId());

    for (const id of ids) {
      // Should not be all zeros
      expect(id.some((byte) => byte !== 0)).toBe(true);
    }

    // All IDs should be unique
    const hexIds = ids.map((id) => bytesToHex(id));
    const uniqueIds = new Set(hexIds);
    expect(uniqueIds.size).toBe(ids.length);
  });
});

describe('hexToBytes', () => {
  it('converts hex strings without prefix', () => {
    const bytes = hexToBytes('0102030405');
    expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('converts hex strings with 0x prefix', () => {
    const bytes = hexToBytes('0x0102030405');
    expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('handles lowercase hex', () => {
    const bytes = hexToBytes('abcdef');
    expect(bytes).toEqual(new Uint8Array([0xab, 0xcd, 0xef]));
  });

  it('handles uppercase hex', () => {
    const bytes = hexToBytes('ABCDEF');
    expect(bytes).toEqual(new Uint8Array([0xab, 0xcd, 0xef]));
  });

  it('handles mixed case hex', () => {
    const bytes = hexToBytes('AbCdEf');
    expect(bytes).toEqual(new Uint8Array([0xab, 0xcd, 0xef]));
  });

  it('handles empty string', () => {
    const bytes = hexToBytes('');
    expect(bytes).toEqual(new Uint8Array([]));
  });

  it('handles 0x prefix only', () => {
    const bytes = hexToBytes('0x');
    expect(bytes).toEqual(new Uint8Array([]));
  });

  it('throws on odd-length hex string', () => {
    expect(() => hexToBytes('123')).toThrow('Invalid hex string length');
  });

  it('throws on odd-length hex string with prefix', () => {
    expect(() => hexToBytes('0x123')).toThrow('Invalid hex string length');
  });

  it('throws on invalid hex characters', () => {
    expect(() => hexToBytes('gg')).toThrow('Invalid hex string: contains non-hexadecimal characters');
    expect(() => hexToBytes('0xzz')).toThrow('Invalid hex string: contains non-hexadecimal characters');
    expect(() => hexToBytes('hello')).toThrow('Invalid hex string');
    expect(() => hexToBytes('12g4')).toThrow('Invalid hex string');
  });

  it('handles full byte range', () => {
    const bytes = hexToBytes('00ff');
    expect(bytes).toEqual(new Uint8Array([0x00, 0xff]));
  });
});

describe('bytesToHex', () => {
  it('converts bytes to hex without prefix by default', () => {
    const hex = bytesToHex(new Uint8Array([1, 2, 3, 4, 5]));
    expect(hex).toBe('0102030405');
  });

  it('converts bytes to hex with prefix when requested', () => {
    const hex = bytesToHex(new Uint8Array([1, 2, 3]), true);
    expect(hex).toBe('0x010203');
  });

  it('pads single-digit bytes with leading zero', () => {
    const hex = bytesToHex(new Uint8Array([0, 1, 15]));
    expect(hex).toBe('00010f');
  });

  it('handles empty array', () => {
    const hex = bytesToHex(new Uint8Array([]));
    expect(hex).toBe('');
  });

  it('handles empty array with prefix', () => {
    const hex = bytesToHex(new Uint8Array([]), true);
    expect(hex).toBe('0x');
  });

  it('handles full byte range', () => {
    const hex = bytesToHex(new Uint8Array([0x00, 0xff]));
    expect(hex).toBe('00ff');
  });

  it('produces lowercase hex', () => {
    const hex = bytesToHex(new Uint8Array([0xab, 0xcd, 0xef]));
    expect(hex).toBe('abcdef');
  });
});

describe('hexToBytes and bytesToHex roundtrip', () => {
  it('roundtrips correctly', () => {
    const original = '0102030405abcdef';
    const bytes = hexToBytes(original);
    const hex = bytesToHex(bytes);
    expect(hex).toBe(original);
  });

  it('roundtrips from bytes', () => {
    const original = new Uint8Array([0, 128, 255, 1, 2, 3]);
    const hex = bytesToHex(original);
    const bytes = hexToBytes(hex);
    expect(bytes).toEqual(original);
  });
});

describe('agentIdFromString', () => {
  it('converts short string to 32-byte array (padded with zeros)', () => {
    const id = agentIdFromString('my-agent');
    expect(id.length).toBe(32);
    // First 8 bytes should be the UTF-8 encoding of "my-agent"
    const encoder = new TextEncoder();
    const expected = encoder.encode('my-agent');
    expect(id.slice(0, expected.length)).toEqual(expected);
    // Rest should be zeros
    expect(id.slice(expected.length).every((b) => b === 0)).toBe(true);
  });

  it('handles exactly 32-byte string', () => {
    const str = 'a'.repeat(32);
    const id = agentIdFromString(str);
    expect(id.length).toBe(32);
    expect(id.every((b) => b === 97)).toBe(true); // 97 = 'a'
  });

  it('hashes strings longer than 32 bytes', () => {
    const longStr = 'a'.repeat(64);
    const id = agentIdFromString(longStr);
    expect(id.length).toBe(32);
    // Should NOT be all zeros (unlike old XOR-fold behavior)
    expect(id.some((b) => b !== 0)).toBe(true);
  });

  it('produces different IDs for different long strings with repeating patterns', () => {
    // These strings would have collided with XOR-fold but should be unique with hashing
    const id1 = agentIdFromString('a'.repeat(64));
    const id2 = agentIdFromString('b'.repeat(64));
    const id3 = agentIdFromString('ab'.repeat(32));
    const id4 = agentIdFromString('abc'.repeat(22)); // 66 chars

    // All should be 32 bytes
    expect(id1.length).toBe(32);
    expect(id2.length).toBe(32);
    expect(id3.length).toBe(32);
    expect(id4.length).toBe(32);

    // All should be unique
    expect(agentIdsEqual(id1, id2)).toBe(false);
    expect(agentIdsEqual(id1, id3)).toBe(false);
    expect(agentIdsEqual(id2, id3)).toBe(false);
    expect(agentIdsEqual(id3, id4)).toBe(false);
  });

  it('handles empty string', () => {
    const id = agentIdFromString('');
    expect(id.length).toBe(32);
    expect(id.every((b) => b === 0)).toBe(true);
  });

  it('handles unicode characters', () => {
    const id = agentIdFromString('\u{1F600}'); // emoji (4 bytes in UTF-8)
    expect(id.length).toBe(32);
  });

  it('produces deterministic output', () => {
    const id1 = agentIdFromString('test-agent');
    const id2 = agentIdFromString('test-agent');
    expect(agentIdsEqual(id1, id2)).toBe(true);
  });

  it('produces different output for different strings', () => {
    const id1 = agentIdFromString('agent-1');
    const id2 = agentIdFromString('agent-2');
    expect(agentIdsEqual(id1, id2)).toBe(false);
  });
});

describe('agentIdToString', () => {
  it('converts to full hex representation', () => {
    const id = new Uint8Array(32).fill(0xab);
    const str = agentIdToString(id);
    expect(str).toBe('ab'.repeat(32));
  });

  it('produces 64-character hex string', () => {
    const id = generateAgentId();
    const str = agentIdToString(id);
    expect(str.length).toBe(64);
    expect(/^[0-9a-f]{64}$/.test(str)).toBe(true);
  });

  it('handles all-zero ID', () => {
    const id = new Uint8Array(32).fill(0);
    const str = agentIdToString(id);
    expect(str).toBe('00'.repeat(32));
  });

  it('handles all-0xff ID', () => {
    const id = new Uint8Array(32).fill(0xff);
    const str = agentIdToString(id);
    expect(str).toBe('ff'.repeat(32));
  });
});

describe('agentIdToShortString', () => {
  it('produces correct format with default chars', () => {
    const id = new Uint8Array(32);
    id[0] = 0xab;
    id[1] = 0xcd;
    id[2] = 0xef;
    id[31] = 0x12;
    const short = agentIdToShortString(id);
    expect(short).toMatch(/^[0-9a-f]{6}\.\.\.[0-9a-f]{6}$/);
  });

  it('respects custom char count', () => {
    const id = generateAgentId();
    const short = agentIdToShortString(id, 4);
    expect(short).toMatch(/^[0-9a-f]{4}\.\.\.[0-9a-f]{4}$/);
  });

  it('handles 1-char count', () => {
    const id = generateAgentId();
    const short = agentIdToShortString(id, 1);
    expect(short).toMatch(/^[0-9a-f]\.\.\.[0-9a-f]$/);
  });

  it('handles large char count', () => {
    const id = generateAgentId();
    const short = agentIdToShortString(id, 20);
    expect(short).toMatch(/^[0-9a-f]{20}\.\.\.[0-9a-f]{20}$/);
  });

  it('clamps chars to max of 32 for 32-byte ID', () => {
    const id = generateAgentId();
    // chars=33 should be clamped to 32 (half of 64-char hex)
    const short = agentIdToShortString(id, 33);
    expect(short).toMatch(/^[0-9a-f]{32}\.\.\.[0-9a-f]{32}$/);
  });

  it('clamps chars to minimum of 1', () => {
    const id = generateAgentId();
    // chars=0 should be clamped to 1
    const short = agentIdToShortString(id, 0);
    expect(short).toMatch(/^[0-9a-f]\.\.\.[0-9a-f]$/);
  });

  it('handles negative chars by clamping to 1', () => {
    const id = generateAgentId();
    const short = agentIdToShortString(id, -5);
    expect(short).toMatch(/^[0-9a-f]\.\.\.[0-9a-f]$/);
  });

  it('shows correct prefix and suffix', () => {
    const id = new Uint8Array(32).fill(0);
    id[0] = 0x12;
    id[1] = 0x34;
    id[2] = 0x56;
    id[29] = 0xab;
    id[30] = 0xcd;
    id[31] = 0xef;
    const short = agentIdToShortString(id, 6);
    expect(short.startsWith('123456')).toBe(true);
    expect(short.endsWith('abcdef')).toBe(true);
  });
});

describe('agentIdsEqual', () => {
  it('returns true for identical IDs', () => {
    const id1 = new Uint8Array(32).fill(1);
    const id2 = new Uint8Array(32).fill(1);
    expect(agentIdsEqual(id1, id2)).toBe(true);
  });

  it('returns false for different IDs', () => {
    const id1 = new Uint8Array(32).fill(1);
    const id2 = new Uint8Array(32).fill(2);
    expect(agentIdsEqual(id1, id2)).toBe(false);
  });

  it('returns false for different lengths', () => {
    const id1 = new Uint8Array(32).fill(1);
    const id2 = new Uint8Array(16).fill(1);
    expect(agentIdsEqual(id1, id2)).toBe(false);
  });

  it('returns false when only one byte differs', () => {
    const id1 = new Uint8Array(32).fill(0);
    const id2 = new Uint8Array(32).fill(0);
    id2[15] = 1;
    expect(agentIdsEqual(id1, id2)).toBe(false);
  });

  it('handles empty arrays', () => {
    const id1 = new Uint8Array(0);
    const id2 = new Uint8Array(0);
    expect(agentIdsEqual(id1, id2)).toBe(true);
  });

  it('works with generated IDs', () => {
    const id = generateAgentId();
    const copy = new Uint8Array(id);
    expect(agentIdsEqual(id, copy)).toBe(true);
  });
});

describe('lamportsToSol', () => {
  it('converts 1 SOL correctly', () => {
    expect(lamportsToSol(1_000_000_000n)).toBe('1');
  });

  it('converts 1.5 SOL correctly', () => {
    expect(lamportsToSol(1_500_000_000n)).toBe('1.5');
  });

  it('converts small amounts correctly', () => {
    expect(lamportsToSol(100_000n)).toBe('0.0001');
  });

  it('converts zero correctly', () => {
    expect(lamportsToSol(0n)).toBe('0');
  });

  it('converts 1 lamport correctly', () => {
    expect(lamportsToSol(1n)).toBe('0.000000001');
  });

  it('removes trailing zeros', () => {
    expect(lamportsToSol(1_000_000_000n)).toBe('1');
    expect(lamportsToSol(1_100_000_000n)).toBe('1.1');
    expect(lamportsToSol(1_120_000_000n)).toBe('1.12');
  });

  it('handles large amounts', () => {
    expect(lamportsToSol(1_000_000_000_000n)).toBe('1000');
    expect(lamportsToSol(1_234_567_890_000n)).toBe('1234.56789');
  });

  it('handles fractional SOL amounts', () => {
    expect(lamportsToSol(123_456_789n)).toBe('0.123456789');
  });
});

describe('solToLamports', () => {
  it('converts number input correctly', () => {
    expect(solToLamports(1)).toBe(1_000_000_000n);
    expect(solToLamports(1.5)).toBe(1_500_000_000n);
    expect(solToLamports(0.0001)).toBe(100_000n);
  });

  it('converts string input correctly', () => {
    expect(solToLamports('1')).toBe(1_000_000_000n);
    expect(solToLamports('1.5')).toBe(1_500_000_000n);
    expect(solToLamports('0.0001')).toBe(100_000n);
  });

  it('converts zero correctly', () => {
    expect(solToLamports(0)).toBe(0n);
    expect(solToLamports('0')).toBe(0n);
  });

  it('handles very small amounts', () => {
    expect(solToLamports(0.000000001)).toBe(1n);
  });

  it('handles large amounts', () => {
    expect(solToLamports(1000)).toBe(1_000_000_000_000n);
    expect(solToLamports('1000')).toBe(1_000_000_000_000n);
  });

  it('rounds correctly for precision edge cases', () => {
    // 0.1 + 0.2 in floating point is not exactly 0.3
    expect(solToLamports(0.3)).toBe(300_000_000n);
  });

  it('throws on invalid string input', () => {
    expect(() => solToLamports('abc')).toThrow('Invalid SOL amount');
    expect(() => solToLamports('not a number')).toThrow('Invalid SOL amount');
    expect(() => solToLamports('')).toThrow('Invalid SOL amount');
  });

  it('throws on NaN input', () => {
    expect(() => solToLamports(NaN)).toThrow('Invalid SOL amount');
  });

  it('throws on Infinity input', () => {
    expect(() => solToLamports(Infinity)).toThrow('Invalid SOL amount');
    expect(() => solToLamports(-Infinity)).toThrow('Invalid SOL amount');
  });

  it('throws on negative number input', () => {
    expect(() => solToLamports(-1)).toThrow('Invalid SOL amount');
    expect(() => solToLamports(-0.5)).toThrow('Invalid SOL amount');
    expect(() => solToLamports(-0.000000001)).toThrow('Invalid SOL amount');
  });

  it('throws on negative string input', () => {
    expect(() => solToLamports('-1')).toThrow('Invalid SOL amount');
    expect(() => solToLamports('-0.5')).toThrow('Invalid SOL amount');
  });
});

describe('lamportsToSol and solToLamports roundtrip', () => {
  it('roundtrips common values', () => {
    const values = [
      1_000_000_000n,
      1_500_000_000n,
      100_000n,
      0n,
      1n,
      123_456_789n,
    ];

    for (const lamports of values) {
      const sol = lamportsToSol(lamports);
      const roundtripped = solToLamports(sol);
      expect(roundtripped).toBe(lamports);
    }
  });
});
