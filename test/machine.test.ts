import { Err, Task } from '@minamorl/berylx';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Kit,
  MACHINE_ACCEPTED,
  MACHINE_COMPLETED,
  MACHINE_DENIED,
  MACHINE_SUSPENDED,
  Machine,
  MachineIntake,
  MachineLedger,
  PROGRAM_SUBMIT_TAG,
  PortAdapter,
  PortRegistry,
  ProgramRegistry,
} from '../src/index.js';

const Input = z.object({ n: z.number().int() }).describe('MachineIn');
const Output = z.object({ n: z.number().int(), doubled: z.number().int() }).describe('MachineOut');

function ports(calls: number[]): PortRegistry {
  const registry = new PortRegistry();
  registry.register(new PortAdapter('probe').operation('probe', Input, Output, (payload) => {
    calls.push(payload.n);
    return { n: payload.n, doubled: payload.n * 2 };
  }));
  return registry;
}

function doubleTask(): Task {
  return Task.of('double', (lay, io) => {
    const n = lay.at('n').fetch() as number;
    const output = io.perform('probe', { n }) as { doubled: number };
    return lay.put('doubled', output.doubled);
  });
}

function twiceTask(): Task {
  return Task.of('twice', (lay, io) => {
    const n = lay.at('n').fetch() as number;
    const first = io.perform('probe', { n }) as { doubled: number };
    const second = io.perform('probe', { n: first.doubled }) as { doubled: number };
    return lay.put('doubled', second.doubled);
  });
}

function programs(name = 'double', task = doubleTask()): ProgramRegistry {
  return new ProgramRegistry().register({ name, task, input: Input, output: Output });
}

function kit(options: { readonly depth?: number; readonly allowed?: readonly string[] } = {}): Kit {
  return Kit.of({
    ports: ['probe', PROGRAM_SUBMIT_TAG],
    programs: options.allowed ?? ['double'],
    depth: options.depth ?? 1,
  });
}

function machine(calls: number[] = []): Machine {
  return new Machine({ programs: programs(), ports: ports(calls) });
}

function twiceMachine(
  calls: number[],
  ledger = new MachineLedger(),
  intake = new MachineIntake(),
): Machine {
  return new Machine({ programs: programs('twice', twiceTask()), ports: ports(calls), ledger, intake });
}

function twiceKit(): Kit {
  return Kit.of({ ports: ['probe', PROGRAM_SUBMIT_TAG], programs: ['twice'], depth: 1 });
}

