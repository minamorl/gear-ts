export interface EffectRequestLike {
  readonly tag: string;
  readonly payload: unknown;
}

export class Request {
  readonly tag: string;
  readonly payload: unknown;

  constructor(tag: string, payload: unknown) {
    this.tag = tag;
    this.payload = payload;
    Object.freeze(this);
  }

  static fromEffect(effect: EffectRequestLike): Request {
    return new Request(effect.tag, effect.payload);
  }

  toJSON(): { readonly tag: string; readonly payload: unknown } {
    return { tag: this.tag, payload: this.payload };
  }
}
