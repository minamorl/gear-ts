import { AsyncTask, Err, type BerylxNode, type Result } from '@minamorl/berylx';
import { normalizeJson } from '../json.js';
import { Kit } from '../kit.js';
import { BoundaryError, ChildFailed, type Registry } from '../program.js';

type Fold = (task: BerylxNode, focus: unknown) => Result | Promise<Result>;

function promiseLike(value: unknown): value is Promise<Result> {
  return value !== null && typeof value === 'object' && typeof (value as Promise<Result>).then === 'function';
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BoundaryError('program_submit payload must be a plain object');
  }
  return value as Record<string, unknown>;
}

/** Resolves only declared programs and checks both declared Zod boundaries. */
export class Submission {
  readonly #programs: Registry;

  constructor(programs: Registry) {
    this.#programs = programs;
  }

  run(payload: unknown, fold: Fold): unknown | Promise<unknown> {
    const request = plainRecord(payload);
    const name = String(request.name);
    const focus = normalizeJson(request.focus ?? {});
    const declaration = this.#programs.fetch(name);
    if (!declaration.accepts(focus)) {
      throw new BoundaryError(
        `input to program ${name} does not satisfy its declaration ${declaration.inputLabel}`,
      );
    }

    const result = fold(declaration.task, focus);
    if (promiseLike(result)) {
      return result.then((settled) => this.#finish(name, declaration.outputLabel, declaration.produces.bind(declaration), settled));
    }
    return this.#finish(name, declaration.outputLabel, declaration.produces.bind(declaration), result);
  }

  #finish(
    name: string,
    outputLabel: string,
    produces: (value: unknown) => boolean,
    result: Result,
  ): unknown {
    if (result instanceof Err) {
      throw new ChildFailed(`child program closed with Err: ${result.message}`);
    }
    const raw = plainRecord(result.focus.toObject());
    const { [Kit.FOCUS_KEY]: _kit, ...withoutKit } = raw;
    const produced = plainRecord(normalizeJson(withoutKit));
    if (!produces(produced)) {
      throw new BoundaryError(`output of program ${name} does not satisfy its declaration ${outputLabel}`);
    }
    return produced;
  }

  containsAsyncTask(payload: unknown): boolean {
    try {
      const request = plainRecord(normalizeJson(payload));
      const name = String(request.name);
      if (!this.#programs.registered(name)) return false;
      return this.#programs.fetch(name).task.nodes().some((node) => node instanceof AsyncTask);
    } catch {
      return false;
    }
  }
}
