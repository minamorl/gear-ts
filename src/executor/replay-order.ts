import type { Entry } from "../journal.js";
import { normalizeJson, stableJson } from "../json.js";

/** Recorded port results are physically appended at completion, while ticks are assigned at start. */
export class ReplayOrder {
  readonly #recorded: readonly Entry[];
  readonly #used = new Set<number>();

  constructor(recorded: readonly Entry[]) {
    this.#recorded = recorded;
  }

  get exhausted(): boolean {
    return this.#used.size === this.#recorded.length;
  }

  next(
    tag: string,
    payload: unknown,
    requestOf: (entry: Entry) => unknown,
    tick?: number,
  ): {
    readonly entry: Entry;
    readonly position: number;
  } | null {
    const requested = stableJson(normalizeJson(payload));
    let selected: { entry: Entry; position: number } | null = null;
    for (let position = 0; position < this.#recorded.length; position += 1) {
      if (this.#used.has(position)) continue;
      const entry = this.#recorded[position];
      if (tick !== undefined && entry.tick !== tick) continue;
      if (tick === undefined && this.firstUnread()?.position !== position)
        continue;
      if (entry.payload.port !== tag) continue;
      if (stableJson(normalizeJson(requestOf(entry))) !== requested) continue;
      selected = { entry, position };
      break;
    }
    if (selected !== null) this.#used.add(selected.position);
    return selected;
  }

  firstUnread(): { readonly entry: Entry; readonly position: number } | null {
    for (let position = 0; position < this.#recorded.length; position += 1) {
      if (!this.#used.has(position))
        return { entry: this.#recorded[position], position };
    }
    return null;
  }
}
