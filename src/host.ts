// ==================================================================
// Host — a shell for setting gear up as a "resident of a separate process."
//
// Position of gear.spec:
//   pin runtime.in_language        : gear.runtime.form = in_language_runtime
//   pin runtime.not_a_daemon_core  : forbid gear.runtime.form = separate_process_daemon_core
//   free machine.hosting           : supervision when a Machine is set up as
//                                    a resident of a separate process
//                                    (startup · restart · multi-Machine) shape undecided
//
// What is forbidden is "making the core a daemon," not "setting it up as a resident."
// Host is only a shell that holds the Machine **as an in-language runtime**, and does not
// create any path to RPC to the core from the outside. Submissions enter in-process
// via the Intake queue, one raw data line at a time through Feed, per pin ui.transport_core_in_process.
//
// There is no Ruby equivalent (no bin/ or executables in the gear gem). So this is
// not a port but a new piece, and the only face that cannot be answer-checked
// against Ruby.
// ==================================================================
import { Err } from '@minamorl/berylx';
import { Machine } from './machine.js';
import { Feed } from './machine/feed.js';
import type { Registry as ProgramRegistry } from './program.js';

export interface HostOptions {
  /** Where raw one-item-per-line data streams in. FIFO or stdin are both fine. */
  readonly io: NodeJS.ReadableStream;
  /** Programs that may be dispatched. May be empty if there are no passengers (a Machine that accepts nothing). */
  readonly programs: ProgramRegistry;
  /** Where Machine ledger and per-ticket journals live, when provided. */
  readonly stateDir?: string;
  /** Max items to process per drain. Null means drain until the intake queue is empty. */
  readonly drainLimit?: number | null;
  /** Where to report progress. Silent by default. */
  readonly report?: (event: HostEvent) => void;
}

export type HostEvent =
  | { readonly kind: 'accepted'; readonly ticket: number }
  | { readonly kind: 'rejected'; readonly line: string; readonly reason: string }
  | {
      readonly kind: 'completed';
      readonly ticket: number;
      /** Whether admission rejected it. Distinct from the execution failing. */
      readonly denied: boolean;
      /** The outcome of the run itself. ok / err / suspended. */
      readonly outcome: 'ok' | 'err' | 'suspended';
      /** The reason if err. A resident can't be peeped from outside, so do not leave this empty. */
      readonly error?: string;
      readonly receipts: number;
      readonly lastTick: number;
    }
  | { readonly kind: 'stopped'; readonly accepted: number; readonly completed: number };

/**
 * Submits received lines to the Machine and advances them until they finish.
 *
 * Feed#absorb does not return until io closes, so submissions and executions are interleaved.
 * The run itself is the Machine's own in-language runtime, and Host does not take the side
 * of advancing the tick (that is Machine#drain).
 */
export class Host {
  readonly machine: Machine;
  readonly #feed: Feed;
  readonly #drainLimit: number | null;
  readonly #report: (event: HostEvent) => void;
  #accepted = 0;
  #completed = 0;
  #stopping = false;

  constructor(options: HostOptions) {
    this.machine = new Machine({ programs: options.programs, stateDir: options.stateDir });
    this.#feed = new Feed({ io: options.io, machine: this.machine });
    this.#drainLimit = options.drainLimit ?? null;
    this.#report = options.report ?? (() => {});
  }

  /** Stop from outside. Finishes the currently-running work (does not discard it) before returning. */
  stop(): void {
    this.#stopping = true;
  }

  /**
   * Runs until io closes.
   *
   * Absorbs one line at a time and drains the intake queue each time. If you absorbed in bulk
   * and ran in bulk, the correspondence between "submitted order" and "run order" would become
   * hard to read from the journal.
   */
  async run(): Promise<{ readonly accepted: number; readonly completed: number }> {
    // A previous process may have durably accepted an item before it could pick it up.
    await this.#drain();
    while (!this.#stopping) {
      const before = this.#feed.rejected.length;
      const submissions = await this.#feed.absorb({ limit: 1 });
      for (const rejected of this.#feed.rejected.slice(before)) {
        this.#report({ kind: 'rejected', line: rejected.line, reason: rejected.reason });
      }
      if (submissions.length === 0) break; // io closed
      for (const submission of submissions) {
        this.#accepted += 1;
        this.#report({ kind: 'accepted', ticket: submission.ticket });
      }
      await this.#drain();
    }
    await this.#drain(); // do not drop items that remained at the moment of the stop signal
    const totals = { accepted: this.#accepted, completed: this.#completed };
    this.#report({ kind: 'stopped', ...totals });
    return totals;
  }

  async #drain(): Promise<void> {
    const completions = await this.machine.drain({ limit: this.#drainLimit });
    for (const completion of completions) {
      this.#completed += 1;
      const outcome = completion.outcome;
      // Reporting only "completed" would make it impossible to distinguish a failed run from a successful one.
      // A resident cannot be peeped from outside, so always leave the outcome type and reason here.
      const failed = outcome.result instanceof Err;
      this.#report({
        kind: 'completed',
        ticket: completion.ticket,
        denied: Machine.denied(outcome),
        outcome: outcome.suspended ? 'suspended' : failed ? 'err' : 'ok',
        ...(failed ? { error: String((outcome.result as Err).error ?? 'unknown') } : {}),
        receipts: outcome.receipts.length,
        lastTick: outcome.lastTick,
      });
    }
  }
}
