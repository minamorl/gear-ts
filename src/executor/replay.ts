import type { z } from "zod";
import {
  CrossedBoundary,
  ReplayMismatch,
  ReplayUnreadable,
  type Entry,
  type Log,
} from "../journal.js";
import { normalizeJson, stableJson } from "../json.js";
import type { Registry } from "../port/core.js";

import { ReplayOrder } from "./replay-order.js";

function recordedRequest(entry: Entry): unknown {
  if ("request" in entry.payload) return entry.payload.request;
  // Older journals used `payload` for the recorded request.
  return entry.payload.payload;
}

/** Reads the recorded external prefix without treating the end as an error. */
export class Replay {
  readonly #registry: Registry;
  readonly #order: ReplayOrder;
  readonly #completionOrder: readonly number[];
  readonly #waiting = new Map<
    number,
    { resolve: () => void; reject: (error: unknown) => void }
  >();
  #terminal: unknown = undefined;
  #completed = 0;
  #cursor = 0;

  constructor(recorded: Log, registry: Registry) {
    this.#registry = registry;
    this.#order = new ReplayOrder(recorded.portResults());
    this.#completionOrder = recorded.portResults().map((entry) => entry.tick);
  }

  get exhausted(): boolean {
    return this.#order.exhausted;
  }

  assertActive(): void {
    if (this.#terminal !== undefined) throw this.#terminal;
  }

  #abort(error: unknown): never {
    if (this.#terminal === undefined) this.#terminal = error;
    for (const waiter of this.#waiting.values()) waiter.reject(this.#terminal);
    this.#waiting.clear();
    throw this.#terminal;
  }

  waitForTurn(tick: number): Promise<void> {
    this.assertActive();
    if (!this.#completionOrder.includes(tick)) return Promise.resolve();
    if (this.#completionOrder[this.#completed] === tick)
      return Promise.resolve();
    return new Promise((resolve, reject) =>
      this.#waiting.set(tick, { resolve, reject }),
    );
  }

  defer<T>(tick: number, value: T): T | Promise<T> {
    this.assertActive();
    if (
      !this.#completionOrder.includes(tick) ||
      this.#completionOrder[this.#completed] === tick
    ) {
      return value;
    }
    return this.waitForTurn(tick).then(() => value);
  }

  complete(tick: number): void {
    if (this.#completionOrder[this.#completed] !== tick) return;
    this.#completed += 1;
    this.#waiting.get(this.#completionOrder[this.#completed])?.resolve();
    this.#waiting.delete(this.#completionOrder[this.#completed]);
  }

  readBack(
    tag: string,
    payload: unknown,
    tick?: number,
  ): readonly [unknown, unknown] {
    this.assertActive();
    try {
      const match = this.#order.next(tag, payload, recordedRequest, tick);
      if (match === null) {
        const unread = this.#order.firstUnread();
        if (unread === null)
          throw new CrossedBoundary(
            "Replay crossed the recorded boundary",
            this.#cursor,
          );
        throw new ReplayMismatch(
          unread.entry.tick,
          unread.entry.payload.port,
          tag,
          unread.position,
        );
      }
      this.#cursor += 1;
      const recorded = match.entry.payload.result;
      const parsed = this.#registry
        .forTag(tag)
        .operationFor(tag)
        .resultSchema.safeParse(recorded);
      if (!parsed.success) {
        throw new ReplayUnreadable(
          match.entry.tick,
          tag,
          parsed.error.issues,
          match.position,
          recorded,
        );
      }
      return [normalizeJson(parsed.data), recorded];
    } catch (error) {
      return this.#abort(error);
    }
  }
}
