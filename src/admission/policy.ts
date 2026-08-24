import { PROGRAM_SUBMIT_TAG } from '../tags.js';
import { Request } from './request.js';
import { Grant, Verdict, type VerdictValue } from './verdict.js';

export interface Policy {
  judge(request: Request): VerdictValue;
}

export class AllowAll implements Policy {
  judge(request: Request): VerdictValue {
    return Verdict.admit(request, [new Grant('allow_all', '既定許可スタンス')]);
  }
}

export class DenyAll implements Policy {
  judge(request: Request): VerdictValue {
    return Verdict.deny(request, '既定拒否スタンス', 'deny_all');
  }
}

export interface KitAuthority {
  port(tag: string): boolean;
  program(name: string): boolean;
  submit(): boolean;
}

export class ByKit implements Policy {
  readonly #kit: KitAuthority;

  constructor(kit: KitAuthority) {
    this.#kit = kit;
  }

  judge(request: Request): VerdictValue {
    if (request.tag === PROGRAM_SUBMIT_TAG) return this.#judgeSubmit(request);
    if (!this.#kit.port(request.tag)) {
      return this.#refuse(request, `port ${request.tag} は渡されていない`);
    }
    return this.#allow(request, `port ${request.tag} を渡している`);
  }

  #judgeSubmit(request: Request): VerdictValue {
    const payload = request.payload as { readonly name?: unknown } | null;
    const name = String(payload?.name);
    if (!this.#kit.submit()) {
      return this.#refuse(request, '深さが尽きているか繋ぐ相手が渡されていない');
    }
    if (!this.#kit.program(name)) {
      return this.#refuse(request, `program ${name} は渡されていない`);
    }
    return this.#allow(request, `program ${name} を渡している`);
  }

  #refuse(request: Request, reason: string): VerdictValue {
    return Verdict.deny(request, reason, 'by_kit');
  }

  #allow(request: Request, detail: string): VerdictValue {
    return Verdict.admit(request, [new Grant('by_kit', detail)]);
  }
}

export class All implements Policy {
  readonly #policies: readonly Policy[];

  constructor(...policies: Policy[]) {
    if (policies.length === 0) {
      throw new TypeError('All には最低 1 つの policy が要る (既定を発明しない)');
    }
    this.#policies = policies;
  }

  judge(request: Request): VerdictValue {
    const grounds: Grant[] = [];
    for (const policy of this.#policies) {
      const verdict = policy.judge(request);
      if (verdict.denied) return verdict;
      grounds.push(...verdict.grounds);
    }
    return Verdict.admit(request, grounds);
  }
}

export const Policy = { AllowAll, DenyAll, ByKit, All } as const;
