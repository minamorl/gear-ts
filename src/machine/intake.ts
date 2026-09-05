import { z } from 'zod';
import { normalizeJson } from '../json.js';
import { Kit, type KitDeclaration } from '../kit.js';

const SubmissionRecordSchema = z.object({
  ticket: z.number().int().positive(),
  name: z.string().min(1),
  focus: z.unknown(),
  kit: z.unknown().nullable(),
  seed: z.number().int().safe(),
});

export interface SubmissionOptions {
  readonly name: string;
  readonly focus?: unknown;
  readonly kit?: Kit | null;
  readonly seed?: number | null;
}

export interface SubmissionRecord {
  readonly [key: string]: unknown;
  readonly ticket: number;
  readonly name: string;
  readonly focus: unknown;
  readonly kit: KitDeclaration | null;
  readonly seed: number;
}

function safeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be a safe integer`);
  return value;
}

/** One accepted, JSON-safe program submission. */
export class Submission {
  readonly ticket: number;
  readonly name: string;
  readonly focus: unknown;
  readonly kit: Kit | null;
  readonly seed: number;

  constructor(input: {
    readonly ticket: number;
    readonly name: string;
    readonly focus: unknown;
    readonly kit: Kit | null;
    readonly seed: number;
  }) {
    this.ticket = safeInteger(input.ticket, 'ticket');
    this.name = String(input.name);
    if (this.name.length === 0) throw new TypeError('program name must not be empty');
    this.focus = normalizeJson(input.focus);
    this.kit = input.kit;
    this.seed = safeInteger(input.seed, 'seed');
    Object.freeze(this);
  }

  static fromRecord(value: unknown): Submission {
    const record = SubmissionRecordSchema.parse(value);
    return new Submission({
      ticket: record.ticket,
      name: record.name,
      focus: record.focus,
      kit: record.kit === null ? null : Kit.fromJSON(record.kit),
      seed: record.seed,
    });
  }

  toJSON(): SubmissionRecord {
    return normalizeJson({
      ticket: this.ticket,
      name: this.name,
      focus: this.focus,
      kit: this.kit?.toJSON() ?? null,
      seed: this.seed,
    }) as unknown as SubmissionRecord;
  }
}

/** Deterministic in-process FIFO. Offering never runs or judges a program. */
export class Intake {
  readonly #queue: Submission[] = [];
  #issued = 0;

  constructor(pending: Iterable<Submission> = []) {
    for (const submission of pending) {
      this.#queue.push(submission);
      this.#issued = Math.max(this.#issued, submission.ticket);
    }
  }

  offer(options: SubmissionOptions): Submission {
    this.#issued += 1;
    const seed = options.seed ?? this.#issued;
    const submission = new Submission({
      ticket: this.#issued,
      name: options.name,
      focus: options.focus ?? {},
      kit: options.kit ?? null,
      seed,
    });
    this.#queue.push(submission);
    return submission;
  }

  take(): Submission | undefined {
    return this.#queue.shift();
  }

  get size(): number {
    return this.#queue.length;
  }

  get empty(): boolean {
    return this.#queue.length === 0;
  }

  get pending(): readonly Submission[] {
    return [...this.#queue];
  }

  get issued(): number {
    return this.#issued;
  }

  advanceTo(ticket: number): void {
    const carried = safeInteger(Number(ticket), 'ticket');
    this.#issued = Math.max(this.#issued, carried);
  }
}
