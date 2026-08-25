import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Task } from '@minamorl/berylx';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Journal,
  Kit,
  MACHINE_ACCEPTED,
  MACHINE_COMPLETED,
  Machine,
  MachineFileStore,
  PROGRAM_SUBMIT_TAG,
  PortAdapter,
  PortRegistry,
  ProgramRegistry,
  ReplayMismatch,
} from '../src/index.js';
import { Host } from '../src/host.js';

const Input = z.object({ n: z.number().int() }).describe('PersistentIn');
const Output = z.object({ n: z.number().int(), doubled: z.number().int() })
  .describe('PersistentOut');
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function stateDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'gear-state-'));
  directories.push(directory);
  return directory;
}

function ports(calls: number[]): PortRegistry {
  const registry = new PortRegistry();
  registry.register(new PortAdapter('probe').operation('probe', Input, Output, (payload) => {
    calls.push(payload.n);
    return { n: payload.n, doubled: payload.n * 2 };
  }));
  return registry;
}

function twiceTask(offset = 0): Task {
  return Task.of('twice', (lay, io) => {
    const n = lay.at('n').fetch() as number;
    const first = io.perform('probe', { n: n + offset }) as { doubled: number };
    const second = io.perform('probe', { n: first.doubled }) as { doubled: number };
    return lay.put('doubled', second.doubled);
  });
}

function programs(offset = 0): ProgramRegistry {
  return new ProgramRegistry().register({
    name: 'twice',
    task: twiceTask(offset),
    input: Input,
    output: Output,
  });
}

function kit(): Kit {
  return Kit.of({ ports: ['probe', PROGRAM_SUBMIT_TAG], programs: ['twice'], depth: 1 });
}

function machine(directory: string, calls: number[], offset = 0): Machine {
  return new Machine({ stateDir: directory, programs: programs(offset), ports: ports(calls) });
}

describe('persistent Machine state', () => {
  it('wires Host stateDir into its Machine', async () => {
    const directory = stateDir();
    const purePrograms = new ProgramRegistry().register({
      name: 'pure',
      task: Task.of('pure', (lay) => lay.put('doubled', (lay.at('n').fetch() as number) * 2)),
      input: Input,
      output: Output,
    });
    const io = Readable.from([`${JSON.stringify({ name: 'pure', focus: { n: 3 } })}\n`]);
    const host = new Host({ io, programs: purePrograms, stateDir: directory });

    await expect(host.run()).resolves.toEqual({ accepted: 1, completed: 1 });

    const rebuilt = new Machine({ programs: purePrograms, stateDir: directory });
    expect(rebuilt.stateOf(1)).toBe(MACHINE_COMPLETED);
    expect(rebuilt.submit({ name: 'pure', focus: { n: 4 } }).ticket).toBe(2);
  });

  it('restores an accepted queue and continues the ledger ticket space', async () => {
    const directory = stateDir();
    const first = machine(directory, []);
    const accepted = first.submit({ name: 'twice', focus: { n: 2 }, kit: kit() });

    const calls: number[] = [];
    const rebuilt = machine(directory, calls);
    expect(rebuilt.pending).toBe(1);
    expect(rebuilt.stateOf(accepted.ticket)).toBe(MACHINE_ACCEPTED);

    const completion = await rebuilt.step();
    expect(completion?.produced).toEqual({ n: 2, doubled: 8 });
    expect(calls).toEqual([2, 4]);
    expect(rebuilt.stateOf(accepted.ticket)).toBe(MACHINE_COMPLETED);
    expect(rebuilt.submit({ name: 'twice', focus: { n: 3 }, kit: kit() }).ticket).toBe(2);
  });

  it('restores the ticket journal and resumes without repeating recorded effects', async () => {
    const directory = stateDir();
    const firstCalls: number[] = [];
    const first = machine(directory, firstCalls);
    const ticket = first.submit({ name: 'twice', focus: { n: 2 }, kit: kit() }).ticket;
    expect((await first.step({ maxEffects: 2 }))?.suspended).toBe(true);
    expect(firstCalls).toEqual([2]);

    const store = new MachineFileStore(directory);
    const persistedBefore = readFileSync(store.journalPath(ticket), 'utf8');
    expect(persistedBefore.split('\n').filter(Boolean).map((line) => JSON.parse(line).kind))
      .toEqual([Journal.PORT_RESULT, 'receipt']);

    const resumedCalls: number[] = [];
    const rebuilt = machine(directory, resumedCalls);
    const resumed = await rebuilt.resume(ticket);

    expect(resumedCalls).toEqual([4]);
    expect(resumed.produced).toEqual({ n: 2, doubled: 8 });
    expect(rebuilt.stateOf(ticket)).toBe(MACHINE_COMPLETED);
    expect(Journal.dump(rebuilt.journalFor(ticket)!)).toBe(Journal.dump(resumed.outcome.journal));
    const persistedAfter = readFileSync(store.journalPath(ticket), 'utf8');
    expect(Journal.load(persistedAfter).toArray()).toEqual(resumed.outcome.journal.toArray());
    expect(persistedAfter.startsWith(persistedBefore)).toBe(true);
  });

  it('raises ReplayMismatch when rebuilt code requests a different payload', async () => {
    const directory = stateDir();
    const first = machine(directory, []);
    const ticket = first.submit({ name: 'twice', focus: { n: 2 }, kit: kit() }).ticket;
    await first.step({ maxEffects: 2 });

    const rebuilt = machine(directory, [], 1);
    await expect(rebuilt.resume(ticket)).rejects.toBeInstanceOf(ReplayMismatch);
  });

  it('fails fast on a torn ledger line and leaves the file untouched', () => {
    const directory = stateDir();
    const first = machine(directory, []);
    first.submit({ name: 'twice', focus: { n: 2 }, kit: kit() });
    const store = new MachineFileStore(directory);
    appendFileSync(store.ledgerPath, '{"ticket":');
    const corrupted = readFileSync(store.ledgerPath, 'utf8');

    expect(() => machine(directory, [])).toThrow(/machine ledger line 2/u);
    expect(readFileSync(store.ledgerPath, 'utf8')).toBe(corrupted);
  });

  it('fails fast on a torn journal line and leaves the file untouched', async () => {
    const directory = stateDir();
    const first = machine(directory, []);
    const ticket = first.submit({ name: 'twice', focus: { n: 2 }, kit: kit() }).ticket;
    await first.step({ maxEffects: 2 });
    const store = new MachineFileStore(directory);
    const path = store.journalPath(ticket);
    appendFileSync(path, '{"tick":');
    const corrupted = readFileSync(path, 'utf8');

    expect(() => machine(directory, [])).toThrow(/journal line 3/u);
    expect(readFileSync(path, 'utf8')).toBe(corrupted);
  });
});
