import { AsyncTask, Err, Ok } from '@minamorl/berylx';
import { AllowAll, type Policy } from './admission/policy.js';
import { run, type Outcome } from './executor.js';
import { Log } from './journal.js';
import { PROGRAM_SUBMIT_TAG } from './tags.js';
import { registry as defaultRegistry, type Registry as PortRegistry } from './port/index.js';
import type { Registry as ProgramRegistry } from './program.js';
import { Feed } from './machine/feed.js';
import { Intake, Submission, type SubmissionOptions } from './machine/intake.js';
import { FileStore } from './machine/store.js';
import {
  ACCEPTED,
  COMPLETED,
  DENIED,
  Ledger,
  SUSPENDED,
  type LedgerKind,
} from './machine/ledger.js';

export interface MachineOptions {
  readonly programs: ProgramRegistry;
  readonly ports?: PortRegistry;
  readonly policy?: Policy;
  readonly intake?: Intake;
  readonly ledger?: Ledger;
  /** Opt-in append-only filesystem persistence. */
  readonly stateDir?: string;
  /** A reusable explicit store seam; mutually exclusive with stateDir. */
  readonly store?: FileStore;
}

export interface AdvanceOptions {
  readonly maxEffects?: number | null;
}

export interface DrainOptions extends AdvanceOptions {
  readonly limit?: number | null;
}

export class Completion {
  readonly ticket: number;
  readonly outcome: Outcome;

  constructor(ticket: number, outcome: Outcome) {
    this.ticket = ticket;
    this.outcome = outcome;
    Object.freeze(this);
  }

  get suspended(): boolean {
    return this.outcome.suspended;
  }

  get denied(): boolean {
    return Machine.denied(this.outcome);
  }

  get produced(): Record<string, unknown> | null {
    if (this.suspended || !(this.outcome.result instanceof Ok)) return null;
    const value = (this.outcome.result.focus.toObject() as Record<string, unknown>).produced;
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  }
}

/** Explicitly stepped shell around intake, admission, executor, journal, and receipts. */
export class Machine {
  readonly intake: Intake;
  readonly ledger: Ledger;
  readonly #programs: ProgramRegistry;
  readonly #ports: PortRegistry;
  readonly #policy: Policy;
  readonly #store: FileStore | undefined;

  constructor(options: MachineOptions) {
    this.#programs = options.programs;
    this.#ports = options.ports ?? defaultRegistry;
    this.#policy = options.policy ?? new AllowAll();
    if (options.stateDir !== undefined && options.store !== undefined) {
      throw new TypeError('stateDir and store are mutually exclusive');
    }
    this.#store = options.store ?? (options.stateDir === undefined
      ? undefined
      : new FileStore(options.stateDir));
    if (this.#store !== undefined && (options.intake !== undefined || options.ledger !== undefined)) {
      throw new TypeError('persistent Machine restores its own intake and ledger');
    }
    if (this.#store === undefined) {
      this.intake = options.intake ?? new Intake();
      this.ledger = options.ledger ?? new Ledger();
    } else {
      const restored = this.#store.load();
      this.intake = restored.intake;
      this.ledger = restored.ledger;
    }
    this.intake.advanceTo(this.ledger.maxTicket);
  }

  static denied(outcome: Outcome): boolean {
    return outcome.result instanceof Err &&
      outcome.journal.toArray().some((entry) => entry.kind === 'admission_denied');
  }

  /** Accept and record only. Admission happens later when step picks the item up. */
  submit(options: SubmissionOptions): Submission {
    const submission = this.intake.offer(options);
    this.ledger.append({ ticket: submission.ticket, kind: ACCEPTED, payload: submission.toJSON() });
    return submission;
  }

  async step(options: AdvanceOptions = {}): Promise<Completion | undefined> {
    const submission = this.intake.take();
    if (submission === undefined) return undefined;
    const journal = this.ledger.journalFor(submission.ticket) ?? new Log();
    return this.#launch(submission, journal, options.maxEffects ?? null);
  }

  async drain(options: DrainOptions = {}): Promise<readonly Completion[]> {
    const completed: Completion[] = [];
    const limit = options.limit ?? null;
    while (!this.intake.empty && (limit === null || completed.length < limit)) {
      const completion = await this.step({ maxEffects: options.maxEffects });
      if (completion !== undefined) completed.push(completion);
    }
    return completed;
  }

  async resume(ticket: number, options: AdvanceOptions = {}): Promise<Completion> {
    const journal = this.ledger.journalFor(ticket);
    if (journal === undefined) throw new Error(`ticket ${ticket} has no run to continue`);
    return this.#launch(this.#submissionOf(ticket), journal, options.maxEffects ?? null);
  }

  get pending(): number {
    return this.intake.size;
  }

  journalFor(ticket: number): Log | undefined {
    return this.ledger.journalFor(ticket);
  }

  stateOf(ticket: number): LedgerKind | undefined {
    return this.ledger.stateOf(ticket);
  }

  #submissionOf(ticket: number): Submission {
    const accepted = this.ledger.forTicket(ticket).find((record) => record.kind === ACCEPTED);
    if (accepted === undefined) throw new Error(`ticket ${ticket} has no intake record`);
    return Submission.fromRecord(accepted.payload);
  }

  async #launch(submission: Submission, journal: Log, maxEffects: number | null): Promise<Completion> {
    const writer = this.#store?.writer(submission.ticket, journal);
    try {
      const outcome = await run(this.#entryProgram(submission), {
        policy: this.#policy,
        seed: submission.seed,
        registry: this.#ports,
        programs: this.#programs,
        kit: submission.kit,
        journal,
        journalSink: writer,
        maxEffects,
      });
      if (!outcome.suspended) writer?.assertComplete();
      this.#record(submission.ticket, outcome);
      return new Completion(submission.ticket, outcome);
    } catch (error) {
      if (writer !== undefined) this.ledger.remember(submission.ticket, writer.journal);
      throw error;
    }
  }

  #entryProgram(submission: Submission): AsyncTask {
    const payload = { name: submission.name, focus: submission.focus };
    return AsyncTask.of(`pickup_${submission.ticket}`, async (lay, io) =>
      lay.put('produced', await io.perform(PROGRAM_SUBMIT_TAG, payload)),
    );
  }

  #record(ticket: number, outcome: Outcome): void {
    this.ledger.remember(ticket, outcome.journal);
    this.ledger.append({ ticket, kind: this.#kindOf(outcome), payload: this.#summary(outcome) });
  }

  #kindOf(outcome: Outcome): LedgerKind {
    if (outcome.suspended) return SUSPENDED;
    if (Machine.denied(outcome)) return DENIED;
    return COMPLETED;
  }

  #summary(outcome: Outcome): Record<string, unknown> {
    const denial = outcome.journal.toArray().filter((entry) => entry.kind === 'admission_denied').at(-1);
    const summary: Record<string, unknown> = {
      receipts: outcome.receipts.length,
      last_tick: outcome.lastTick,
      suspended: outcome.suspended,
    };
    if (denial?.payload.reason !== undefined) summary.reason = denial.payload.reason;
    return summary;
  }
}

export { Feed, FileStore, Intake, Submission, Ledger };
