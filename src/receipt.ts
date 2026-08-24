import { createHash } from 'node:crypto';
import { normalizeJson, type JsonObject, type JsonPrimitive, type JsonValue } from './json.js';

export type { JsonPrimitive, JsonValue, JsonObject } from './json.js';

export type ReceiptOutcome =
  | { readonly status: 'ok'; readonly value: JsonValue }
  | { readonly status: 'err'; readonly reason: JsonValue };

export interface ReceiptShape {
  readonly id: string;
  readonly tick: number;
  readonly effect: JsonObject;
  readonly outcome: ReceiptOutcome;
  readonly grounds: JsonValue;
  readonly predecessor: string | null;
}

export interface EffectLike {
  readonly tag: unknown;
  readonly payload: unknown;
}

export interface GroundsLike {
  toJSON(): unknown;
}

export interface IssueReceipt {
  readonly effect: unknown;
  readonly outcome: unknown;
  readonly grounds: unknown;
  readonly tick: number;
  readonly predecessor?: Receipt | string | null;
}

export class BrokenChain extends Error {}

export class Receipt implements ReceiptShape {
  static readonly BrokenChain = BrokenChain;

  readonly id: string;
  readonly tick: number;
  readonly effect: JsonObject;
  readonly outcome: ReceiptOutcome;
  readonly grounds: JsonValue;
  readonly predecessor: string | null;

  constructor(shape: ReceiptShape) {
    this.id = shape.id;
    this.tick = shape.tick;
    this.effect = normalizeJson(shape.effect) as JsonObject;
    this.outcome = normalizeJson(shape.outcome) as ReceiptOutcome;
    this.grounds = normalizeJson(shape.grounds);
    this.predecessor = shape.predecessor;
    Object.freeze(this);
  }

  static issue(input: IssueReceipt): Receipt {
    const effect = summarizeEffect(input.effect);
    const outcome = canonicalize(input.outcome) as ReceiptOutcome;
    const grounds = canonicalize(normalizeGrounds(input.grounds));
    const predecessor = predecessorId(input.predecessor ?? null);
    const id = deriveId({ tick: input.tick, effect, outcome, grounds, predecessor });
    return new Receipt({ id, tick: input.tick, effect, outcome, grounds, predecessor });
  }

  static ok(value: unknown = null): ReceiptOutcome {
    return normalizeJson({ status: 'ok', value: canonicalize(value) }) as ReceiptOutcome;
  }

  static err(reason: unknown = null): ReceiptOutcome {
    return normalizeJson({ status: 'err', reason: canonicalize(reason) }) as ReceiptOutcome;
  }

  get root(): boolean {
    return this.predecessor === null;
  }

  get succeeded(): boolean {
    return this.outcome.status === 'ok';
  }

  get grounded(): boolean {
    if (this.grounds === null) return false;
    if (Array.isArray(this.grounds)) return this.grounds.length > 0;
    if (typeof this.grounds === 'object') return Object.keys(this.grounds).length > 0;
    return true;
  }

  ancestors(store: ReceiptStore): readonly Receipt[] {
    const index = indexStore(store);
    const ancestors: Receipt[] = [];
    const seen = new Set([this.id]);
    let current = this.predecessor;
    while (current !== null) {
      const receipt = index.get(current);
      if (!receipt) throw new BrokenChain(`missing predecessor: ${current}`);
      if (seen.has(current)) throw new BrokenChain(`cycle detected at: ${current}`);
      seen.add(current);
      ancestors.push(receipt);
      current = receipt.predecessor;
    }
    return ancestors;
  }

  toJSON(): ReceiptShape {
    return {
      id: this.id,
      tick: this.tick,
      effect: this.effect,
      outcome: this.outcome,
      grounds: this.grounds,
      predecessor: this.predecessor,
    };
  }

  serialize(): string {
    return JSON.stringify(this);
  }

  static fromJSON(text: string): Receipt {
    return Receipt.fromObject(JSON.parse(text) as Record<string, unknown>);
  }

  static fromObject(value: Record<string, unknown>): Receipt {
    return new Receipt({
      id: String(value.id),
      tick: Number(value.tick),
      effect: canonicalize(value.effect) as JsonObject,
      outcome: canonicalize(value.outcome) as ReceiptOutcome,
      grounds: canonicalize(value.grounds),
      predecessor: value.predecessor == null ? null : String(value.predecessor),
    });
  }

  static audit(store: ReceiptStore): ReceiptAudit {
    const index = indexStore(store);
    const dangling = new Set<Receipt>();
    const cyclic = new Set<Receipt>();
    for (const receipt of index.values()) {
      const seen = new Set([receipt.id]);
      let current = receipt.predecessor;
      while (current !== null) {
        const predecessor = index.get(current);
        if (!predecessor) {
          dangling.add(receipt);
          break;
        }
        if (seen.has(current)) {
          cyclic.add(receipt);
          break;
        }
        seen.add(current);
        current = predecessor.predecessor;
      }
    }
    return { dangling: [...dangling], cyclic: [...cyclic] };
  }

  static chainOk(store: ReceiptStore): boolean {
    const audit = Receipt.audit(store);
    return audit.dangling.length === 0 && audit.cyclic.length === 0;
  }
}

export type ReceiptStore = Iterable<Receipt> | ReadonlyMap<string, Receipt>;

export interface ReceiptAudit {
  readonly dangling: readonly Receipt[];
  readonly cyclic: readonly Receipt[];
}

function indexStore(store: ReceiptStore): ReadonlyMap<string, Receipt> {
  if (isReceiptMap(store)) return store;
  return new Map(Array.from(store, (receipt) => [receipt.id, receipt]));
}

function isReceiptMap(store: ReceiptStore): store is ReadonlyMap<string, Receipt> {
  return typeof (store as Partial<ReadonlyMap<string, Receipt>>).get === 'function';
}

function isEffectLike(value: unknown): value is EffectLike {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype !== Object.prototype && 'tag' in value && 'payload' in value;
}

function summarizeEffect(effect: unknown): JsonObject {
  if (isEffectLike(effect)) {
    return canonicalize({ tag: effect.tag, payload: effect.payload }) as JsonObject;
  }
  if (effect !== null && typeof effect === 'object' && !Array.isArray(effect)) {
    return canonicalize(effect) as JsonObject;
  }
  return canonicalize({ tag: effect, payload: null }) as JsonObject;
}

function normalizeGrounds(grounds: unknown): unknown {
  if (grounds !== null && typeof grounds === 'object') {
    const candidate = grounds as Partial<GroundsLike>;
    if (typeof candidate.toJSON === 'function') return candidate.toJSON();
    return grounds;
  }
  return { value: grounds };
}

function predecessorId(predecessor: Receipt | string | null): string | null {
  if (predecessor === null) return null;
  return predecessor instanceof Receipt ? predecessor.id : String(predecessor);
}

export function canonicalize(value: unknown): JsonValue {
  return normalizeJson(value);
}

function sortKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const object = value as { readonly [key: string]: JsonValue };
    return Object.keys(object)
      .sort()
      .reduce<Record<string, JsonValue>>((output, key) => {
        output[key] = sortKeys(object[key]!);
        return output;
      }, {});
  }
  return value;
}

function deriveId(value: Omit<ReceiptShape, 'id'>): string {
  const material = JSON.stringify(sortKeys(canonicalize(value)));
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}
