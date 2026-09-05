import { AsyncTask, Task, type BerylxNode } from '@minamorl/berylx';
import { z } from 'zod';
import { run as execute, type Outcome, type RunOptions } from '../executor.js';
import {
  HOLE,
  holeNames,
  substitute,
  type RoutineParameters,
  type TickSelection,
} from '../routine.js';
import { Step, StepRecordSchema, type StepRecord } from './step.js';

const DefinitionRecordSchema = z.object({
  name: z.string(),
  steps: z.array(StepRecordSchema).default([]),
});

export interface DefinitionRecord {
  readonly name: string;
  readonly steps: readonly StepRecord[];
}

export type Locator =
  | string
  | {
      readonly key: string;
      readonly step?: number;
      readonly tag?: string;
    };

export type Bindings = Readonly<Record<string, Locator>>;

export interface SliceOptions {
  readonly ticks?: TickSelection;
  readonly tags?: readonly string[] | ReadonlySet<string>;
}

export type RoutineRunOptions = RunOptions & {
  readonly params?: RoutineParameters;
};

function tickSelected(selection: TickSelection | undefined, tick: number): boolean {
  if (selection === undefined) return true;
  if (typeof selection === 'function') return selection(tick);
  if ('has' in selection) return selection.has(tick);
  return selection.includes(tick);
}

function tagSet(tags: SliceOptions['tags']): ReadonlySet<string> | undefined {
  return tags === undefined ? undefined : new Set(Array.from(tags, String));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A named, serializable sequence of effects reconstructed from receipts. */
export class Definition {
  readonly name: string;
  readonly steps: readonly Step[];

  constructor(input: { readonly name: string; readonly steps?: Iterable<Step> }) {
    this.name = String(input.name);
    this.steps = Object.freeze(Array.from(input.steps ?? []));
    Object.freeze(this);
  }

  static fromObject(value: unknown): Definition {
    const parsed = DefinitionRecordSchema.parse(value);
    return new Definition({ name: parsed.name, steps: parsed.steps.map(Step.fromObject) });
  }

  /** Build berylx tasks; effectful steps are async so every port result is joined. */
  toTask(params: RoutineParameters = {}): BerylxNode {
    const missing = this.params.filter((name) => !Object.prototype.hasOwnProperty.call(params, name));
    if (missing.length > 0) {
      throw new TypeError(`routine ${this.name} is missing parameters: ${missing.join(', ')}`);
    }

    const tasks = this.steps.map((step, index) => this.#stepTask(step, index, params));
    if (tasks.length === 0) {
      return Task.of(`${this.name}_empty`, (lay) => lay);
    }
    return tasks.slice(1).reduce<BerylxNode>((sequence, task) => sequence.then(task), tasks[0]!);
  }

  run(options: RoutineRunOptions): Promise<Outcome> {
    const { params = {}, ...runOptions } = options;
    return execute(this.toTask(params), runOptions);
  }

  /** Replace selected top-level payload fields with exact one-key parameter holes. */
  parameterize(bindings: Bindings): Definition {
    const steps = this.steps.map((step, index) => {
      let payload: unknown = step.payload;
      for (const [name, locator] of Object.entries(bindings)) {
        payload = this.#applyHole(payload, name, locator, index, step.tag);
      }
      return step.with({ payload: z.json().parse(payload) });
    });
    return new Definition({ name: this.name, steps });
  }

  slice(options: SliceOptions = {}): Definition {
    const tags = tagSet(options.tags);
    const steps = this.steps.filter(
      (step) => tickSelected(options.ticks, step.tick) && (tags === undefined || tags.has(step.tag)),
    );
    return new Definition({ name: this.name, steps });
  }

  get params(): readonly string[] {
    return [...new Set(this.steps.flatMap((step) => holeNames(step.payload)))].sort();
  }

  get parameterized(): boolean {
    return this.params.length > 0;
  }

  toJSON(): DefinitionRecord {
    return { name: this.name, steps: this.steps.map((step) => step.toJSON()) };
  }

  dump(): string {
    return JSON.stringify(this);
  }

  #stepTask(step: Step, index: number, params: RoutineParameters): AsyncTask {
    const payload = substitute(step.payload, params);
    return AsyncTask.of(`${this.name}_${index}`, async (lay, io) => {
      const result = await io.perform(step.tag, payload);
      return lay.put(`${this.name}_${index}`, result);
    });
  }

  #applyHole(
    payload: unknown,
    name: string,
    locator: Locator,
    index: number,
    tag: string,
  ): unknown {
    const selected = typeof locator === 'string' ? { key: locator } : locator;
    if (selected.step !== undefined && selected.step !== index) return payload;
    if (selected.tag !== undefined && String(selected.tag) !== tag) return payload;
    if (!isRecord(payload) || !Object.prototype.hasOwnProperty.call(payload, selected.key)) {
      return payload;
    }
    return { ...payload, [selected.key]: { [HOLE]: name } };
  }
}
