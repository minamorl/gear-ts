import type { Entry, Log } from './journal.js';
import { PORT_RESULT } from './journal.js';
import { Machine } from './machine.js';
import type { Submission, SubmissionOptions } from './machine/intake.js';

export interface EffectView {
  readonly tick: number;
  readonly port: unknown;
}

export interface DenialView {
  readonly tick: number;
  readonly tag: unknown;
  readonly reason: unknown;
}

export interface ReceiptView {
  readonly tick: number;
  readonly id: unknown;
  readonly tag: unknown;
  readonly predecessor: unknown;
}

export interface ProjectionSummary {
  readonly last_tick: number;
  readonly effects: readonly EffectView[];
  readonly denials: readonly DenialView[];
  readonly receipts: readonly ReceiptView[];
}

export class Projection {
  readonly lastTick: number;
  readonly effects: readonly EffectView[];
  readonly denials: readonly DenialView[];
  readonly receipts: readonly ReceiptView[];

  constructor(input: {
    readonly lastTick: number;
    readonly effects: Iterable<EffectView>;
    readonly denials: Iterable<DenialView>;
    readonly receipts: Iterable<ReceiptView>;
  }) {
    this.lastTick = input.lastTick;
    this.effects = Object.freeze(Array.from(input.effects, (entry) => Object.freeze({ ...entry })));
    this.denials = Object.freeze(Array.from(input.denials, (entry) => Object.freeze({ ...entry })));
    this.receipts = Object.freeze(Array.from(input.receipts, (entry) => Object.freeze({ ...entry })));
    Object.freeze(this);
  }

  /** Tick-only or unrelated journal entries do not make a view noisy. */
  get quiet(): boolean {
    return this.effects.length === 0 && this.denials.length === 0 && this.receipts.length === 0;
  }

  toJSON(): ProjectionSummary {
    return {
      last_tick: this.lastTick,
      effects: this.effects.map((entry) => ({ ...entry })),
      denials: this.denials.map((entry) => ({ ...entry })),
      receipts: this.receipts.map((entry) => ({ ...entry })),
    };
  }
}

function receiptOf(entry: Entry): ReceiptView {
  const effect = entry.payload.effect;
  const summary = effect !== null && typeof effect === 'object' && !Array.isArray(effect)
    ? effect as Readonly<Record<string, unknown>>
    : {};
  return {
    tick: entry.tick,
    id: entry.payload.id,
    tag: summary.tag,
    predecessor: entry.payload.predecessor,
  };
}

/** Derive a fresh projection solely by folding the supplied journal. */
export function project(journal: Log | Iterable<Entry>): Projection {
  let lastTick: number | undefined;
  const effects: EffectView[] = [];
  const denials: DenialView[] = [];
  const receipts: ReceiptView[] = [];

  for (const entry of journal) {
    lastTick = lastTick === undefined ? entry.tick : Math.max(lastTick, entry.tick);
    if (entry.kind === PORT_RESULT) {
      effects.push({ tick: entry.tick, port: entry.payload.port });
    } else if (entry.kind === 'admission_denied') {
      denials.push({ tick: entry.tick, tag: entry.payload.tag, reason: entry.payload.reason });
    } else if (entry.kind === 'receipt') {
      receipts.push(receiptOf(entry));
    }
  }

  return new Projection({ lastTick: lastTick ?? 0, effects, denials, receipts });
}

export class Text {
  render(journal: Log | Iterable<Entry>): string {
    const projection = project(journal);
    const lines = [
      `tick ${projection.lastTick} / effects ${projection.effects.length} / ` +
        `denied ${projection.denials.length} / receipt ${projection.receipts.length}`,
    ];
    for (const effect of projection.effects) lines.push(`  ${effect.tick} ${String(effect.port)}`);
    for (const denial of projection.denials) {
      lines.push(`  ${denial.tick} denied ${String(denial.tag)} — ${String(denial.reason)}`);
    }
    return lines.join('\n');
  }
}

export class Summary {
  render(journal: Log | Iterable<Entry>): ProjectionSummary {
    return project(journal).toJSON();
  }
}

/** Input owns no view state; it only delegates into Machine's intake. */
export class Input {
  readonly #machine: Machine;

  constructor(machine: Machine) {
    this.#machine = machine;
  }

  request(options: SubmissionOptions): Submission {
    return this.#machine.submit(options);
  }
}
