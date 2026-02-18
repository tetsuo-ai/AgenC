import { PublicKey } from '@solana/web3.js';
import { vi } from 'vitest';
import type { Program } from '@coral-xyz/anchor';
import type { AgencCoordination } from '../../types/agenc_coordination';

export const TEST_PUBKEY = new PublicKey('11111111111111111111111111111111');

export function mockBN(value: bigint | number): { toNumber: () => number; toString: () => string } {
  const bigValue = BigInt(value);
  return {
    toNumber: () => Number(bigValue),
    toString: () => bigValue.toString(),
  };
}

export function createId(seed = 0): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = (seed + i) % 256;
  }
  return bytes;
}

export function createMockProgram() {
  const eventCallbacks = new Map<number, { eventName: string; callback: Function }>();
  let nextListenerId = 1;

  const mockProgram = {
    addEventListener: vi.fn((eventName: string, callback: Function) => {
      const id = nextListenerId++;
      eventCallbacks.set(id, { eventName, callback });
      return id;
    }),
    removeEventListener: vi.fn(async (id: number) => {
      eventCallbacks.delete(id);
    }),
    _emit: (eventName: string, rawEvent: unknown, slot: number, signature: string) => {
      for (const { eventName: name, callback } of eventCallbacks.values()) {
        if (name === eventName) {
          callback(rawEvent, slot, signature);
        }
      }
    },
    _getCallbackCount: () => eventCallbacks.size,
  };

  return mockProgram as unknown as Program<AgencCoordination> & {
    _emit: typeof mockProgram._emit;
    _getCallbackCount: typeof mockProgram._getCallbackCount;
  };
}
