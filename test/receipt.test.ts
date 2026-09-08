import { Darkcore } from '@minamorl/berylx';
import { describe, expect, it } from 'vitest';
import { BrokenChain, Receipt } from '../src/index.js';

class DummyVerdict {
  constructor(
    readonly allowed: boolean,
    readonly policy: string,
    readonly reasons: readonly string[],
  ) {}

  toJSON() {
    return { allowed: this.allowed, policy: this.policy, reasons: this.reasons };
  }
}

const sampleEffect = () => Darkcore.op('fs_write', { path: '/tmp/x', bytes: 3 }, (value) => value);
const sampleVerdict = () => new DummyVerdict(true, 'fs.write.allow', ['within sandbox']);

describe('Receipt', () => {
  it('carries both the effect and its admission grounds', () => {
    const receipt = Receipt.issue({
      effect: sampleEffect(),
      outcome: Receipt.ok('written'),
      grounds: sampleVerdict(),
      tick: 7,
    });
    expect(receipt.effect).toEqual({ tag: 'fs_write', payload: { path: '/tmp/x', bytes: 3 } });
    expect(receipt.grounded).toBe(true);
    expect(receipt.grounds).toMatchObject({ policy: 'fs.write.allow' });
    expect(receipt.succeeded).toBe(true);
    expect(receipt.outcome).toMatchObject({ value: 'written' });
  });

  it('drops the raw effect continuation from its summary', () => {
    const effect = sampleEffect();
    const receipt = Receipt.issue({
      effect,
      outcome: Receipt.ok(),
      grounds: sampleVerdict(),
      tick: 1,
    });
    expect(receipt.effect).not.toHaveProperty('k');
    expect(Object.values(receipt.effect)).not.toContain(effect.k);
  });

  it('derives a deterministic id', () => {
    const input = {
      effect: sampleEffect(),
      outcome: Receipt.ok('written'),
      grounds: sampleVerdict(),
      tick: 7,
    };
    expect(Receipt.issue(input)).toEqual(Receipt.issue(input));
    expect(Receipt.issue(input).id).toBe(Receipt.issue(input).id);
  });

  it('changes the id when content changes', () => {
    const common = {
      effect: sampleEffect(),
      outcome: Receipt.ok('written'),
      grounds: sampleVerdict(),
    };
    expect(Receipt.issue({ ...common, tick: 7 }).id).not.toBe(Receipt.issue({ ...common, tick: 8 }).id);
  });

  it('detaches and deeply freezes every field used as id material', () => {
    const payload = { nested: { values: [1, 2] } };
    const receipt = Receipt.issue({
      effect: { tag: 'probe', payload },
      outcome: Receipt.ok({ answer: { n: 2 } }),
      grounds: { policy: { name: 'allow' } },
      tick: 4,
    });
    const id = receipt.id;
    payload.nested.values[0] = 99;

    expect(receipt.effect.payload).toEqual({ nested: { values: [1, 2] } });
    expect(receipt.id).toBe(id);
    expect(Object.isFrozen(receipt.effect)).toBe(true);
    expect(Object.isFrozen(receipt.effect.payload)).toBe(true);
    expect(Object.isFrozen(receipt.outcome)).toBe(true);
    expect(Object.isFrozen(receipt.grounds)).toBe(true);
  });

  it('walks predecessor ancestors in nearest-first order', () => {
    const grounds = sampleVerdict();
    const root = Receipt.issue({ effect: { tag: 'boot' }, outcome: Receipt.ok(), grounds, tick: 0 });
    const middle = Receipt.issue({
      effect: { tag: 'step' },
      outcome: Receipt.ok(),
      grounds,
      tick: 1,
      predecessor: root,
    });
    const leaf = Receipt.issue({
      effect: { tag: 'done' },
      outcome: Receipt.ok(),
      grounds,
      tick: 2,
      predecessor: middle,
    });
    const store = [root, middle, leaf];
    expect(leaf.ancestors(store)).toEqual([middle, root]);
    expect(middle.ancestors(store)).toEqual([root]);
    expect(root.ancestors(store)).toEqual([]);
    expect(root.root).toBe(true);
    expect(leaf.root).toBe(false);
    expect(Receipt.chainOk(store)).toBe(true);
  });

  it('detects a dangling predecessor', () => {
    const orphan = Receipt.issue({
      effect: { tag: 'step' },
      outcome: Receipt.ok(),
      grounds: sampleVerdict(),
      tick: 1,
      predecessor: 'missing',
    });
    expect(Receipt.chainOk([orphan])).toBe(false);
    expect(Receipt.audit([orphan]).dangling).toContain(orphan);
    expect(() => orphan.ancestors([orphan])).toThrow(BrokenChain);
  });

  it('detects a cycle', () => {
    const a = new Receipt({
      id: 'a',
      tick: 0,
      effect: { tag: 'a' },
      outcome: Receipt.ok(),
      grounds: {},
      predecessor: 'b',
    });
    const b = new Receipt({
      id: 'b',
      tick: 1,
      effect: { tag: 'b' },
      outcome: Receipt.ok(),
      grounds: {},
      predecessor: 'a',
    });
    expect(Receipt.chainOk([a, b])).toBe(false);
    expect(Receipt.audit([a, b]).cyclic).toEqual(expect.arrayContaining([a, b]));
    expect(() => a.ancestors([a, b])).toThrow(BrokenChain);
  });

  it('round-trips through object and JSON forms', () => {
    const receipt = Receipt.issue({
      effect: sampleEffect(),
      outcome: Receipt.ok('written'),
      grounds: sampleVerdict(),
      tick: 42,
      predecessor: 'previous',
    });
    expect(Receipt.fromObject(receipt.toJSON())).toEqual(receipt);
    expect(Receipt.fromJSON(receipt.serialize())).toEqual(receipt);
  });

  it('accepts an admission verdict as structured grounds', () => {
    const receipt = Receipt.issue({
      effect: sampleEffect(),
      outcome: Receipt.ok(),
      grounds: sampleVerdict(),
      tick: 3,
    });
    expect(receipt.grounds).toEqual({
      allowed: true,
      policy: 'fs.write.allow',
      reasons: ['within sandbox'],
    });
  });
});
