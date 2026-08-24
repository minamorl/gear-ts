import type { z } from 'zod';
import {
  CrossedBoundary,
  ReplayMismatch,
  ReplayUnreadable,
  type Entry,
  type Log,
} from '../journal.js';
import { normalizeJson } from '../json.js';
import type { Registry } from '../port/core.js';

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function recordedRequest(entry: Entry): unknown {
  if ('request' in entry.payload) return entry.payload.request;
  // Ruby journals used `payload`; accepting it keeps withdrawal artifacts replayable.
  return entry.payload.payload;
}

/** Reads the recorded external prefix without treating the end as an error. */
export class Replay {
  readonly #recorded: readonly Entry[];
  readonly #registry: Registry;
  #cursor = 0;

  constructor(recorded: Log, registry: Registry) {
    this.#recorded = recorded.portResults();
    this.#registry = registry;
  }

  get exhausted(): boolean {
    return this.#cursor >= this.#recorded.length;
  }

  readBack(tag: string, payload: unknown): readonly [unknown, unknown] {
    const position = this.#cursor;
    const entry = this.#recorded[position];
    if (!entry) throw new CrossedBoundary('recorded external results are exhausted', position);

    const port = entry.payload.port;
    const request = recordedRequest(entry);
    if (port !== tag || stableJson(request) !== stableJson(payload)) {
      throw new ReplayMismatch(entry.tick, port, tag, position);
    }

    const recorded = entry.payload.result;
    const schema = this.#registry.forTag(tag).operationFor(tag).resultSchema as z.ZodType<unknown>;
    const checked = schema.safeParse(normalizeJson(recorded));
    if (!checked.success) {
      throw new ReplayUnreadable(entry.tick, tag, checked.error.issues, position, recorded);
    }

    this.#cursor += 1;
    return [normalizeJson(checked.data), recorded] as const;
  }
}
