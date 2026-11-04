import { arbitrate } from '../src/arbitration';
import type { ConfirmationPolicy } from '../src/arbitration';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

const POLICIES: ConfirmationPolicy[] = ['user-confirm', 'auto', 'never'];

describe('arbitrate (v2 §9.2 fixed evaluation order)', () => {
  it('level 1 user-lock denies regardless of every other input', () => {
    for (const userPreference of [undefined, ...POLICIES]) {
      for (const platformPolicy of [undefined, ...POLICIES]) {
        for (const agentRequest of [undefined, ...POLICIES]) {
          const result = arbitrate({ userLock: true, userPreference, platformPolicy, agentRequest });
          expect(result.allowed).toBe(false);
          expect(result.decidedBy).toBe('user-lock');
          expect(result.trace).toEqual([
            { level: 'user-lock', outcome: 'deny', detail: 'zone-level user lock is active' },
          ]);
        }
      }
    }
  });

  it('user preference outranks platform policy and agent request', () => {
    for (const loser of POLICIES) {
      const result = arbitrate({
        userLock: false,
        userPreference: 'never',
        platformPolicy: loser,
        agentRequest: loser,
      });
      expect(result).toMatchObject({ allowed: true, confirmation: 'never', decidedBy: 'user-preference' });
      expect(result.trace.map((entry) => entry.level)).toEqual(['user-lock', 'user-preference']);
      expect(result.trace[0]).toMatchObject({ outcome: 'skip' });
      expect(result.trace[1]).toMatchObject({ outcome: 'decide' });
    }
  });

  it('platform policy outranks agent request', () => {
    const result = arbitrate({ userLock: false, platformPolicy: 'auto', agentRequest: 'never' });
    expect(result).toMatchObject({ allowed: true, confirmation: 'auto', decidedBy: 'platform-policy' });
    expect(result.trace.map((entry) => entry.level)).toEqual(['user-lock', 'user-preference', 'platform-policy']);
  });

  it('agent request applies when no higher input exists', () => {
    const result = arbitrate({ userLock: false, agentRequest: 'auto' });
    expect(result).toMatchObject({ allowed: true, confirmation: 'auto', decidedBy: 'agent-proposal' });
    expect(result.trace.map((entry) => entry.level)).toEqual([
      'user-lock',
      'user-preference',
      'platform-policy',
      'agent-proposal',
    ]);
  });

  it('falls back to the conservative default user-confirm', () => {
    const result = arbitrate({ userLock: false });
    expect(result).toMatchObject({ allowed: true, confirmation: 'user-confirm', decidedBy: 'default' });
    expect(result.trace.map((entry) => entry.level)).toEqual([
      'user-lock',
      'user-preference',
      'platform-policy',
      'agent-proposal',
      'default',
    ]);
    expect(result.trace.every((entry) => entry.outcome === 'skip' || entry.level === 'default')).toBe(true);
  });

  it('is deterministic: same inputs, same result and trace (200 runs)', () => {
    const requestArb = fc.record({
      userLock: fc.boolean(),
      userPreference: fc.option(fc.constantFrom(...POLICIES), { nil: undefined }),
      platformPolicy: fc.option(fc.constantFrom(...POLICIES), { nil: undefined }),
      agentRequest: fc.option(fc.constantFrom(...POLICIES), { nil: undefined }),
    });
    fc.assert(
      fc.property(requestArb, (inputs) => {
        expect(arbitrate(inputs)).toEqual(arbitrate(inputs));
      }),
      { numRuns: 200 },
    );
  });

  it('respects the priority order for every input combination (300 runs)', () => {
    const requestArb = fc.record({
      userLock: fc.boolean(),
      userPreference: fc.option(fc.constantFrom(...POLICIES), { nil: undefined }),
      platformPolicy: fc.option(fc.constantFrom(...POLICIES), { nil: undefined }),
      agentRequest: fc.option(fc.constantFrom(...POLICIES), { nil: undefined }),
    });
    fc.assert(
      fc.property(requestArb, (inputs) => {
        const result = arbitrate(inputs);
        if (inputs.userLock) {
          expect(result.allowed).toBe(false);
          expect(result.decidedBy).toBe('user-lock');
          return;
        }
        expect(result.allowed).toBe(true);
        if (inputs.userPreference !== undefined) {
          expect(result.confirmation).toBe(inputs.userPreference);
          expect(result.decidedBy).toBe('user-preference');
        } else if (inputs.platformPolicy !== undefined) {
          expect(result.confirmation).toBe(inputs.platformPolicy);
          expect(result.decidedBy).toBe('platform-policy');
        } else if (inputs.agentRequest !== undefined) {
          expect(result.confirmation).toBe(inputs.agentRequest);
          expect(result.decidedBy).toBe('agent-proposal');
        } else {
          expect(result.confirmation).toBe('user-confirm');
          expect(result.decidedBy).toBe('default');
        }
        // trace 以固定层序排列且终于决定层
        const levels = result.trace.map((entry) => entry.level);
        const expected = ['user-lock', 'user-preference', 'platform-policy', 'agent-proposal', 'default'];
        expect(expected.join(',').startsWith(levels.join(','))).toBe(true);
        expect(levels[levels.length - 1]).toBe(result.decidedBy);
      }),
      { numRuns: 300 },
    );
  });
});
