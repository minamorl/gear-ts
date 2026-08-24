import { Request } from './request.js';

export class Grant {
  readonly policy: string;
  readonly detail: string;

  constructor(policy: string, detail: string) {
    this.policy = policy;
    this.detail = detail;
    Object.freeze(this);
  }

  toJSON(): { readonly policy: string; readonly detail: string } {
    return { policy: this.policy, detail: this.detail };
  }
}

export class Admitted {
  readonly request: Request;
  readonly grounds: readonly Grant[];

  constructor(request: Request, grounds: Iterable<Grant>) {
    this.request = request;
    this.grounds = Object.freeze(Array.from(grounds));
    Object.freeze(this);
  }

  get admitted(): true {
    return true;
  }

  get denied(): false {
    return false;
  }

  toJSON() {
    return {
      verdict: 'admitted' as const,
      request: this.request.toJSON(),
      grounds: this.grounds.map((ground) => ground.toJSON()),
    };
  }
}

export class Denied {
  readonly request: Request;
  readonly reason: string;
  readonly by: string;

  constructor(request: Request, reason: string, by: string) {
    this.request = request;
    this.reason = reason;
    this.by = by;
    Object.freeze(this);
  }

  get admitted(): false {
    return false;
  }

  get denied(): true {
    return true;
  }

  get grounds(): readonly Grant[] {
    return [new Grant(this.by, this.reason)];
  }

  toJSON() {
    return {
      verdict: 'denied' as const,
      request: this.request.toJSON(),
      reason: this.reason,
      by: this.by,
      grounds: this.grounds.map((ground) => ground.toJSON()),
    };
  }
}

export type VerdictValue = Admitted | Denied;

export const Verdict = {
  admit(request: Request, grounds: Iterable<Grant>): Admitted {
    return new Admitted(request, grounds);
  },

  deny(request: Request, reason: string, by: string): Denied {
    return new Denied(request, reason, by);
  },
} as const;
