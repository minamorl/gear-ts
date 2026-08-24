import { All, ByKit, judge, type Policy } from '../admission/index.js';
import { Request } from '../admission/request.js';
import type { VerdictValue } from '../admission/verdict.js';
import type { Kit } from '../kit.js';

/** Applies the handed-down Kit as a lexical ceiling outside the domain policy. */
export class Authority {
  readonly #policy: Policy;

  constructor(policy: Policy) {
    this.#policy = policy;
  }

  judge(request: Request, kit: Kit | null): VerdictValue {
    return judge(request, kit === null ? this.#policy : new All(new ByKit(kit), this.#policy));
  }
}
