import { describe, it, expect } from 'vitest';
import {
  validateProverEndpoint,
  validateRisc0PayloadShape,
} from '../validation';
import {
  RISC0_IMAGE_ID_LEN,
  RISC0_JOURNAL_LEN,
  RISC0_SEAL_BORSH_LEN,
  TRUSTED_RISC0_SELECTOR,
} from '../constants';

function makeBytes(length: number, fill: number): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

describe('validateProverEndpoint', () => {
  it('rejects empty string', () => {
    expect(() => validateProverEndpoint('')).toThrow('cannot be empty');
  });

  it('rejects whitespace-only string', () => {
    expect(() => validateProverEndpoint('   ')).toThrow('cannot be empty');
  });

  it('rejects endpoint exceeding 512 characters', () => {
    expect(() => validateProverEndpoint(`https://${'a'.repeat(510)}.com`)).toThrow('maximum length');
  });

  it('rejects non-http endpoint protocol', () => {
    expect(() => validateProverEndpoint('ws://localhost:8080')).toThrow('http or https');
  });

  it('rejects endpoint containing credentials', () => {
    expect(() => validateProverEndpoint('https://user:secret@example.com')).toThrow('must not include credentials');
  });

  it('rejects shell metacharacters', () => {
    expect(() => validateProverEndpoint('https://example.com;rm')).toThrow('disallowed characters');
  });

  it('accepts valid https endpoint', () => {
    expect(() => validateProverEndpoint('https://prover.example.com')).not.toThrow();
  });

  it('accepts valid http endpoint', () => {
    expect(() => validateProverEndpoint('http://localhost:8080')).not.toThrow();
  });
});

describe('validateRisc0PayloadShape', () => {
  it('accepts canonical payload shape', () => {
    const seal = makeBytes(RISC0_SEAL_BORSH_LEN, 7);
    seal.set(TRUSTED_RISC0_SELECTOR, 0);

    expect(() => validateRisc0PayloadShape({
      sealBytes: seal,
      journal: makeBytes(RISC0_JOURNAL_LEN, 1),
      imageId: makeBytes(RISC0_IMAGE_ID_LEN, 2),
      bindingValue: makeBytes(32, 3),
      nullifierSeed: makeBytes(32, 4),
    })).not.toThrow();
  });

  it('rejects wrong seal length', () => {
    expect(() => validateRisc0PayloadShape({
      sealBytes: makeBytes(10, 1),
      journal: makeBytes(RISC0_JOURNAL_LEN, 1),
      imageId: makeBytes(RISC0_IMAGE_ID_LEN, 2),
      bindingValue: makeBytes(32, 3),
      nullifierSeed: makeBytes(32, 4),
    })).toThrow('sealBytes must be');
  });

  it('rejects untrusted selector in seal', () => {
    const seal = makeBytes(RISC0_SEAL_BORSH_LEN, 7);
    seal.set(TRUSTED_RISC0_SELECTOR, 0);
    seal[0] ^= 1;
    expect(() => validateRisc0PayloadShape({
      sealBytes: seal,
      journal: makeBytes(RISC0_JOURNAL_LEN, 1),
      imageId: makeBytes(RISC0_IMAGE_ID_LEN, 2),
      bindingValue: makeBytes(32, 3),
      nullifierSeed: makeBytes(32, 4),
    })).toThrow('trusted selector');
  });

  it('rejects wrong journal length', () => {
    const seal = makeBytes(RISC0_SEAL_BORSH_LEN, 7);
    seal.set(TRUSTED_RISC0_SELECTOR, 0);
    expect(() => validateRisc0PayloadShape({
      sealBytes: seal,
      journal: makeBytes(10, 1),
      imageId: makeBytes(RISC0_IMAGE_ID_LEN, 2),
      bindingValue: makeBytes(32, 3),
      nullifierSeed: makeBytes(32, 4),
    })).toThrow('journal must be');
  });
});
