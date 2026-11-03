import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sha256, sha256Hex } from '../src/sha256';

const NIST_VECTORS: ReadonlyArray<{ input: string; hex: string }> = [
  {
    input: '',
    hex: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  },
  {
    input: 'abc',
    hex: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  },
  {
    input: 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    hex: '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  },
  {
    input:
      'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
    hex: 'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
  },
];

function referenceHex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

describe('sha256 (FIPS 180-4)', () => {
  it('matches NIST golden vectors', () => {
    for (const { input, hex } of NIST_VECTORS) {
      expect(sha256Hex(input)).toBe(hex);
    }
  });

  it('returns raw 32-byte digests', () => {
    const digest = sha256(new TextEncoder().encode('abc'));
    expect(digest).toHaveLength(32);
    expect(digest[0]).toBe(0xba);
    expect(digest[31]).toBe(0xad);
  });

  it('matches node:crypto at padding boundaries', () => {
    for (const len of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
      const bytes = new Uint8Array(len).fill(0x61);
      expect(toHex(sha256(bytes))).toBe(referenceHex(bytes));
    }
  });

  it('matches node:crypto for random strings (cross-validation)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 4096 }), (s) => {
        const expected = createHash('sha256').update(s, 'utf8').digest('hex');
        expect(sha256Hex(s)).toBe(expected);
      }),
      { numRuns: 500 },
    );
  });

  it('matches node:crypto for random byte arrays (cross-validation)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 200 }), (bytes) => {
        expect(toHex(sha256(bytes))).toBe(referenceHex(bytes));
      }),
      { numRuns: 500 },
    );
  });

  it('is deterministic for identical input', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
        expect(toHex(sha256(bytes))).toBe(toHex(sha256(bytes)));
      }),
      { numRuns: 200 },
    );
  });
});
