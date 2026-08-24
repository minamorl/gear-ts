import type { Log } from '../journal.js';
import { normalizeJson, type JsonObject } from '../json.js';

export const ACCEPTED = 'accepted' as const;
export const DENIED = 'denied' as const;
export const COMPLETED = 'completed' as const;
export const SUSPENDED = 'suspended' as const;

export type LedgerKind = typeof ACCEPTED | typeof DENIED | typeof COMPLETED | typeof SUSPENDED;

export class Record {
  readonly ticket: number;
  readonly kind: LedgerKind;
  readonly payload: Readonly<globalThis.Record<string, unknown>>;

  constructor(ticket: number, kind: LedgerKind, payload: globalThis.Record<string, unknown>) {
    this.ticket = ticket;
    this.kind = kind;
    this.payload = normalizeJson(payload) as JsonObject;
    Object.freeze(this);
  }
}

/** Append-only intake history plus indexes to the authoritative per-run journals. */
export class Ledger {
  static readonly ACCEPTED = ACCEPTED;
  static readonly DENIED = DENIED;
  static readonly COMPLETED = COMPLETED;
  static readonly SUSPENDED = SUSPENDED;

  readonly #records: Record[] = [];
  readonly #journals = new Map<number, Log>();

  append(input: {
    readonly ticket: number;
    readonly kind: LedgerKind;
    readonly payload?: globalThis.Record<string, unknown>;
  }): Record {
    const record = new Record(input.ticket, input.kind, input.payload ?? {});
    this.#records.push(record);
    return record;
  }

  /** Never replace a journal with one containing fewer recorded external results. */
  remember(ticket: number, journal: Log): Log {
    const current = this.#journals.get(ticket);
    if (current === undefined || journal.portResults().length >= current.portResults().length) {
      this.#journals.set(ticket, journal);
    }
    return this.#journals.get(ticket)!;
  }

  get maxTicket(): number {
    return this.#records.reduce((maximum, record) => Math.max(maximum, record.ticket), 0);
  }

  journalFor(ticket: number): Log | undefined {
    return this.#journals.get(ticket);
  }

  get journals(): ReadonlyMap<number, Log> {
    return new Map(this.#journals);
  }

  forTicket(ticket: number): readonly Record[] {
    return this.#records.filter((record) => record.ticket === ticket);
  }

  ofKind(kind: LedgerKind): readonly Record[] {
    return this.#records.filter((record) => record.kind === kind);
  }

  toArray(): readonly Record[] {
    return [...this.#records];
  }

  get size(): number {
    return this.#records.length;
  }

  stateOf(ticket: number): LedgerKind | undefined {
    return this.forTicket(ticket).at(-1)?.kind;
  }
}
