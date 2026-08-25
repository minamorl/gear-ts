import { Entry, JournalWriteError, Log, PORT_RESULT, type EntrySink } from '../journal.js';
import { normalizeJson } from '../json.js';
import { Receipt, type ReceiptOutcome } from '../receipt.js';
import type { VerdictValue } from '../admission/verdict.js';

function errorName(error: unknown): string {
  if (error instanceof Error) return error.constructor.name || error.name || 'Error';
  return typeof error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Append-only run bookkeeping. Every method completes without awaiting execution. */
export class Recorder {
  #log = new Log();
  readonly #receipts: Receipt[] = [];
  readonly #sink: EntrySink | undefined;
  #last: Receipt | null = null;

  constructor(sink?: EntrySink) {
    this.#sink = sink;
  }

  get journal(): Log {
    return this.#log;
  }

  get receipts(): readonly Receipt[] {
    return [...this.#receipts];
  }

  effect(input: {
    readonly tick: number;
    readonly tag: string;
    readonly payload: unknown;
    readonly recorded: unknown;
    readonly verdict: VerdictValue;
    readonly external: boolean;
  }): Receipt {
    if (input.external) {
      this.#append(input.tick, PORT_RESULT, {
        port: input.tag,
        request: input.payload,
        result: input.recorded,
      });
    }
    return this.#issue(
      input.tick,
      input.tag,
      input.payload,
      Receipt.ok(input.recorded),
      input.verdict,
    );
  }

  failure(input: {
    readonly tick: number;
    readonly tag: string;
    readonly payload: unknown;
    readonly verdict: VerdictValue;
    readonly error: unknown;
  }): Receipt {
    const name = errorName(input.error);
    const message = errorMessage(input.error);
    this.#append(input.tick, 'effect_failed', {
      port: input.tag,
      payload: input.payload,
      error: name,
      message,
    });
    return this.#issue(
      input.tick,
      input.tag,
      input.payload,
      Receipt.err(`${name}: ${message}`),
      input.verdict,
    );
  }

  denial(input: {
    readonly tick: number;
    readonly tag: string;
    readonly payload: unknown;
    readonly verdict: VerdictValue & { readonly denied: true };
  }): void {
    this.#append(input.tick, 'admission_denied', {
      tag: input.tag,
      payload: input.payload,
      reason: input.verdict.reason,
      by: input.verdict.by,
    });
  }

  #append(tick: number, kind: string, payload: Record<string, unknown>): void {
    const entry = Entry.at(tick, kind, payload);
    try {
      this.#sink?.append(entry);
    } catch (cause) {
      if (cause instanceof JournalWriteError) throw cause;
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new JournalWriteError(`journal append failed: ${detail}`);
    }
    this.#log = this.#log.append(entry);
  }

  #issue(
    tick: number,
    tag: string,
    payload: unknown,
    outcome: ReceiptOutcome,
    verdict: VerdictValue,
  ): Receipt {
    const receipt = Receipt.issue({
      effect: { tag, payload: normalizeJson(payload) },
      outcome,
      grounds: verdict,
      tick,
      predecessor: this.#last,
    });
    this.#append(tick, 'receipt', { ...receipt.toJSON() });
    this.#receipts.push(receipt);
    this.#last = receipt;
    return receipt;
  }
}
