import { normalizeJson, type JsonValue } from '../json.js';

export interface EffectRequestLike {
  readonly tag: string;
  readonly payload: unknown; /* outer boundary — not JSON-validated */
}

export class Request {
  readonly tag: string;
  readonly payload: JsonValue;

  constructor(tag: string, payload: JsonValue) {
    this.tag = tag;
    this.payload = payload;
    Object.freeze(this);
  }

  static fromEffect(effect: EffectRequestLike): Request {
    return new Request(effect.tag, normalizeJson(effect.payload));
  }

  toJSON(): { readonly tag: string; readonly payload: JsonValue } {
    return { tag: this.tag, payload: this.payload };
  }
}
