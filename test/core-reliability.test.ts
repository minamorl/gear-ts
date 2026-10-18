import {
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { AsyncTask } from "@minamorl/berylx";
import { AllowAll } from "../src/admission/policy.js";
import { run } from "../src/executor.js";
import { Replay } from "../src/executor/replay.js";
import {
  Entry,
  JournalWriteError,
  Log,
  PORT_RESULT,
  ReplayMismatch,
  ReplayUnreadable,
  load as loadJournal,
} from "../src/journal.js";
import { Machine } from "../src/machine.js";
import { Registry as ProgramRegistry } from "../src/program.js";
import { FileStore } from "../src/machine/store.js";
import { JournalAppendMismatch } from "../src/machine/store.js";
import { withFileLock } from "../src/machine/file-lock.js";
import type { Registry as PortRegistry } from "../src/port/core.js";

const registry = {
  forTag: () => ({ operationFor: () => ({ resultSchema: z.number() }) }),
} as unknown as PortRegistry;

test("parallel results replay by request and start tick despite completion order", () => {
  const recorded = new Log([
    Entry.at(2, PORT_RESULT, {
      port: "example",
      request: { id: 2 },
      result: 22,
    }),
    Entry.at(1, PORT_RESULT, {
      port: "example",
      request: { id: 1 },
      result: 11,
    }),
  ]);
  const replay = new Replay(recorded, registry);
  expect(replay.readBack("example", { id: 1 }, 1)[0]).toBe(11);
  expect(replay.readBack("example", { id: 2 }, 2)[0]).toBe(22);
  expect(replay.exhausted).toBe(true);
});

test("identical parallel requests retain start order", () => {
  const recorded = new Log([
    Entry.at(2, PORT_RESULT, {
      port: "example",
      request: { id: 1 },
      result: 22,
    }),
    Entry.at(1, PORT_RESULT, {
      port: "example",
      request: { id: 1 },
      result: 11,
    }),
  ]);
  const replay = new Replay(recorded, registry);
  expect(replay.readBack("example", { id: 1 }, 1)[0]).toBe(11);
  expect(replay.readBack("example", { id: 1 }, 2)[0]).toBe(22);
});

test("unmatched replay requests still fail", () => {
  const recorded = new Log([
    Entry.at(1, PORT_RESULT, {
      port: "example",
      request: { id: 1 },
      result: 11,
    }),
  ]);
  expect(() =>
    new Replay(recorded, registry).readBack("example", { id: 2 }),
  ).toThrow(ReplayMismatch);
});

test("replay returns detached frozen JSON after schema transforms and defaults", () => {
  let transformed: { values: number[] } | undefined;
  const schemas = {
    transformed: z.object({ value: z.number() }).transform((input) => {
      transformed = { values: [input.value, 2] };
      return transformed;
    }),
    defaulted: z.object({ value: z.number().default(7) }),
  };
  const resultRegistry = {
    forTag: (tag: keyof typeof schemas) => ({
      operationFor: () => ({ resultSchema: schemas[tag] }),
    }),
  } as unknown as PortRegistry;
  const replay = new Replay(
    new Log([
      Entry.at(1, PORT_RESULT, {
        port: "transformed",
        request: { id: 1 },
        result: { value: 3 },
      }),
      Entry.at(2, PORT_RESULT, {
        port: "defaulted",
        request: { id: 2 },
        result: {},
      }),
    ]),
    resultRegistry,
  );
  const transformedResult = replay.readBack("transformed", { id: 1 }, 1)[0] as {
    values: number[];
  };
  expect(transformedResult).toEqual({ values: [3, 2] });
  expect(transformedResult).not.toBe(transformed);
  expect(Object.isFrozen(transformedResult)).toBe(true);
  expect(Object.isFrozen(transformedResult.values)).toBe(true);
  transformed?.values.push(4);
  expect(transformedResult.values).toEqual([3, 2]);

  const defaultedResult = replay.readBack("defaulted", { id: 2 }, 2)[0] as {
    value: number;
  };
  expect(defaultedResult).toEqual({ value: 7 });
  expect(Object.isFrozen(defaultedResult)).toBe(true);
});

test("executor exposes detached frozen transformed replay results", async () => {
  let transformed: { values: number[] } | undefined;
  let observed: unknown;
  const resultSchema = z.object({ value: z.number() }).transform((input) => {
    transformed = { values: [input.value, 2] };
    return transformed;
  });
  const adapter = {
    operationFor: () => ({
      tag: "transform",
      payloadSchema: z.object({ id: z.number() }),
      resultSchema,
      asynchronous: true,
    }),
  };
  const ports = {
    tags: ["transform"],
    forTag: () => adapter,
    realHandlers: () => ({
      transform: async () => {
        throw new Error("recorded external effect was repeated");
      },
    }),
  } as unknown as PortRegistry;
  const program = AsyncTask.of("transform_task", async (focus, performer) => {
    observed = await performer.perform("transform", { id: 1 });
    return focus.at("data").set(observed);
  });
  const outcome = await run(program, {
    seed: 1,
    policy: new AllowAll(),
    registry: ports,
    journal: new Log([
      Entry.at(1, PORT_RESULT, {
        port: "transform",
        request: { id: 1 },
        result: { value: 3 },
      }),
    ]),
    focus: { data: null },
  });
  expect(outcome.done).toBe(true);
  expect(observed).toEqual({ values: [3, 2] });
  expect(observed).not.toBe(transformed);
  expect(Object.isFrozen(observed)).toBe(true);
  expect(Object.isFrozen((observed as { values: number[] }).values)).toBe(true);
  transformed?.values.push(4);
  expect(observed).toEqual({ values: [3, 2] });
});

test("parallel unreadable replay reaches the public caller without external effects", async () => {
  const calls: string[] = [];
  const adapter = {
    operationFor: (tag: string) => ({
      tag,
      payloadSchema: z.object({ id: z.number() }),
      resultSchema: z.number(),
      asynchronous: true,
    }),
  };
  const ports = {
    tags: ["shared", "tail"],
    forTag: () => adapter,
    realHandlers: () => ({
      shared: async () => {
        calls.push("shared");
        return 99;
      },
      tail: async () => {
        calls.push("tail");
        return 99;
      },
    }),
  } as unknown as PortRegistry;
  const branch = (name: string) =>
    AsyncTask.of(name, async (focus, performer) => {
      if (name === "b") await new Promise((resolve) => setTimeout(resolve, 5));
      const value = await performer.perform("shared", { id: 1 });
      return focus.at(name).set(value);
    });
  const late = AsyncTask.of("late_task", async (focus, performer) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const value = await performer.perform("tail", { id: 2 });
    return focus.at("tail").set(value);
  });
  const journal = new Log([
    Entry.at(2, PORT_RESULT, {
      port: "shared",
      request: { id: 1 },
      result: "invalid",
    }),
    Entry.at(1, PORT_RESULT, {
      port: "shared",
      request: { id: 1 },
      result: 11,
    }),
  ]);
  const execution = run(branch("a").par(branch("b")).par(late), {
    seed: 1,
    policy: new AllowAll(),
    registry: ports,
    journal,
    focus: { a: 0, b: 0, tail: 0 },
  });
  const settled = await Promise.race([
    execution.then(
      () => "resolved" as const,
      (error: unknown) => error,
    ),
    new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 1000),
    ),
  ]);
  expect(settled).toBeInstanceOf(ReplayUnreadable);
  expect(calls).toEqual([]);
});

