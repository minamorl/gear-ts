import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Task } from '@minamorl/berylx';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  MACHINE_ACCEPTED,
  Kit,
  Machine,
  MachineFeed,
  MachineIntake,
  PROGRAM_SUBMIT_TAG,
  PortAdapter,
  PortRegistry,
  ProgramRegistry,
} from '../../src/index.js';

const Input = z.object({ n: z.number().int() }).describe('FeedIn');
const Output = z.object({ n: z.number().int(), doubled: z.number().int() }).describe('FeedOut');

function ports(calls: number[]): PortRegistry {
  const registry = new PortRegistry();
  registry.register(new PortAdapter('probe').operation('probe', Input, Output, (payload) => {
    calls.push(payload.n);
    return { n: payload.n, doubled: payload.n * 2 };
  }));
  return registry;
}

function programs(): ProgramRegistry {
  const task = Task.of('double', (lay, io) => {
    const n = lay.at('n').fetch() as number;
    const output = io.perform('probe', { n }) as { doubled: number };
    return lay.put('doubled', output.doubled);
  });
  return new ProgramRegistry().register({ name: 'double', task, input: Input, output: Output });
}

function kitRecord(): Record<string, unknown> {
  return { ports: ['probe', PROGRAM_SUBMIT_TAG], programs: ['double'], depth: 1 };
}

function line(name: string, value: number, kit?: Record<string, unknown>): string {
  return JSON.stringify({ name, focus: { n: value }, ...(kit === undefined ? {} : { kit }) });
}

describe('Machine.Feed', () => {
  it('absorbs NDJSON into the low-level intake seam', async () => {
    const intake = new MachineIntake();
    const feed = new MachineFeed({ io: `${line('double', 1)}\n${line('double', 2)}\n`, intake });
    const accepted = await feed.absorb();

    expect(accepted).toHaveLength(2);
    expect(accepted.map((submission) => submission.name)).toEqual(['double', 'double']);
    expect(accepted.map((submission) => submission.focus)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(intake.size).toBe(2);
    expect(feed.rejected).toEqual([]);
  });

  it('carries Kit declaration data', async () => {
    const feed = new MachineFeed({
      io: `${line('double', 1, kitRecord())}\n`, intake: new MachineIntake(),
    });
    const accepted = await feed.absorb();
    expect(accepted[0]?.kit).toEqual(Kit.fromJSON(kitRecord()));
  });

  it('counts only accepted lines toward the limit and skips blanks', async () => {
    const source = `\nnot json\n${line('double', 1)}\n\n${line('double', 2)}\n`;
    const feed = new MachineFeed({ io: source, intake: new MachineIntake() });

    expect(await feed.absorb({ limit: 1 })).toHaveLength(1);
    expect(feed.rejected).toHaveLength(1);
    expect(await feed.absorb()).toHaveLength(1);
  });

  it('keeps broken lines and continues with later lines', async () => {
    const feed = new MachineFeed({
      io: `not json\n${line('double', 1)}\n${JSON.stringify({ focus: {} })}\n`,
      intake: new MachineIntake(),
    });
    const accepted = await feed.absorb();

    expect(accepted).toHaveLength(1);
    expect(feed.rejected).toHaveLength(2);
    expect(feed.rejected[0]?.reason).toMatch(/not readable as JSON/u);
    expect(feed.rejected[1]?.reason).toMatch(/name is missing/u);
  });

  it('accepts a Unix-socket program through Machine.submit and then runs it', async () => {
    const socketPath = join(tmpdir(), `gear-feed-${process.pid}-${Date.now()}.sock`);
    let server: Server | undefined;
    let outside: Socket | undefined;
    let inside: Socket | undefined;
    try {
      server = createServer();
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(socketPath, resolve);
      });
      const acceptedConnection = new Promise<Socket>((resolve) => server!.once('connection', resolve));
      outside = createConnection(socketPath);
      inside = await acceptedConnection;

      const calls: number[] = [];
      const runtime = new Machine({ programs: programs(), ports: ports(calls) });
      outside.end(`${line('double', 2, kitRecord())}\n${line('double', 5, kitRecord())}\n`);
      const accepted = await new MachineFeed({ io: inside, machine: runtime }).absorb();

      expect(accepted).toHaveLength(2);
      expect(runtime.ledger.ofKind(MACHINE_ACCEPTED)).toHaveLength(2);
      const completed = await runtime.drain();
      expect(completed).toHaveLength(2);
      expect(calls).toEqual([2, 5]);
      expect(completed[0]?.produced).toEqual({ n: 2, doubled: 4 });
      expect(completed[1]?.produced).toEqual({ n: 5, doubled: 10 });
    } finally {
      outside?.destroy();
      inside?.destroy();
      if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await unlink(socketPath).catch(() => undefined);
    }
  });
});
