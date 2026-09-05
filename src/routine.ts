import type { JsonValue } from './receipt.js';
import type { Entry, Log } from './journal.js';
import { Definition } from './routine/definition.js';
import { Step } from './routine/step.js';

export const HOLE = '$gear_param' as const;

export type RoutineParameters = Readonly<Record<string, unknown>>;
export type TickSelection =
  | readonly number[]
  | ReadonlySet<number>
  | ((tick: number) => boolean);

export interface FromJournalOptions {
  readonly name: string;
  readonly ticks?: TickSelection;
  readonly tags?: readonly string[] | ReadonlySet<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isHole(value: unknown): value is { readonly [HOLE]: string } {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === HOLE && typeof value[HOLE] === 'string';
}

/** Recursively fill exact one-key parameter holes in arrays and plain objects. */
export function substitute(value: JsonValue, params: RoutineParameters): unknown {
  if (isHole(value)) {
    const name = value[HOLE];
    if (!Object.prototype.hasOwnProperty.call(params, name)) {
      throw new TypeError(`routine parameter was not supplied: ${name}`);
    }
    return params[name];
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, params));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, substitute(item as JsonValue, params)]),
    );
  }
  return value;
}

/** List parameter hole names recursively, preserving occurrence order and duplicates. */
export function holeNames(value: JsonValue): string[] {
  if (isHole(value)) return [value[HOLE]];
  if (Array.isArray(value)) return value.flatMap(holeNames);
  if (isRecord(value)) return Object.values(value).flatMap((item) => holeNames(item as JsonValue));
  return [];
}

function tickSelected(selection: TickSelection | undefined, tick: number): boolean {
  if (selection === undefined) return true;
  if (typeof selection === 'function') return selection(tick);
  if ('has' in selection) return selection.has(tick);
  return selection.includes(tick);
}

function tagSet(tags: FromJournalOptions['tags']): ReadonlySet<string> | undefined {
  return tags === undefined ? undefined : new Set(Array.from(tags, String));
}

/** Reconstruct steps from receipt entries in journal encounter order. */
export function fromJournal(journal: Log | Iterable<Entry>, options: FromJournalOptions): Definition {
  const tags = tagSet(options.tags);
  const steps: Step[] = [];
  for (const entry of journal) {
    if (entry.kind !== 'receipt' || !tickSelected(options.ticks, entry.tick)) continue;
    const step = Step.fromEffect(entry.tick, entry.payload.effect);
    if (tags !== undefined && !tags.has(step.tag)) continue;
    steps.push(step);
  }
  return new Definition({ name: options.name, steps });
}

/** Load a first-class routine from a parsed object or JSON string. */
export function load(source: string | unknown): Definition {
  const value = typeof source === 'string' ? JSON.parse(source) as unknown : source;
  return Definition.fromObject(value);
}

export { Definition } from './routine/definition.js';
export type {
  Bindings,
  DefinitionRecord,
  Locator,
  RoutineRunOptions,
  SliceOptions,
} from './routine/definition.js';
export { Step, StepRecordSchema } from './routine/step.js';
export type { StepRecord } from './routine/step.js';
