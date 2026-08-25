import { ControlSignal, Focus, type BerylxNode, type Result } from '@minamorl/berylx';
import type { Policy } from './admission/policy.js';
import type { Denied } from './admission/verdict.js';
import { Clock, type RunSeed } from './clock/index.js';
import { Log, type EntrySink } from './journal.js';
import { Kit } from './kit.js';
import { Registry as ProgramRegistry } from './program.js';
import { registry as defaultRegistry, type Registry as PortRegistry } from './port/core.js';
import type { Receipt } from './receipt.js';
import { Driver } from './executor/driver.js';

export { Driver } from './executor/driver.js';
export { Authority } from './executor/authority.js';
export { Recorder } from './executor/recorder.js';
export { Replay } from './executor/replay.js';
export { Submission } from './executor/submission.js';
export { ReplayMismatch, ReplayUnreadable } from './journal.js';

export class Outcome {
  readonly result: Result | null;
  readonly journal: Log;
  readonly receipts: readonly Receipt[];
  readonly suspended: boolean;
  readonly lastTick: number;

  constructor(input: {
    readonly result: Result | null;
    readonly journal: Log;
    readonly receipts: readonly Receipt[];
    readonly suspended: boolean;
    readonly lastTick: number;
  }) {
    this.result = input.result;
    this.journal = input.journal;
    this.receipts = Object.freeze([...input.receipts]);
    this.suspended = input.suspended;
    this.lastTick = input.lastTick;
    Object.freeze(this);
  }

  get done(): boolean {
    return !this.suspended;
  }
}

/** A replayable suspension, never translated into a Berylx Err. */
export class Suspend extends ControlSignal {}

/** Admission refusal is an ordinary Error so Task/AsyncTask turns it into Err. */
export class AdmissionDenied extends Error {
  readonly verdict: Denied;

  constructor(verdict: Denied) {
    super(`admission denied: ${verdict.reason}`);
    this.name = 'AdmissionDenied';
    this.verdict = verdict;
  }
}

export interface RunOptions {
  readonly policy: Policy;
  readonly seed: RunSeed;
  readonly focus?: unknown;
  readonly registry?: PortRegistry;
  readonly journal?: Log;
  readonly maxEffects?: number | null;
  readonly kit?: Kit | null;
  readonly programs?: ProgramRegistry;
  readonly journalSink?: EntrySink;
}

export async function run(program: BerylxNode, options: RunOptions): Promise<Outcome> {
  const kit = options.kit ?? null;
  const focus = focusWithKit(options.focus ?? {}, kit);
  return new Driver({
    clock: new Clock(options.seed),
    policy: options.policy,
    registry: options.registry ?? defaultRegistry,
    replaySource: options.journal ?? new Log(),
    maxEffects: options.maxEffects ?? null,
    kit,
    programs: options.programs ?? new ProgramRegistry(),
    journalSink: options.journalSink,
  }).run(program, focus);
}

/** Put only the JSON declaration, never the live Kit object, into program state. */
export function focusWithKit(focus: unknown, kit: Kit | null): unknown {
  if (kit === null) return focus;
  if (focus instanceof Focus) return focus.put(Kit.FOCUS_KEY, kit.toJSON());
  if (focus === null || typeof focus !== 'object' || Array.isArray(focus)) {
    throw new TypeError('Kit を渡す focus は plain object または Focus にする');
  }
  return { ...(focus as Record<string, unknown>), [Kit.FOCUS_KEY]: kit.toJSON() };
}
