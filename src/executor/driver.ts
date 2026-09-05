import {
  AsyncTask,
  ControlSignal,
  Darkcore,
  EffectTree,
  Perform,
  Task,
  type BerylxNode,
  type Focus,
  type Result,
} from '@minamorl/berylx';
import { Request } from '../admission/request.js';
import type { Policy } from '../admission/policy.js';
import type { Denied, VerdictValue } from '../admission/verdict.js';
import { Clock, CLOCK_RANDOM_TAG, ClockRandomPayload } from '../clock/index.js';
import type { Tick } from '../clock/tick.js';
import type { Kit } from '../kit.js';
import type { EntrySink, Log } from '../journal.js';
import { normalizeJson } from '../json.js';
import type { Registry } from '../port/core.js';
import { PROGRAM_SUBMIT_TAG } from '../tags.js';
import { TooDeep, type Registry as ProgramRegistry } from '../program.js';
import { AdmissionDenied, Outcome, Suspend, focusWithKit } from '../executor.js';
import { Authority } from './authority.js';
import { Recorder } from './recorder.js';
import { Replay } from './replay.js';
import { Submission } from './submission.js';

type Obtained = readonly [value: unknown, recorded: unknown, external: boolean];

function promiseLike<T>(value: unknown): value is Promise<T> {
  return value !== null && typeof value === 'object' && typeof (value as Promise<T>).then === 'function';
}

function errorRethrow(error: unknown): never {
  throw error;
}

/** Runs one journal-backed clock and keeps all mutable bookkeeping inside this instance. */
export class Driver {
  static readonly MAX_SUBMIT_DEPTH = 32;

  readonly #clock: Clock;
  readonly #kit: Kit | null;
  readonly #authority: Authority;
  readonly #submission: Submission;
  readonly #registry: Registry;
  readonly #real: Darkcore.AsyncHandlerMap;
  readonly #replay: Replay;
  readonly #maxEffects: number | null;
  readonly #recorder: Recorder;
  #processed = 0;

  constructor(options: {
    readonly clock: Clock;
    readonly policy: Policy;
    readonly registry: Registry;
    readonly replaySource: Log;
    readonly maxEffects: number | null;
    readonly kit: Kit | null;
    readonly programs: ProgramRegistry;
    readonly journalSink?: EntrySink;
  }) {
    this.#clock = options.clock;
    this.#kit = options.kit;
    this.#authority = new Authority(options.policy);
    this.#submission = new Submission(options.programs);
    this.#registry = options.registry;
    this.#real = options.registry.realHandlers();
    this.#replay = new Replay(options.replaySource, options.registry);
    this.#maxEffects = options.maxEffects;
    this.#recorder = new Recorder(options.journalSink);
  }

  async run(program: BerylxNode, focus: unknown): Promise<Outcome> {
    try {
      const result = await this.#fold(program, focus, this.#kit, 0);
      return this.#outcome(result, false);
    } catch (error) {
      if (error instanceof Suspend) return this.#outcome(null, true);
      throw error;
    }
  }

  #handlersFor(kit: Kit | null, depth: number): Darkcore.AsyncHandlerMap {
    const effects: Darkcore.AsyncHandlerMap = {};
    for (const tag of [...this.#registry.tags, CLOCK_RANDOM_TAG, PROGRAM_SUBMIT_TAG]) {
      effects[tag] = (payload) => this.#gate(tag, payload, kit, depth);
    }
    const syncEffects = this.#syncEffectsFor(kit, depth);
    const handlers = EffectTree.asyncRealHandlers(effects);
    handlers[EffectTree.TASK] = (payload) => {
      const [task, focus] = payload as [Task | AsyncTask, Focus];
      if (task instanceof AsyncTask) {
        return task.callAsync(focus, task.effectful() ? new Perform(handlers) : undefined);
      }
      return task.call(focus, task.effectful() ? new Perform(syncEffects) : undefined);
    };
    return handlers;
  }

  #syncEffectsFor(kit: Kit | null, depth: number): Darkcore.HandlerMap {
    const effects: Darkcore.HandlerMap = {};
    for (const tag of [...this.#registry.tags, CLOCK_RANDOM_TAG, PROGRAM_SUBMIT_TAG]) {
      effects[tag] = (payload) => {
        if (this.#asynchronous(tag, payload)) {
          throw new Error(
            `synchronous Task cannot start asynchronous effect ${tag}; use AsyncTask and await io.perform`,
          );
        }
        const value = this.#gate(tag, payload, kit, depth);
        if (promiseLike(value)) {
          throw new Error(
            `operation ${tag} returned a Promise despite synchronous registration`,
          );
        }
        return value;
      };
    }
    return effects;
  }

  #syncHandlersFor(kit: Kit | null, depth: number): Darkcore.HandlerMap {
    return EffectTree.realHandlers(this.#syncEffectsFor(kit, depth));
  }

