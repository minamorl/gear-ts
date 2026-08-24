import { z } from 'zod';
import { Kit } from '../kit.js';
import { Intake, type Submission, type SubmissionOptions } from './intake.js';

type ChunkSource = string | Iterable<unknown> | AsyncIterable<unknown>;

export interface MachineFeedTarget {
  submit(options: SubmissionOptions): Submission;
}

export type FeedOptions =
  | { readonly io: ChunkSource; readonly machine: MachineFeedTarget; readonly intake?: never }
  | { readonly io: ChunkSource; readonly intake: Intake; readonly machine?: never };

const Envelope = z.object({
  name: z.unknown().optional(),
  focus: z.unknown().optional(),
  kit: z.unknown().optional(),
  seed: z.unknown().optional(),
}).passthrough();

export class Rejected {
  readonly line: string;
  readonly reason: string;

  constructor(line: string, reason: string) {
    this.line = line;
    this.reason = reason;
    Object.freeze(this);
  }
}

function iteratorFor(source: ChunkSource): AsyncIterator<unknown> {
  if (typeof source === 'string') {
    let available = true;
    return {
      async next() {
        if (!available) return { done: true, value: undefined };
        available = false;
        return { done: false, value: source };
      },
    };
  }
  const asyncSource = source as Partial<AsyncIterable<unknown>>;
  const asyncIterator = asyncSource[Symbol.asyncIterator];
  if (typeof asyncIterator === 'function') {
    return asyncIterator.call(asyncSource);
  }
  const iterator = (source as Iterable<unknown>)[Symbol.iterator]();
  return { async next() { return iterator.next(); } };
}

function detail(error: unknown): string {
  return error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error);
}

/**
 * One-line-at-a-time NDJSON ingress.
 *
 * A Machine target is the normal path: it records every accepted line in the ledger.
 * The Intake option is intentionally a low-level, non-machine seam for isolated framing tests;
 * submissions sent through it are not durable Machine submissions.
 */
export class Feed {
  readonly rejected: Rejected[] = [];
  readonly #accept: (options: SubmissionOptions) => Submission;
  readonly #iterator: AsyncIterator<unknown>;
  #buffer = '';
  #ended = false;

  constructor(options: FeedOptions) {
    const encodable = options.io as { setEncoding?: (encoding: 'utf8') => unknown };
    encodable.setEncoding?.('utf8');
    this.#iterator = iteratorFor(options.io);
    this.#accept = options.machine !== undefined
      ? (submission) => options.machine.submit(submission)
      : (submission) => options.intake.offer(submission);
  }

  /** The limit counts accepted submissions, not blank or rejected lines. */
  async absorb(options: { readonly limit?: number | null } = {}): Promise<readonly Submission[]> {
    const accepted: Submission[] = [];
    const limit = options.limit ?? null;
    while (limit === null || accepted.length < limit) {
      const line = await this.#readLine();
      if (line === null) break;
      const submission = this.#offer(line);
      if (submission !== undefined) accepted.push(submission);
    }
    return accepted;
  }

  async #readLine(): Promise<string | null> {
    while (true) {
      const newline = this.#buffer.indexOf('\n');
      if (newline >= 0) {
        const line = this.#buffer.slice(0, newline).replace(/\r$/u, '');
        this.#buffer = this.#buffer.slice(newline + 1);
        return line;
      }
      if (this.#ended) {
        if (this.#buffer.length === 0) return null;
        const line = this.#buffer.replace(/\r$/u, '');
        this.#buffer = '';
        return line;
      }
      try {
        const next = await this.#iterator.next();
        if (next.done) {
          this.#ended = true;
        } else {
          this.#buffer += String(next.value);
        }
      } catch {
        this.#ended = true;
      }
    }
  }

  #offer(line: string): Submission | undefined {
    const text = line.trim();
    if (text.length === 0) return undefined;
    try {
      const data = Envelope.parse(JSON.parse(text) as unknown);
      const name = data.name == null ? '' : String(data.name);
      if (name.length === 0) return this.#reject(text, 'name が無い');
      const kit = data.kit == null ? null : Kit.fromJSON(data.kit);
      let seed: number | null = null;
      if (data.seed != null) {
        if (typeof data.seed !== 'number' || !Number.isSafeInteger(data.seed)) {
          throw new TypeError('seed は安全な整数にする');
        }
        seed = data.seed;
      }
      return this.#accept({ name, focus: data.focus ?? {}, kit, seed });
    } catch (error) {
      if (error instanceof SyntaxError) {
        return this.#reject(text, `JSON として読めない: ${error.message}`);
      }
      return this.#reject(text, `投入として受けられない: ${detail(error)}`);
    }
  }

  #reject(line: string, reason: string): undefined {
    this.rejected.push(new Rejected(line, reason));
    return undefined;
  }
}
