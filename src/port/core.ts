import { Darkcore } from '@minamorl/berylx';
import { z } from 'zod';
import { normalizeJson } from '../json.js';

export class PortError extends Error {}
export class InvalidPayload extends PortError {}
export class InvalidResult extends PortError {}
export class TagConflict extends PortError {}
export class DuplicateAdapter extends PortError {}
export class UnknownTag extends PortError {}
export class UnknownAdapter extends PortError {}
export { PortError as Error };

export { normalizeJson as normalize } from '../json.js';

export type PortResult = unknown | Promise<unknown>;
export type OperationRunner = (payload: unknown) => PortResult;

export class Operation<Input = unknown, Output = unknown> {
  readonly tag: string;
  readonly payloadSchema: z.ZodType<Input>;
  readonly resultSchema: z.ZodType<Output>;
  readonly run: (payload: Input) => Output | Promise<Output>;
  readonly asynchronous: boolean;

  constructor(
    tag: string,
    payloadSchema: z.ZodType<Input>,
    resultSchema: z.ZodType<Output>,
    run: (payload: Input) => Output | Promise<Output>,
    asynchronous = false,
  ) {
    this.tag = tag;
    this.payloadSchema = payloadSchema;
    this.resultSchema = resultSchema;
    this.run = run;
    this.asynchronous = asynchronous;
    Object.freeze(this);
  }
}

export type AnyOperation = Operation<unknown, unknown>;
export type OperationInterpreter = (operation: AnyOperation, payload: unknown) => PortResult;

function formatIssues(error: z.ZodError): string {
  return z.prettifyError(error);
}

function isPromiseLike(value: PortResult): value is Promise<unknown> {
  return value !== null &&
    typeof value === 'object' &&
    'then' in value &&
    typeof value.then === 'function';
}

export class Adapter {
  readonly name: string;
  readonly #operations = new Map<string, AnyOperation>();

  constructor(name: string) {
    this.name = name;
  }

  operation<Input, Output>(
    tag: string,
    payloadSchema: z.ZodType<Input>,
    resultSchema: z.ZodType<Output>,
    run: (payload: Input) => Output,
  ): Adapter {
    this.#operations.set(
      tag,
      new Operation(tag, payloadSchema, resultSchema, run) as AnyOperation,
    );
    return this;
  }

  asyncOperation<Input, Output>(
    tag: string,
    payloadSchema: z.ZodType<Input>,
    resultSchema: z.ZodType<Output>,
    run: (payload: Input) => Output | Promise<Output>,
  ): Adapter {
    this.#operations.set(
      tag,
      new Operation(tag, payloadSchema, resultSchema, run, true) as AnyOperation,
    );
    return this;
  }

  get tags(): readonly string[] {
    return [...this.#operations.keys()];
  }

  operationFor(tag: string): AnyOperation {
    const operation = this.#operations.get(tag);
    if (!operation) throw new UnknownTag(`${this.name} does not own tag ${tag}`);
    return operation;
  }

  effect(tag: string, payload: unknown): Darkcore.Effect<unknown> {
    const operation = this.operationFor(tag);
    const normalized = normalizeJson(payload);
    const checked = operation.payloadSchema.safeParse(normalized);
    if (!checked.success) {
      throw new InvalidPayload(
        `${this.name}#${tag} payload is invalid: ${formatIssues(checked.error)}`,
      );
    }
    return Darkcore.op(tag, normalized, (value) => value);
  }

  handlers(interpret: OperationInterpreter): Darkcore.AsyncHandlerMap {
    const handlers: Darkcore.AsyncHandlerMap = {};
    for (const operation of this.#operations.values()) {
      handlers[operation.tag] = (payload: unknown) => {
        const normalized = normalizeJson(payload);
        const checked = operation.payloadSchema.safeParse(normalized);
        if (!checked.success) {
          throw new InvalidPayload(
            `${this.name}#${operation.tag} payload is invalid: ${formatIssues(checked.error)}`,
          );
        }
        const raw = interpret(operation, checked.data);
        if (isPromiseLike(raw)) {
          return raw.then((value) => this.#validateResult(operation, value));
        }
        return this.#validateResult(operation, raw);
      };
    }
    return handlers;
  }

  realHandlers(): Darkcore.AsyncHandlerMap {
    return this.handlers((operation, payload) => operation.run(payload));
  }

  #validateResult(operation: AnyOperation, raw: unknown): unknown {
    const checked = operation.resultSchema.safeParse(normalizeJson(raw));
    if (!checked.success) {
      throw new InvalidResult(
        `${this.name}#${operation.tag} result is invalid: ${formatIssues(checked.error)}`,
      );
    }
    return normalizeJson(checked.data);
  }
}

export class Registry {
  readonly #byName = new Map<string, Adapter>();
  readonly #byTag = new Map<string, Adapter>();

  register(adapter: Adapter): Adapter {
    if (this.#byName.has(adapter.name)) {
      throw new DuplicateAdapter(`adapter ${adapter.name} is already registered`);
    }
    for (const tag of adapter.tags) {
      const owner = this.#byTag.get(tag);
      if (owner && owner.name !== adapter.name) {
        throw new TagConflict(`tag ${tag} is already owned by ${owner.name}`);
      }
    }
    this.#byName.set(adapter.name, adapter);
    for (const tag of adapter.tags) this.#byTag.set(tag, adapter);
    return adapter;
  }

  adapter(name: string): Adapter {
    const adapter = this.#byName.get(name);
    if (!adapter) throw new UnknownAdapter(`adapter ${name} is not registered`);
    return adapter;
  }

  forTag(tag: string): Adapter {
    const adapter = this.#byTag.get(tag);
    if (!adapter) throw new UnknownTag(`no adapter owns tag ${tag}`);
    return adapter;
  }

  get tags(): readonly string[] {
    return [...this.#byTag.keys()];
  }

  get names(): readonly string[] {
    return [...this.#byName.keys()];
  }

  effect(tag: string, payload: unknown): Darkcore.Effect<unknown> {
    return this.forTag(tag).effect(tag, payload);
  }

  realHandlers(): Darkcore.AsyncHandlerMap {
    const handlers: Darkcore.AsyncHandlerMap = {};
    for (const adapter of this.#byName.values()) Object.assign(handlers, adapter.realHandlers());
    return handlers;
  }
}

export const registry = new Registry();

export function register(adapter: Adapter): Adapter {
  return registry.register(adapter);
}

export function forTag(tag: string): Adapter {
  return registry.forTag(tag);
}

export function adapter(name: string): Adapter {
  return registry.adapter(name);
}

export function effect(tag: string, payload: unknown): Darkcore.Effect<unknown> {
  return registry.effect(tag, payload);
}

export function realHandlers(): Darkcore.AsyncHandlerMap {
  return registry.realHandlers();
}