describe('Machine', () => {
  it('accepts without running anything', () => {
    const calls: number[] = [];
    const runtime = machine(calls);
    const ticket = runtime.submit({ name: 'double', focus: { n: 2 }, kit: kit() }).ticket;

    expect(calls).toEqual([]);
    expect(runtime.pending).toBe(1);
    expect(runtime.stateOf(ticket)).toBe(MACHINE_ACCEPTED);
    expect(runtime.journalFor(ticket)).toBeUndefined();
  });

  it('picks one FIFO item up and runs it', async () => {
    const calls: number[] = [];
    const runtime = machine(calls);
    const ticket = runtime.submit({ name: 'double', focus: { n: 2 }, kit: kit() }).ticket;
    const completion = await runtime.step();

    expect(calls).toEqual([2]);
    expect(completion?.ticket).toBe(ticket);
    expect(completion?.produced).toEqual({ n: 2, doubled: 4 });
    expect(runtime.stateOf(ticket)).toBe(MACHINE_COMPLETED);
    expect(runtime.pending).toBe(0);
  });

  it('returns undefined when stepping an empty intake', async () => {
    await expect(machine().step()).resolves.toBeUndefined();
  });

  it('makes pickup itself a receipted program_submit effect', async () => {
    const runtime = machine();
    const ticket = runtime.submit({ name: 'double', focus: { n: 2 }, kit: kit() }).ticket;
    const completion = await runtime.step();
    const tags = completion?.outcome.receipts.map((receipt) => receipt.effect.tag);

    expect(tags).toContain(PROGRAM_SUBMIT_TAG);
    expect(tags).toContain('probe');
    expect(runtime.journalFor(ticket)).toBe(completion?.outcome.journal);
  });

  it('gives each pickup its own journal and seed', async () => {
    const runtime = machine();
    const first = runtime.submit({ name: 'double', focus: { n: 2 }, kit: kit() });
    const second = runtime.submit({ name: 'double', focus: { n: 3 }, kit: kit() });
    await runtime.drain();

    expect(runtime.journalFor(first.ticket)).not.toBe(runtime.journalFor(second.ticket));
    expect(runtime.journalFor(first.ticket)?.portResults()).toHaveLength(1);
    expect(runtime.journalFor(second.ticket)?.portResults()).toHaveLength(1);
    expect(first.seed).not.toBe(second.seed);
  });

  it('drains every item and respects a completion limit', async () => {
    const calls: number[] = [];
    const runtime = machine(calls);
    for (let value = 1; value <= 3; value += 1) {
      runtime.submit({ name: 'double', focus: { n: value }, kit: kit() });
    }

    expect(await runtime.drain({ limit: 2 })).toHaveLength(2);
    expect(runtime.pending).toBe(1);
    expect(calls).toEqual([1, 2]);
    await runtime.drain();
    expect(runtime.pending).toBe(0);
    expect(calls).toEqual([1, 2, 3]);
  });

  it('refuses a program not handed down when pickup crosses admission', async () => {
    const calls: number[] = [];
    const runtime = machine(calls);
    const ticket = runtime.submit({
      name: 'double', focus: { n: 2 }, kit: kit({ allowed: ['other'] }),
    }).ticket;
    const completion = await runtime.step();

    expect(calls).toEqual([]);
    expect(completion?.denied).toBe(true);
    expect(runtime.stateOf(ticket)).toBe(MACHINE_DENIED);
    expect(runtime.ledger.forTicket(ticket).at(-1)?.payload.reason)
      .toMatch(/program double was not handed down/u);
  });

  it('closes an unregistered program as completed with an Err', async () => {
    const runtime = machine();
    const ticket = runtime.submit({
      name: 'ghost', focus: { n: 2 }, kit: kit({ allowed: ['ghost'] }),
    }).ticket;
    const completion = await runtime.step();

    expect(completion?.outcome.result).toBeInstanceOf(Err);
    expect(runtime.stateOf(ticket)).toBe(MACHINE_COMPLETED);
  });

  it('records a suspended run with its partial journal', async () => {
    const calls: number[] = [];
    const runtime = twiceMachine(calls);
    const ticket = runtime.submit({ name: 'twice', focus: { n: 2 }, kit: twiceKit() }).ticket;
    const completion = await runtime.step({ maxEffects: 2 });

    expect(completion?.suspended).toBe(true);
    expect(runtime.stateOf(ticket)).toBe(MACHINE_SUSPENDED);
    expect(calls).toEqual([2]);
    expect(runtime.journalFor(ticket)?.portResults()).toHaveLength(1);
  });

  it('resumes without hitting a recorded external result again', async () => {
    const calls: number[] = [];
    const runtime = twiceMachine(calls);
    const ticket = runtime.submit({ name: 'twice', focus: { n: 2 }, kit: twiceKit() }).ticket;
    await runtime.step({ maxEffects: 2 });
    const resumed = await runtime.resume(ticket);

    expect(resumed.suspended).toBe(false);
    expect(runtime.stateOf(ticket)).toBe(MACHINE_COMPLETED);
    expect(calls).toEqual([2, 4]);
    expect(resumed.produced).toEqual({ n: 2, doubled: 8 });
  });

  it('refuses resume before a run or for an unknown ticket', async () => {
    const runtime = twiceMachine([]);
    runtime.submit({ name: 'twice', focus: { n: 2 }, kit: twiceKit() });

    await expect(runtime.resume(1)).rejects.toThrow(/ticket 1/u);
    await expect(runtime.resume(99)).rejects.toThrow(/ticket 99/u);
  });
});