test("two machines sharing a state directory issue distinct tickets", () => {
  const directory = mkdtempSync(
    join(process.cwd(), ".core-reliability-logs", "state-"),
  );
  try {
    const programs = {} as ProgramRegistry;
    const first = new Machine({ programs, stateDir: directory });
    const second = new Machine({ programs, stateDir: directory });
    expect(first.submit({ name: "first" }).ticket).toBe(1);
    expect(second.submit({ name: "second" }).ticket).toBe(2);
    const rebuilt = new Machine({ programs, stateDir: directory });
    expect(rebuilt.submit({ name: "third" }).ticket).toBe(3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reserved tickets keep their journals in separate files", () => {
  const directory = mkdtempSync(
    join(process.cwd(), ".core-reliability-logs", "journals-"),
  );
  try {
    const store = new FileStore(directory);
    const first = store.reserveTicket(0);
    const second = store.reserveTicket(0);
    store
      .writer(first, new Log())
      .append(Entry.at(1, "first_machine", { value: 1 }));
    store
      .writer(second, new Log())
      .append(Entry.at(1, "second_machine", { value: 2 }));
    expect(
      loadJournal(readFileSync(store.journalPath(first), "utf8")).toArray()[0]
        .kind,
    ).toBe("first_machine");
    expect(
      loadJournal(readFileSync(store.journalPath(second), "utf8")).toArray()[0]
        .kind,
    ).toBe("second_machine");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stale writers cannot append a different run into the same journal", () => {
  const directory = mkdtempSync(
    join(process.cwd(), ".core-reliability-logs", "writers-"),
  );
  try {
    const store = new FileStore(directory);
    const ticket = store.reserveTicket(0);
    const first = store.writer(ticket, new Log());
    const stale = store.writer(ticket, new Log());
    first.append(Entry.at(1, "first_run", { value: 1 }));
    expect(() => stale.append(Entry.at(1, "second_run", { value: 2 }))).toThrow(
      JournalAppendMismatch,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an executor run replays parallel results completed in reverse tick order", async () => {
  const calls: string[] = [];
  const operation = (tag: string) => ({
    tag,
    payloadSchema: z.object({ id: z.number() }),
    resultSchema: z.number(),
    asynchronous: true,
  });
  const makeRegistry = (replay: boolean) => {
    const handlers = {
      slow: async () => {
        if (replay) throw new Error("external slow call during replay");
        calls.push("slow");
        await new Promise((resolve) => setTimeout(resolve, 20));
        return 11;
      },
      fast: async () => {
        if (replay) throw new Error("external fast call during replay");
        calls.push("fast");
        return 22;
      },
    };
    const adapter = { operationFor: operation };
    return {
      tags: ["slow", "fast"],
      forTag: () => adapter,
      realHandlers: () => handlers,
    } as unknown as PortRegistry;
  };
  const slow = AsyncTask.of("slow_task", async (focus, performer) => {
    const value = await performer.perform("slow", { id: 1 });
    return focus.at("slow").set(value);
  });
  const fast = AsyncTask.of("fast_task", async (focus, performer) => {
    const value = await performer.perform("fast", { id: 2 });
    return focus.at("fast").set(value);
  });
  const program = slow.par(fast);
  const first = await run(program, {
    seed: 1,
    policy: new AllowAll(),
    registry: makeRegistry(false),
    focus: { slow: 0, fast: 0 },
  });
  expect(first.done).toBe(true);
  expect(first.journal.portResults().map((entry) => entry.tick)).toEqual([
    2, 1,
  ]);
  const replayed = await run(program, {
    seed: 1,
    policy: new AllowAll(),
    registry: makeRegistry(true),
    journal: first.journal,
    focus: { slow: 0, fast: 0 },
  });
  expect(replayed.done).toBe(true);
  expect(calls).toEqual(["slow", "fast"]);
});

test("a suspended run resumes after reversed parallel completions", async () => {
  const calls: string[] = [];
  const makeRegistry = (replay: boolean) => {
    const handlers = {
      slow: async () => {
        if (replay) throw new Error("slow was repeated");
        calls.push("slow");
        await new Promise((resolve) => setTimeout(resolve, 20));
        return 11;
      },
      fast: async () => {
        if (replay) throw new Error("fast was repeated");
        calls.push("fast");
        return 22;
      },
      tail: async () => {
        calls.push("tail");
        return 33;
      },
    };
    const adapter = {
      operationFor: (tag: string) => ({
        tag,
        payloadSchema: z.object({ id: z.number() }),
        resultSchema: z.number(),
        asynchronous: true,
      }),
    };
    return {
      tags: ["slow", "fast", "tail"],
      forTag: () => adapter,
      realHandlers: () => handlers,
    } as unknown as PortRegistry;
  };
  const task = (tag: string) =>
    AsyncTask.of(`${tag}_task`, async (focus, performer) => {
      const value = await performer.perform(tag, { id: 1 });
      return focus.at(tag).set(value);
    });
  const program = task("slow").par(task("fast")).then(task("tail"));
  const options = {
    seed: 1,
    policy: new AllowAll(),
    focus: { slow: 0, fast: 0, tail: 0 },
  };
  const first = await run(program, {
    ...options,
    registry: makeRegistry(false),
    maxEffects: 2,
  });
  expect(first.suspended).toBe(true);
  expect(first.journal.portResults().map((entry) => entry.tick)).toEqual([
    2, 1,
  ]);
  const resumed = await run(program, {
    ...options,
    registry: makeRegistry(true),
    journal: first.journal,
  });
  expect(resumed.done).toBe(true);
  expect(calls).toEqual(["slow", "fast", "tail"]);
});

test("executor resume retains interleaved repeated parallel receipts and journal", async () => {
  const createPorts = (calls: number[]) => {
    const adapter = {
      operationFor: (tag: string) => ({
        tag,
        payloadSchema: z.object({ id: z.number() }),
        resultSchema: z.number(),
        asynchronous: true,
      }),
    };
    return {
      tags: ["shared", "tail"],
      forTag: () => adapter,
      realHandlers: () => ({
        shared: async () => {
          const value = calls.length + 1;
          calls.push(value);
          await new Promise((resolve) =>
            setTimeout(resolve, value === 1 ? 30 : value === 2 ? 5 : 1),
          );
          return value;
        },
        tail: async () => {
          calls.push(5);
          return 5;
        },
      }),
    } as unknown as PortRegistry;
  };
  const branch = (name: string) =>
    AsyncTask.of(name, async (focus, performer) => {
      const first = await performer.perform("shared", { id: 1 });
      const second = await performer.perform("shared", { id: 1 });
      return focus.at(name).set([first, second]);
    });
  const tail = AsyncTask.of("tail_task", async (focus, performer) => {
    const value = await performer.perform("tail", { id: 1 });
    return focus.at("tail").set(value);
  });
  const program = branch("a").par(branch("b")).then(tail);
  const focus = { a: [], b: [], tail: 0 };
  const calls: number[] = [];
  const referenceCalls: number[] = [];
  const options = {
    seed: 1,
    policy: new AllowAll(),
    registry: createPorts(calls),
    focus,
  };
  const full = await run(program, {
    ...options,
    registry: createPorts(referenceCalls),
  });
  const first = await run(program, { ...options, maxEffects: 4 });
  expect(first.suspended).toBe(true);
  const directory = mkdtempSync(
    join(process.cwd(), ".core-reliability-logs", "parallel-sink-"),
  );
  const store = new FileStore(directory);
  const ticket = store.reserveTicket(0);
  const seedWriter = store.writer(ticket, new Log());
  for (const entry of first.journal) seedWriter.append(entry);
  const saved = readFileSync(store.journalPath(ticket), "utf8");
  const resumed = await run(program, {
    ...options,
    journal: first.journal,
    journalSink: store.writer(ticket, first.journal),
  });
  expect(resumed.done).toBe(true);
  expect(resumed.journal.toArray().slice(0, first.journal.size)).toEqual(
    first.journal.toArray(),
  );
  const disk = readFileSync(store.journalPath(ticket), "utf8");
  expect(disk.startsWith(saved)).toBe(true);
  expect(loadJournal(disk).toArray()).toEqual(resumed.journal.toArray());
  expect(resumed.receipts.map((receipt) => receipt.toJSON())).toEqual(
    full.receipts.map((receipt) => receipt.toJSON()),
  );
  expect(calls).toEqual([1, 2, 3, 4, 5]);
  rmSync(directory, { recursive: true, force: true });
});

test("persistent Machine replays interleaved repeated parallel effects and retains the disk prefix", async () => {
  const directory = mkdtempSync(
    join(process.cwd(), ".core-reliability-logs", "parallel-machine-"),
  );
  try {
    const calls: number[] = [];
    const adapter = {
      operationFor: (tag: string) => ({
        tag,
        payloadSchema: z.object({ id: z.number() }),
        resultSchema: z.number(),
        asynchronous: true,
      }),
    };
    const ports = {
      tags: ["shared", "tail"],
      forTag: () => adapter,
      realHandlers: () => ({
        shared: async () => {
          const ordinal = calls.length + 1;
          calls.push(ordinal);
          await new Promise((resolve) =>
            setTimeout(resolve, ordinal === 1 ? 30 : ordinal === 2 ? 5 : 1),
          );
          return ordinal;
        },
        tail: async () => {
          calls.push(5);
          return 5;
        },
      }),
    } as unknown as PortRegistry;
    const branch = (name: string) =>
      AsyncTask.of(name, async (focus, performer) => {
        const first = await performer.perform("shared", { id: 1 });
        const second = await performer.perform("shared", { id: 1 });
        return focus.at(name).set([first, second]);
      });
    const tail = AsyncTask.of("tail_task", async (focus, performer) => {
      const value = await performer.perform("tail", { id: 1 });
      return focus.at("tail").set(value);
    });
    const program = branch("a").par(branch("b")).then(tail);
    const programs = new ProgramRegistry();
    programs.register({
      name: "parallel",
      task: program,
      input: z
        .object({
          a: z.array(z.number()),
          b: z.array(z.number()),
          tail: z.number(),
        })
        .describe("parallel focus"),
      output: z
        .object({
          a: z.array(z.number()),
          b: z.array(z.number()),
          tail: z.number(),
        })
        .describe("parallel result"),
    });
    const firstMachine = new Machine({ programs, ports, stateDir: directory });
    const submission = firstMachine.submit({
      name: "parallel",
      focus: { a: [], b: [], tail: 0 },
      seed: 1,
    });
    const suspended = await firstMachine.step({ maxEffects: 4 });
    if (!suspended) throw new Error("Machine did not step");
    expect(suspended.ticket).toBe(submission.ticket);
    expect(suspended.suspended).toBe(true);
    const store = new FileStore(directory);
    const saved = readFileSync(store.journalPath(submission.ticket), "utf8");
    const rebuilt = new Machine({ programs, ports, stateDir: directory });
    const resumed = await rebuilt.resume(submission.ticket);
    expect(resumed.suspended).toBe(false);
    const disk = readFileSync(store.journalPath(submission.ticket), "utf8");
    expect(disk.startsWith(saved)).toBe(true);
    expect(loadJournal(disk).toArray()).toEqual(
      resumed.outcome.journal.toArray(),
    );
    expect(
      resumed.outcome.receipts
        .slice(0, suspended.outcome.receipts.length)
        .map((receipt) => receipt.toJSON()),
    ).toEqual(suspended.outcome.receipts.map((receipt) => receipt.toJSON()));
    expect(calls).toEqual([1, 2, 3, 4, 5]);
    expect(resumed.produced).toEqual({ a: [1, 4], b: [2, 3], tail: 5 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stale and live lock owners survive concurrent acquisition attempts", async () => {
  const directory = mkdtempSync(
    join(process.cwd(), ".core-reliability-logs", "lock-safety-"),
  );
  const path = join(directory, "state");
  const lock = `${path}.lock`;
  let holder: ReturnType<typeof spawn> | undefined;
  try {
    symlinkSync("999999999", lock);
    const contender = spawn(
      process.execPath,
      [
        "-e",
        `const fs = require('node:fs');
         const lock = process.argv[1];
         try {
           fs.symlinkSync(String(process.pid), lock);
           process.stdout.write('acquired');
           fs.unlinkSync(lock);
         } catch (error) {
           if (error.code !== 'EEXIST') throw error;
           process.stdout.write('busy');
         }`,
        lock,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let contenderOutput = "";
    contender.stdout?.on("data", (chunk) => {
      contenderOutput += String(chunk);
    });
    const contenderClosed = new Promise<number | null>((resolve, reject) => {
      contender.once("error", reject);
      contender.once("close", resolve);
    });
    let entered = false;
    expect(() =>
      withFileLock(path, () => {
        entered = true;
      }),
    ).toThrow(JournalWriteError);
    expect(entered).toBe(false);
    expect(await contenderClosed).toBe(0);
    expect(contenderOutput).toBe("busy");
    expect(readlinkSync(lock)).toBe("999999999");

    unlinkSync(lock);
    holder = spawn(
      process.execPath,
      [
        "-e",
        `const fs = require('node:fs');
         const lock = process.argv[1];
         fs.symlinkSync(String(process.pid), lock);
         process.stdout.write('ready\\n');
         process.stdin.once('data', () => {
           fs.unlinkSync(lock);
           process.exit(0);
         });`,
        lock,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const liveHolder = holder;
    await new Promise<void>((resolve, reject) => {
      liveHolder.once("error", reject);
      liveHolder.once("close", (code) =>
        reject(new Error(`lock holder exited before ready: ${code}`)),
      );
      liveHolder.stdout?.once("data", (chunk) => {
        if (String(chunk).trim() === "ready") resolve();
        else reject(new Error("lock holder did not signal readiness"));
      });
    });
    expect(readlinkSync(lock)).toBe(String(liveHolder.pid));
    expect(() =>
      withFileLock(path, () => {
        entered = true;
      }),
    ).toThrow(JournalWriteError);
    expect(entered).toBe(false);
    expect(readlinkSync(lock)).toBe(String(liveHolder.pid));
    liveHolder.stdin?.end("\n");
    await new Promise<void>((resolve, reject) => {
      liveHolder.once("error", reject);
      liveHolder.once("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`lock holder exited: ${code}`)),
      );
    });
    holder = undefined;
    expect(withFileLock(path, () => 42)).toBe(42);
  } finally {
    holder?.kill();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a replaced lock remains after the former owner's finalization", () => {
  const directory = mkdtempSync(
    join(process.cwd(), ".core-reliability-logs", "lock-replaced-"),
  );
  const path = join(directory, "state");
  const lock = `${path}.lock`;
  try {
    expect(() =>
      withFileLock(path, () => {
        unlinkSync(lock);
        symlinkSync("another-owner", lock);
      }),
    ).toThrow(JournalWriteError);
    expect(readlinkSync(lock)).toBe("another-owner");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
