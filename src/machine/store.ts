import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  Entry,
  JournalDecodeError,
  JournalWriteError,
  Log,
  load as loadJournal,
  type EntrySink,
} from '../journal.js';
import { stableJson } from '../json.js';
import { Intake, Submission } from './intake.js';
import {
  ACCEPTED,
  Ledger,
  LedgerDecodeError,
  encode as encodeLedgerRecord,
  load as loadLedger,
  type Record as LedgerRecord,
} from './ledger.js';

const LEDGER_FILE = 'machine-ledger.ndjson';
const JOURNAL_DIRECTORY = 'journals';

function sameEntry(left: Entry, right: Entry): boolean {
  return left.tick === right.tick && left.kind === right.kind &&
    stableJson(left.payload) === stableJson(right.payload);
}

function lineOfUnterminated(text: string): number {
  return text.split(/\r?\n/u).length;
}

function requireTerminatedLedger(text: string): void {
  if (text.length > 0 && !text.endsWith('\n')) {
    throw new LedgerDecodeError('unterminated NDJSON record', lineOfUnterminated(text));
  }
}

function requireTerminatedJournal(text: string): void {
  if (text.length > 0 && !text.endsWith('\n')) {
    throw new JournalDecodeError('unterminated NDJSON entry', lineOfUnterminated(text));
  }
}

function encodeJournalEntry(entry: Entry): string {
  return JSON.stringify({ tick: entry.tick, kind: entry.kind, payload: entry.payload });
}

export class JournalAppendMismatch extends JournalWriteError {
  readonly ticket: number;
  readonly line: number;

  constructor(ticket: number, line: number, detail: string) {
    super(`ticket ${ticket} journal line ${line}: ${detail}`);
    this.name = 'JournalAppendMismatch';
    this.ticket = ticket;
    this.line = line;
  }
}

export class JournalWriter implements EntrySink {
  readonly #ticket: number;
  readonly #path: string;
  readonly #recorded: readonly Entry[];
  #journal: Log;
  #cursor = 0;

  constructor(ticket: number, path: string, journal: Log) {
    this.#ticket = ticket;
    this.#path = path;
    this.#recorded = journal.toArray();
    this.#journal = journal;
  }

  append(entry: Entry): void {
    const recorded = this.#recorded[this.#cursor];
    if (recorded !== undefined) {
      if (!sameEntry(recorded, entry)) {
        throw new JournalAppendMismatch(
          this.#ticket,
          this.#cursor + 1,
          `recorded ${recorded.kind} entry does not match replayed ${entry.kind} entry`,
        );
      }
      this.#cursor += 1;
      return;
    }

    appendFileSync(this.#path, `${encodeJournalEntry(entry)}\n`, { mode: 0o600 });
    this.#journal = this.#journal.append(entry);
    this.#cursor += 1;
  }

  /** A completed replay must account for every existing append-only entry. */
  assertComplete(): void {
    if (this.#cursor < this.#recorded.length) {
      const recorded = this.#recorded[this.#cursor]!;
      throw new JournalAppendMismatch(
        this.#ticket,
        this.#cursor + 1,
        `completed replay ended before recorded ${recorded.kind} entry`,
      );
    }
  }

  get journal(): Log {
    return this.#journal;
  }
}

export interface LoadedMachineState {
  readonly ledger: Ledger;
  readonly intake: Intake;
}

/** Append-only filesystem storage rooted outside immutable releases by its caller. */
export class FileStore {
  readonly stateDir: string;
  readonly ledgerPath: string;
  readonly journalsDir: string;

  constructor(stateDir: string) {
    if (stateDir.length === 0) throw new TypeError('stateDir must not be empty');
    this.stateDir = resolve(stateDir);
    this.ledgerPath = join(this.stateDir, LEDGER_FILE);
    this.journalsDir = join(this.stateDir, JOURNAL_DIRECTORY);
    mkdirSync(this.journalsDir, { recursive: true, mode: 0o700 });
  }

  load(): LoadedMachineState {
    const records = this.#loadLedger();
    const journals = this.#loadJournals();
    const ledger = new Ledger({
      records,
      journals,
      onAppend: (record) => this.#appendLedger(record),
    });
    const pending = records
      .filter((record) => record.kind === ACCEPTED && ledger.stateOf(record.ticket) === ACCEPTED)
      .map((record) => Submission.fromRecord(record.payload));
    return { ledger, intake: new Intake(pending) };
  }

  journalPath(ticket: number): string {
    if (!Number.isSafeInteger(ticket) || ticket <= 0) {
      throw new TypeError('ticket must be a positive safe integer');
    }
    return join(this.journalsDir, `${ticket}.ndjson`);
  }

  writer(ticket: number, journal: Log): JournalWriter {
    return new JournalWriter(ticket, this.journalPath(ticket), journal);
  }

  #loadLedger(): readonly LedgerRecord[] {
    if (!existsSync(this.ledgerPath)) return [];
    const text = readFileSync(this.ledgerPath, 'utf8');
    requireTerminatedLedger(text);
    return loadLedger(text);
  }

  #loadJournals(): ReadonlyMap<number, Log> {
    const journals = new Map<number, Log>();
    for (const entry of readdirSync(this.journalsDir, { withFileTypes: true })) {
      const match = /^(\d+)\.ndjson$/u.exec(entry.name);
      if (!entry.isFile() || match === null) continue;
      const ticket = Number(match[1]);
      if (!Number.isSafeInteger(ticket) || ticket <= 0) continue;
      const path = join(this.journalsDir, entry.name);
      const text = readFileSync(path, 'utf8');
      requireTerminatedJournal(text);
      journals.set(ticket, loadJournal(text));
    }
    return journals;
  }

  #appendLedger(record: LedgerRecord): void {
    appendFileSync(this.ledgerPath, `${encodeLedgerRecord(record)}\n`, { mode: 0o600 });
  }
}
