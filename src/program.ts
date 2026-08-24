import type { BerylxNode } from '@minamorl/berylx';
import type { z } from 'zod';
import { normalizeJson } from './json.js';
import { PROGRAM_SUBMIT_TAG } from './tags.js';

export { PROGRAM_SUBMIT_TAG };

export class ChildFailed extends Error {}
export class BoundaryError extends Error {}
export class TooDeep extends Error {}

export interface Registration<Input = unknown, Output = unknown> {
  readonly name: string;
  readonly task: BerylxNode;
  readonly input: z.ZodType<Input>;
  readonly output: z.ZodType<Output>;
}

function schemaLabel(schema: z.ZodType): string {
  const description = schema.description;
  if (!description) {
    throw new TypeError('program boundary schema requires .describe(label)');
  }
  return description;
}

export class Declaration<Input = unknown, Output = unknown> {
  readonly name: string;
  readonly task: BerylxNode;
  readonly input: z.ZodType<Input>;
  readonly output: z.ZodType<Output>;

  constructor(registration: Registration<Input, Output>) {
    this.name = String(registration.name);
    this.task = registration.task;
    this.input = registration.input;
    this.output = registration.output;
    schemaLabel(this.input);
    schemaLabel(this.output);
    Object.freeze(this);
  }

  accepts(data: unknown): boolean {
    return this.input.safeParse(normalizeJson(data)).success;
  }

  produces(data: unknown): boolean {
    return this.output.safeParse(normalizeJson(data)).success;
  }

  get inputLabel(): string {
    return schemaLabel(this.input);
  }

  get outputLabel(): string {
    return schemaLabel(this.output);
  }
}

export class Registry {
  readonly #byName = new Map<string, Declaration>();

  register<Input, Output>(registration: Registration<Input, Output>): this {
    if (
      registration === null ||
      registration.name === undefined ||
      registration.task === undefined ||
      registration.input === undefined ||
      registration.output === undefined
    ) {
      throw new TypeError('program には name / task / input / output が要る');
    }
    const name = String(registration.name);
    if (name.length === 0) throw new TypeError('program name must not be empty');
    if (this.#byName.has(name)) throw new Error(`program ${name} は既に登録されている`);
    this.#byName.set(name, new Declaration(registration) as Declaration);
    return this;
  }

  fetch(name: string): Declaration {
    const key = String(name);
    const declaration = this.#byName.get(key);
    if (!declaration) {
      throw new Error(`program ${key} は登録されていない (素の Task は実行機に乗らない)`);
    }
    return declaration;
  }

  registered(name: string): boolean {
    return this.#byName.has(String(name));
  }

  get names(): readonly string[] {
    return [...this.#byName.keys()].sort();
  }

  [Symbol.iterator](): Iterator<Declaration> {
    return this.#byName.values();
  }

  candidatesFor(name: string): readonly string[] {
    const key = String(name);
    const produced = this.fetch(key).outputLabel;
    return [...this.#byName.values()]
      .filter((declaration) => declaration.name !== key && declaration.inputLabel === produced)
      .map((declaration) => declaration.name)
      .sort();
  }
}
