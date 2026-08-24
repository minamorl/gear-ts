import { describe, expect, it } from 'vitest';
import {
  Admission,
  AdmissionRequest,
  AllPolicies,
  AllowAll,
  ByKit,
  Kit,
} from '../src/index.js';

const full = () => Kit.of({ ports: ['shell', 'http'], programs: ['fetch', 'parse'], depth: 2 });
const request = (tag: string) => new AdmissionRequest(tag, {});

describe('Kit', () => {
  it('normalizes names and removes duplicates', () => {
    const grant = Kit.of({ ports: ['http', 'shell', 'http'] });
    expect(grant.ports).toEqual(['http', 'shell']);
    expect(grant.programs).toEqual([]);
    expect(grant.depth).toBe(0);
  });

  it('grants nothing by default', () => {
    expect(Kit.nothing().ports).toEqual([]);
    expect(Kit.nothing().submit()).toBe(false);
    expect(Kit.nothing().port('shell')).toBe(false);
  });

  it('refuses a negative depth', () => {
    expect(() => Kit.of({ depth: -1 })).toThrow(RangeError);
  });

  it('answers membership queries', () => {
    expect(full().port('shell')).toBe(true);
    expect(full().port('db')).toBe(false);
    expect(full().program('fetch')).toBe(true);
    expect(full().submit()).toBe(true);
  });

  it('requires both depth and programs for submission', () => {
    expect(Kit.of({ programs: ['fetch'], depth: 0 }).submit()).toBe(false);
    expect(Kit.of({ ports: ['shell'], depth: 3 }).submit()).toBe(false);
  });

  it('can only narrow by intersection', () => {
    const narrowed = full().narrow({
      ports: ['shell', 'db'],
      programs: ['fetch', 'other'],
      depth: 9,
    });
    expect(narrowed.ports).toEqual(['shell']);
    expect(narrowed.programs).toEqual(['fetch']);
    expect(narrowed.depth).toBe(2);
  });

  it('keeps the set when narrowing without arguments', () => {
    expect(full().narrow()).toEqual(full());
  });

  it('spends one depth on descend and floors at zero', () => {
    const child = full().descend();
    expect(child.depth).toBe(1);
    expect(child.descend().depth).toBe(0);
    expect(child.descend().descend().depth).toBe(0);
  });

  it('can narrow while descending', () => {
    const child = full().descend({ ports: ['shell'] });
    expect(child.ports).toEqual(['shell']);
    expect(child.depth).toBe(1);
  });

  it('is JSON-safe and round-trips', () => {
    const declaration = full().toJSON();
    expect(declaration).toEqual({
      ports: ['http', 'shell'],
      programs: ['fetch', 'parse'],
      depth: 2,
    });
    expect(Kit.fromJSON(declaration)).toEqual(full());
    expect(Kit.fromJSON(JSON.parse(JSON.stringify(declaration)))).toEqual(full());
  });

  it('admits a handed-down port through ByKit', () => {
    const verdict = new ByKit(full()).judge(request('shell'));
    expect(verdict.admitted).toBe(true);
    expect(verdict.grounds.map((ground) => ground.policy)).toEqual(['by_kit']);
  });

  it('denies a port that was not handed down', () => {
    const verdict = new ByKit(full()).judge(request('db'));
    expect(verdict.denied).toBe(true);
    if (!verdict.denied) throw new Error('expected denial');
    expect(verdict.by).toBe('by_kit');
    expect(verdict.reason).toMatch(/渡されていない/u);
  });

  it('denies every port when nothing was handed down', () => {
    expect(new ByKit(Kit.nothing()).judge(request('shell')).denied).toBe(true);
  });

  it('composes with the policy conjunction', () => {
    const both = new AllPolicies(new ByKit(full()), new AllowAll());
    expect(Admission.judge(request('shell'), both).admitted).toBe(true);
    expect(Admission.judge(request('db'), both).denied).toBe(true);
  });
});
