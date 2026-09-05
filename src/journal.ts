import { ControlSignal } from '@minamorl/berylx';
import { z } from 'zod';
import { normalizeJson, stableJson, type JsonObject } from './json.js';

export const PORT_RESULT = 'port_result' as const;

export class ReplayMismatch extends ControlSignal {
  readonly tick: number;
  readonly recordedPort: unknown;
  readonly requestedTag: string;
  readonly position: number;

  constructor(
    tick: number,
    recordedPort: unknown,
    requestedTag: string,
    position: number,
  ) {
    super(
      `tick ${tick}: the journal recorded ${String(recordedPort)} but ` +
        `the program requested ${requestedTag}`,
    );
    this.tick = tick;
    this.recordedPort = recordedPort;
    this.requestedTag = requestedTag;
    this.position = position;
  }
}

export class CrossedBoundary extends Error {
  readonly position: number;

  constructor(message: string, position: number) {
    super(message);
    this.name = 'CrossedBoundary';
    this.position = position;
  }
}

export class ReplayUnreadable extends ControlSignal {
  readonly tick: number;
  readonly tag: string;
  readonly violations: readonly z.ZodIssue[];
  readonly position: number;
  readonly value: unknown;

  constructor(
    tick: number,
    tag: string,
    violations: readonly z.ZodIssue[],
    position: number,
    value: unknown,
  ) {
    super(
      `tick ${tick}: the record for ${tag} cannot be read back through its result schema: ` +
        violations.map((violation) => violation.message).join('; '),
    );
    this.tick = tick;
    this.tag = tag;
    this.violations = Object.freeze([...violations]);
    this.position = position;
    this.value = value;
  }
}

export class JournalDecodeError extends Error {
  readonly line: number;

  constructor(message: string, line: number, options?: ErrorOptions) {
    super(`journal line ${line}: ${message}`, options);
    this.name = 'JournalDecodeError';
    this.line = line;
  }
}

export class Entry {
  readonly tick: number;
  readonly kind: string;
  readonly payload: JsonObject;

  private constructor(tick: number, kind: string, payload: Record<string, unknown>) {
    this.tick = tick;
    this.kind = kind;
    this.payload = normalizeJson(payload) as JsonObject;
    Object.freeze(this);
  }

  static at(tick: number, kind: string, payload: Record<string, unknown> = {}): Entry {
    return new Entry(tick, kind, payload);
  }
}

/** A synchronous append boundary used when a run journal is made durable. */
export interface EntrySink {
  append(entry: Entry): void;
}

export class JournalWriteError extends ControlSignal {
  constructor(message: string) {
    super(message);
    this.name = 'JournalWriteError';
  }
}

export const EntrySchema = z.object({
  tick: z.number().int(),
  kind: z.string(),
  payload: z.record(z.string(), z.unknown()),
});

export class Log implements Iterable<Entry> {
  readonly #entries: readonly Entry[];

  constructor(entries: Iterable<Entry> = []) {
    this.#entries = Object.freeze(Array.from(entries));
    Object.freeze(this);
  }

