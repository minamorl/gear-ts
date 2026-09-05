import { PROGRAM_SUBMIT_TAG } from '../tags.js';
import { Request } from './request.js';
import { Grant, Verdict, type VerdictValue } from './verdict.js';

export interface Policy {
  judge(request: Request): VerdictValue;
}

export class AllowAll implements Policy {
  judge(request: Request): VerdictValue {
    return Verdict.admit(request, [new Grant('allow_all', 'default allow stance')]);
  }
}

export class DenyAll implements Policy {
  judge(request: Request): VerdictValue {
    return Verdict.deny(request, 'default deny stance', 'deny_all');
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
      return this.#refuse(request, `port ${request.tag} was not handed down`);
    }
    return this.#allow(request, `port ${request.tag} is handed down`);
  }

  #judgeSubmit(request: Request): VerdictValue {
    const payload = request.payload as { readonly name?: unknown } | null;
    const name = String(payload?.name);
    if (!this.#kit.submit()) {
      return this.#refuse(request, 'depth is exhausted or no program was handed down');
    }
    if (!this.#kit.program(name)) {
      return this.#refuse(request, `program ${name} was not handed down`);
    }
    return this.#allow(request, `program ${name} is handed down`);
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
      throw new TypeError('All requires at least one policy (it invents no default)');
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