  #asynchronous(tag: string, payload: unknown): boolean {
    if (tag === PROGRAM_SUBMIT_TAG) return this.#submission.containsAsyncTask(payload);
    if (tag === CLOCK_RANDOM_TAG) return false;
    return this.#registry.forTag(tag).operationFor(tag).asynchronous;
  }

  #gate(tag: string, rawPayload: unknown, kit: Kit | null, depth: number): unknown | Promise<unknown> {
    const payload = normalizeJson(rawPayload);
    const [tick, verdict] = this.#admit(tag, payload, kit);
    if (verdict.denied) return this.#deny(tick, tag, payload, verdict);

    try {
      const obtained = this.#obtain(tick, tag, payload, kit, depth);
      if (promiseLike<Obtained>(obtained)) {
        return obtained.then((settled) => this.#commit(tick, tag, payload, verdict, settled)).catch(
          (error: unknown) => this.#fail(tick, tag, payload, verdict, error),
        );
      }
      return this.#commit(tick, tag, payload, verdict, obtained);
    } catch (error) {
      return this.#fail(tick, tag, payload, verdict, error);
    }
  }

  /** This synchronous section is the bookkeeping lock in the single-threaded JS runtime. */
  #admit(tag: string, payload: unknown, kit: Kit | null): readonly [Tick, VerdictValue] {
    if (this.#maxEffects !== null && this.#processed >= this.#maxEffects) throw new Suspend();
    const tick = this.#clock.advance();
    const verdict = this.#authority.judge(new Request(tag, normalizeJson(payload)), kit);
    if (!verdict.denied) this.#processed += 1;
    return [tick, verdict] as const;
  }

  #obtain(
    tick: Tick,
    tag: string,
    payload: unknown,
    kit: Kit | null,
    depth: number,
  ): Obtained | Promise<Obtained> {
    if (tag === CLOCK_RANDOM_TAG) return this.#obtainRandom(tick, payload);
    if (tag === PROGRAM_SUBMIT_TAG) return this.#obtainSubmit(payload, kit, depth);
    if (!this.#replay.exhausted) {
      const [value, recorded] = this.#replay.readBack(tag, payload);
      return [value, recorded, true] as const;
    }
    return this.#callExternal(tag, payload);
  }

  #callExternal(tag: string, payload: unknown): Obtained | Promise<Obtained> {
    // Execution begins only after admission and runs outside every bookkeeping section.
    const value = this.#real[tag]?.(payload);
    if (!(tag in this.#real)) throw new Error(`no real handler for effect: ${tag}`);
    if (promiseLike(value)) {
      return value.then((settled) => [settled, normalizeJson(settled), true] as const);
    }
    return [value, normalizeJson(value), true] as const;
  }

  #obtainSubmit(payload: unknown, kit: Kit | null, depth: number): Obtained | Promise<Obtained> {
    if (depth >= Driver.MAX_SUBMIT_DEPTH) {
      throw new TooDeep(`submit nesting exceeded the limit of ${Driver.MAX_SUBMIT_DEPTH}`);
    }
    const childKit = kit?.descend() ?? null;
    const produced = this.#submission.run(payload, (task, focus) =>
      this.#foldChild(task, childKit === null ? focus : focusWithKit(focus, childKit), childKit, depth + 1),
    );
    if (promiseLike(produced)) {
      return produced.then((value) => [value, normalizeJson(value), false] as const);
    }
    return [produced, normalizeJson(produced), false] as const;
  }

  #obtainRandom(tick: Tick, payload: unknown): Obtained {
    const checked = ClockRandomPayload.safeParse(payload);
    if (!checked.success) throw new Error(`invalid clock_random payload: ${checked.error.message}`);
    if (checked.data.bound <= 0) throw new Error('clock_random bound must be a positive integer');
    const recorded = { value: this.#clock.rngFor(tick).nextInt(checked.data.bound) };
    return [recorded, recorded, false] as const;
  }

  #fold(program: BerylxNode, focus: unknown, kit: Kit | null, depth: number): Promise<Result> {
    return EffectTree.runAsync(program, focus, this.#handlersFor(kit, depth));
  }

  #foldChild(
    program: BerylxNode,
    focus: unknown,
    kit: Kit | null,
    depth: number,
  ): Result | Promise<Result> {
    const asynchronous = program.nodes().some((node) => node instanceof AsyncTask);
    if (asynchronous) return this.#fold(program, focus, kit, depth);
    return EffectTree.run(program, focus, this.#syncHandlersFor(kit, depth));
  }

  #commit(
    tick: Tick,
    tag: string,
    payload: unknown,
    verdict: VerdictValue,
    obtained: Obtained,
  ): unknown {
    const [value, recorded, external] = obtained;
    this.#recorder.effect({
      tick: tick.index,
      tag,
      payload,
      recorded,
      verdict,
      external,
    });
    return value;
  }

  #fail(
    tick: Tick,
    tag: string,
    payload: unknown,
    verdict: VerdictValue,
    error: unknown,
  ): never {
    if (error instanceof ControlSignal) return errorRethrow(error);
    this.#recorder.failure({ tick: tick.index, tag, payload, verdict, error });
    throw error;
  }

  #deny(
    tick: Tick,
    tag: string,
    payload: unknown,
    verdict: Denied,
  ): never {
    this.#recorder.denial({ tick: tick.index, tag, payload, verdict });
    throw new AdmissionDenied(verdict);
  }

  #outcome(result: Result | null, suspended: boolean): Outcome {
    return new Outcome({
      result,
      journal: this.#recorder.journal,
      receipts: this.#recorder.receipts,
      suspended,
      lastTick: this.#clock.current().index,
    });
  }
}
