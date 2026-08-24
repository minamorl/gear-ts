import { Task } from '@minamorl/berylx';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ProgramRegistry } from '../src/index.js';

const RawInput = z.object({ url: z.string() }).describe('RawInput');
const Document = z.object({ body: z.string() }).describe('Document');
const WordCount = z.object({ count: z.number().int() }).describe('WordCount');

const task = (name: string) => Task.of(name, (focus) => focus);

function registry(): ProgramRegistry {
  return new ProgramRegistry()
    .register({ name: 'fetch', task: task('fetch'), input: RawInput, output: Document })
    .register({ name: 'count', task: task('count'), input: Document, output: WordCount })
    .register({ name: 'index', task: task('index'), input: Document, output: WordCount });
}

describe('Program', () => {
  it('registers and fetches a declaration', () => {
    const declaration = registry().fetch('fetch');
    expect(declaration.name).toBe('fetch');
    expect(declaration.inputLabel).toBe('RawInput');
    expect(declaration.outputLabel).toBe('Document');
    expect(registry().names).toEqual(['count', 'fetch', 'index']);
  });

  it('refuses registration without every declaration field', () => {
    const programs = new ProgramRegistry();
    expect(() =>
      programs.register({
        name: 'bare',
        task: task('bare'),
        input: null,
        output: Document,
      } as never),
    ).toThrow(TypeError);
    expect(() =>
      programs.register({
        name: 'bare',
        task: task('bare'),
        input: RawInput,
        output: null,
      } as never),
    ).toThrow(TypeError);
    expect(programs.names).toEqual([]);
  });

  it('refuses duplicate registration', () => {
    const programs = registry();
    expect(() =>
      programs.register({ name: 'fetch', task: task('fetch'), input: RawInput, output: Document }),
    ).toThrow(/既に登録/u);
  });

  it('does not fetch an unregistered bare task', () => {
    expect(() => registry().fetch('nope')).toThrow(/素の Task は実行機に乗らない/u);
  });

  it('checks boundaries before execution', () => {
    const declaration = registry().fetch('count');
    expect(declaration.accepts({ body: 'hello' })).toBe(true);
    expect(declaration.accepts({ url: 'http://example.com' })).toBe(false);
    expect(declaration.produces({ count: 1 })).toBe(true);
    expect(declaration.produces({ count: 'many' })).toBe(false);
  });

  it('finds candidates by the declared boundary label', () => {
    expect(registry().candidatesFor('fetch')).toEqual(['count', 'index']);
    expect(registry().candidatesFor('count')).toEqual([]);
  });
});
