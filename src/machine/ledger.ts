import type { Log } from '../journal.js';
import { normalizeJson, type JsonObject } from '../json.js';
import { z } from 'zod';

export const ACCEPTED = 'accepted' as const;
export const DENIED = 'denied' as const;
export const COMPLETED = 'completed' as const;
export const SUSPENDED = 'suspended' as const;

export type LedgerKind = typeof ACCEPTED | typeof DENIED | typeof COMPLETED | typeof SUSPENDED;

const LedgerKindSchema = z.enum([ACCEPTED, DENIED, COMPLETED, SUSPENDED]);
const RecordSchema = z.object({
  ticket: z.number().int().positive().safe(),
  kind: LedgerKindSchema,
  payload: z.record(z.string(), z.unknown()),
});

export class LedgerDecodeError extends Error {
  readonly line: number;

  constructor(message: string, line: number, options?: ErrorOptions) {
    super(`machine ledger line ${line}: ${message}`, options);
    this.name = 'LedgerDecodeError';
    this.line = line;
  }
}

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

export function encode(record: Record): string {
  return JSON.stringify({ ticket: record.ticket, kind: record.kind, payload: record.payload });
}

export function load(text: string): readonly Record[] {
  const records: Record[] = [];
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const source = lines[index]!;
    if (source.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(source) as unknown;
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new LedgerDecodeError(`invalid JSON: ${detail}`, index + 1, { cause });
    }
    const parsed = RecordSchema.safeParse(value);
    if (!parsed.success) {
      throw new LedgerDecodeError(z.prettifyError(parsed.error), index + 1);
    }
    records.push(new Record(parsed.data.ticket, parsed.data.kind, parsed.data.payload));
  }
  return records;
}

export interface LedgerOptions {
  readonly records?: Iterable<Record>;
  readonly journals?: Iterable<readonly [number, Log]>;
  readonly onAppend?: (record: Record) => void;
}

/** Append-only intake history plus indexes to the authoritative per-run journals. */
export class Ledger {
  readonly #records: Record[];
  readonly #journals: Map<number, Log>;
  readonly #onAppend: ((record: Record) => void) | undefined;

  constructor(options: LedgerOptions = {}) {
    this.#records = Array.from(options.records ?? []);
    this.#journals = new Map(options.journals ?? []);
    this.#onAppend = options.onAppend;
  }

  append(input: {
    readonly ticket: number;
    readonly kind: LedgerKind;
    readonly payload?: globalThis.Record<string, unknown>;
  }): Record {
    const record = new Record(input.ticket, input.kind, input.payload ?? {});
    this.#onAppend?.(record);
    this.#records.push(record);
    return record;
  }

  /** Never replace a remembered journal with a shorter reconstructed record. */
  remember(ticket: number, journal: Log): Log {
    const current = this.#journals.get(ticket);
    if (
      current === undefined ||
      (journal.size >= current.size &&
        journal.portResults().length >= current.portResults().length)
    ) {
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
