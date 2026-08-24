import { Task } from '@minamorl/berylx';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Journal,
  Kit,
  MACHINE_ACCEPTED,
  MACHINE_COMPLETED,
  MACHINE_SUSPENDED,
  Machine,
  MachineIntake,
  MachineLedger,
  PROGRAM_SUBMIT_TAG,
  PortAdapter,
  PortRegistry,
  ProgramRegistry,
} from '../src/index.js';

const Input = z.object({ n: z.number().int() }).describe('ResIn');
const Output = z.object({ n: z.number().int(), doubled: z.number().int() }).describe('ResOut');

function ports(calls: number[]): PortRegistry {
  const registry = new PortRegistry();
  registry.register(new PortAdapter('probe').operation('probe', Input, Output, (payload) => {
    calls.push(payload.n);
    return { n: payload.n, doubled: payload.n * 2 };
  }));
  return registry;
}

function onceTask(): Task {
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

function programs(): ProgramRegistry {
  return new ProgramRegistry()
    .register({ name: 'double', task: onceTask(), input: Input, output: Output })
    .register({ name: 'twice', task: twiceTask(), input: Input, output: Output });
}

function kit(name: string): Kit {
  return Kit.of({ ports: ['probe', PROGRAM_SUBMIT_TAG], programs: [name], depth: 1 });
}

function machine(
  calls: number[],
  ledger = new MachineLedger(),
  intake = new MachineIntake(),
): Machine {
  return new Machine({ programs: programs(), ports: ports(calls), ledger, intake });
}

describe('Machine resilience', () => {
  it('lets an already-running loop pick up everything thrown at it', async () => {
    const calls: number[] = [];
    const runtime = machine(calls);
    const wanted = 5;
    const driver = (async () => {
      const completed = [];
      let spins = 0;
      while (completed.length < wanted && spins < 1_000) {
        spins += 1;
        const item = await runtime.step();
        if (item === undefined) {
          await Promise.resolve();
        } else {
          completed.push(item);
        }
      }
      return completed;
    })();

    for (let value = 1; value <= wanted; value += 1) {
      runtime.submit({ name: 'double', focus: { n: value }, kit: kit('double') });
    }
    const picked = await driver;

    expect(picked).toHaveLength(wanted);
    expect([...calls].sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5]);
    expect(picked.map((completion) => completion.ticket)).toEqual([1, 2, 3, 4, 5]);
    expect(picked.every((completion) => !completion.suspended)).toBe(true);
    expect(runtime.pending).toBe(0);
  });

  it('rebuilds from the ledger and resumes to the same receipts', async () => {
    const ledger = new MachineLedger();
    const baselineCalls: number[] = [];
    const baselineMachine = machine(baselineCalls);
    baselineMachine.submit({ name: 'twice', focus: { n: 2 }, kit: kit('twice') });
    const baseline = await baselineMachine.step();
    expect(baselineCalls).toEqual([2, 4]);

    const firstCalls: number[] = [];
    const first = machine(firstCalls, ledger);
    const ticket = first.submit({ name: 'twice', focus: { n: 2 }, kit: kit('twice') }).ticket;
    expect((await first.step({ maxEffects: 2 }))?.suspended).toBe(true);
    expect(firstCalls).toEqual([2]);
    expect(ledger.stateOf(ticket)).toBe(MACHINE_SUSPENDED);

    const secondCalls: number[] = [];
    const second = machine(secondCalls, ledger, new MachineIntake());
    const resumed = await second.resume(ticket);

    expect(secondCalls).toEqual([4]);
    expect(resumed.suspended).toBe(false);
    expect(ledger.stateOf(ticket)).toBe(MACHINE_COMPLETED);
    expect(resumed.produced).toEqual(baseline?.produced);
    expect(resumed.outcome.receipts).toEqual(baseline?.outcome.receipts);
    expect(Journal.dump(resumed.outcome.journal)).toBe(Journal.dump(baseline!.outcome.journal));
  });

  it('stores everything needed to resume in the accepted plain record', async () => {
    const ledger = new MachineLedger();
    const first = machine([], ledger);
    const ticket = first.submit({ name: 'twice', focus: { n: 2 }, kit: kit('twice') }).ticket;
    await first.step({ maxEffects: 2 });
    const accepted = ledger.forTicket(ticket).find((record) => record.kind === MACHINE_ACCEPTED);

    expect(accepted?.payload.name).toBe('twice');
    expect(accepted?.payload.focus).toEqual({ n: 2 });
    expect((accepted?.payload.kit as { depth: number }).depth).toBe(1);
    expect(accepted?.payload.seed).toBe(ticket);
    expect(JSON.parse(JSON.stringify(accepted?.payload))).toEqual(accepted?.payload);
  });
});