  append(entry: Entry): Log {
    return new Log([...this.#entries, entry]);
  }

  [Symbol.iterator](): Iterator<Entry> {
    return this.#entries[Symbol.iterator]();
  }

  toArray(): readonly Entry[] {
    return this.#entries;
  }

  get size(): number {
    return this.#entries.length;
  }

  get empty(): boolean {
    return this.#entries.length === 0;
  }

  fold<T>(initial: T, reducer: (state: T, entry: Entry) => T): T {
    return this.#entries.reduce(reducer, initial);
  }

  portResults(): readonly Entry[] {
    return this.#entries.filter((entry) => entry.kind === PORT_RESULT);
  }
}

type DecodedLine = { readonly line: number; readonly value: unknown };

// Intentionally local and small: Journal owns NDJSON framing and diagnostics.
function parseNdjson(text: string): DecodedLine[] {
  const decoded: DecodedLine[] = [];
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const source = lines[index]!;
    if (source.trim() === '') {
      continue;
    }
    try {
      decoded.push({ line: index + 1, value: JSON.parse(source) as unknown });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new JournalDecodeError(`invalid JSON: ${detail}`, index + 1, { cause });
    }
  }
  return decoded;
}

function sameRequest(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

export class RecordedBoundary {
  #log: Log;
  readonly #mode: 'record' | 'replay';
  readonly #recorded: readonly Entry[];
  #cursor = 0;

  private constructor(log: Log, mode: 'record' | 'replay') {
    this.#log = log;
    this.#mode = mode;
    this.#recorded = log.portResults();
  }

  static recording(log = new Log()): RecordedBoundary {
    return new RecordedBoundary(log, 'record');
  }

  static replaying(log: Log): RecordedBoundary {
    return new RecordedBoundary(log, 'replay');
  }

  get log(): Log {
    return this.#log;
  }

  get recording(): boolean {
    return this.#mode === 'record';
  }

  get replaying(): boolean {
    return this.#mode === 'replay';
  }

  call<T>(tick: number, port: string, invoke: () => T): T;
  call<T>(
    tick: number,
    port: string,
    payload: unknown,
    invoke: () => T,
    resultSchema?: z.ZodType<T>,
  ): T;
  call<T>(
    tick: number,
    port: string,
    payloadOrInvoke: unknown | (() => T),
    maybeInvoke?: () => T,
    resultSchema?: z.ZodType<T>,
  ): T {
    const legacy = typeof payloadOrInvoke === 'function';
    const payload = legacy ? null : payloadOrInvoke;
    const invoke = (legacy ? payloadOrInvoke : maybeInvoke) as (() => T) | undefined;
    if (this.replaying) {
      return this.#replayNext(port, payload, resultSchema);
    }
    if (!invoke) {
      throw new TypeError('recording a boundary requires an external operation');
    }
    const result = this.#parseResult(invoke(), resultSchema, tick, port, this.#cursor);
    this.#log = this.#log.append(
      Entry.at(tick, PORT_RESULT, { port, request: payload, result }),
    );
    this.#cursor += 1;
    return result;
  }

  async callAsync<T>(
    tick: number,
    port: string,
    payload: unknown,
    invoke: () => T | Promise<T>,
    resultSchema?: z.ZodType<T>,
  ): Promise<T> {
    if (this.replaying) {
      return this.#replayNext(port, payload, resultSchema);
    }
    const result = this.#parseResult(await invoke(), resultSchema, tick, port, this.#cursor);
    this.#log = this.#log.append(
      Entry.at(tick, PORT_RESULT, { port, request: payload, result }),
    );
    this.#cursor += 1;
    return result;
  }

  #replayNext<T>(port: string, payload: unknown, resultSchema?: z.ZodType<T>): T {
    const position = this.#cursor;
    const entry = this.#recorded[position];
    if (!entry) {
      throw new CrossedBoundary('recorded external results are exhausted', position);
    }
    const recordedPort = entry.payload.port;
    const recordedRequest = 'request' in entry.payload ? entry.payload.request : null;
    if (recordedPort !== port || !sameRequest(recordedRequest, payload)) {
      throw new ReplayMismatch(entry.tick, recordedPort, port, position);
    }
    const result = this.#parseResult(entry.payload.result, resultSchema, entry.tick, port, position);
    this.#cursor += 1;
    return result;
  }

  #parseResult<T>(
    value: unknown,
    schema: z.ZodType<T> | undefined,
    tick: number,
    tag: string,
    position: number,
  ): T {
    if (!schema) {
      return value as T;
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new ReplayUnreadable(tick, tag, parsed.error.issues, position, value);
    }
    return parsed.data;
  }
}

export function dump(log: Log): string {
  const lines = log.toArray().map((entry) =>
    JSON.stringify({ tick: entry.tick, kind: entry.kind, payload: entry.payload }),
  );
  return `${lines.join('\n')}\n`;
}

export function load(text: string): Log {
  const entries = parseNdjson(text).map(({ line, value }) => {
    const parsed = EntrySchema.safeParse(value);
    if (!parsed.success) {
      throw new JournalDecodeError(z.prettifyError(parsed.error), line);
    }
    return Entry.at(parsed.data.tick, parsed.data.kind, parsed.data.payload);
  });
  return new Log(entries);
}
