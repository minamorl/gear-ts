import { Darkcore } from '@minamorl/berylx';
import { describe, expect, it } from 'vitest';
import { Admission, PROGRAM_SUBMIT_TAG } from '../src/index.js';

class TagAllowlist implements Admission.Policy {
  readonly #allowed: ReadonlySet<string>;

  constructor(...allowed: string[]) {
    this.#allowed = new Set(allowed);
  }

  judge(request: Admission.Request): Admission.VerdictValue {
    if (this.#allowed.has(request.tag)) {
      return Admission.Verdict.admit(request, [
        new Admission.Grant('tag_allowlist', `${request.tag} は許可リストにある`),
      ]);
    }
    return Admission.Verdict.deny(request, `${request.tag} は許可リストに無い`, 'tag_allowlist');
  }
}

const shellRequest = () => Admission.Request.fromEffect(Darkcore.op('shell', { cmd: 'ls' }));

describe('Admission', () => {
  it('builds an inspectable request from an unexecuted effect', () => {
    expect(shellRequest()).toMatchObject({ tag: 'shell', payload: { cmd: 'ls' } });
  });

  it('changes the verdict when the policy is swapped', () => {
    const request = shellRequest();
    const admitted = Admission.judge(request, new Admission.AllowAll());
    expect(admitted.admitted).toBe(true);
    expect(admitted.request).toBe(request);
    expect(Admission.judge(request, new Admission.DenyAll()).denied).toBe(true);
  });

  it('returns denial as a value rather than throwing', () => {
    const verdict = Admission.judge(shellRequest(), new Admission.DenyAll());
    expect(verdict).toBeInstanceOf(Admission.Denied);
    expect(verdict).toMatchObject({ denied: true, admitted: false, reason: 'default deny stance', by: 'deny_all' });
  });

  it('gives both verdict forms structured grounds', () => {
    const admitted = Admission.judge(shellRequest(), new TagAllowlist('shell'));
    const denied = Admission.judge(shellRequest(), new TagAllowlist('http'));
    expect(admitted.grounds[0]?.policy).toBe('tag_allowlist');
    expect(denied.grounds[0]?.policy).toBe('tag_allowlist');
  });

  it('denies an All composition when any policy denies', () => {
    const admitted = Admission.judge(
      shellRequest(),
      new Admission.All(new Admission.AllowAll(), new TagAllowlist('shell')),
    );
    const denied = Admission.judge(
      shellRequest(),
      new Admission.All(new Admission.AllowAll(), new TagAllowlist('http')),
    );
    expect(admitted.admitted).toBe(true);
    expect(admitted.grounds).toHaveLength(2);
    expect(denied).toMatchObject({ denied: true, by: 'tag_allowlist' });
  });

  it('refuses an empty policy composition', () => {
    expect(() => new Admission.All()).toThrow(TypeError);
  });

  it('does not invent a policy or hardcode domain tags', () => {
    expect(() => Admission.judge(shellRequest(), undefined as never)).toThrow();
    const http = Admission.Request.fromEffect(Darkcore.op('http', { url: 'x' }));
    expect(Admission.judge(shellRequest(), new Admission.AllowAll()).admitted).toBe(true);
    expect(Admission.judge(http, new Admission.AllowAll()).admitted).toBe(true);
    expect(Admission.judge(shellRequest(), new Admission.DenyAll()).denied).toBe(true);
    expect(Admission.judge(http, new Admission.DenyAll()).denied).toBe(true);
  });

  it('judges an effect directly before execution', () => {
    const verdict = Admission.judgeEffect(Darkcore.op('shell', { cmd: 'ls' }), new TagAllowlist('shell'));
    expect(verdict).toMatchObject({ admitted: true, request: { tag: 'shell' } });
  });

  it('ByKit admits only ports carried by the kit', () => {
    const kit: Admission.KitAuthority = {
      port: (tag) => tag === 'shell',
      program: () => false,
      submit: () => false,
    };
    const policy = new Admission.ByKit(kit);
    expect(policy.judge(shellRequest()).admitted).toBe(true);
    expect(policy.judge(new Admission.Request('http', {}))).toMatchObject({ denied: true, by: 'by_kit' });
  });

  it('ByKit spends submit authority and checks the carried program', () => {
    const kit: Admission.KitAuthority = {
      port: () => false,
      program: (name) => name === 'child',
      submit: () => true,
    };
    const policy = new Admission.ByKit(kit);
    expect(policy.judge(new Admission.Request(PROGRAM_SUBMIT_TAG, { name: 'child' })).admitted).toBe(true);
    expect(policy.judge(new Admission.Request(PROGRAM_SUBMIT_TAG, { name: 'other' })).denied).toBe(true);
  });

  it('ByKit denies submission when depth is exhausted', () => {
    const policy = new Admission.ByKit({
      port: () => true,
      program: () => true,
      submit: () => false,
    });
    expect(policy.judge(new Admission.Request(PROGRAM_SUBMIT_TAG, { name: 'child' }))).toMatchObject({
      denied: true,
      by: 'by_kit',
    });
  });
});
