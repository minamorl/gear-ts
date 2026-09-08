# Gear

[![CI](https://github.com/minamorl/gear-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/minamorl/gear-ts/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@minamorl/gear)](https://www.npmjs.com/package/@minamorl/gear)

Gear runs TypeScript workflows with explicit permissions, resumable effects, and an
append-only execution journal. It builds on
[Berylx](https://github.com/minamorl/berylx-ts) and validates program and port
boundaries with [Zod](https://zod.dev/).

Use it when you need to pause a workflow, resume it with recorded external results,
or inspect why an operation was allowed or denied. Gear is an embedded runtime:
your application decides when to accept work and when to advance it.

## Install

```sh
npm install @minamorl/gear @minamorl/berylx zod
```

Requires Node.js 20 or later. The package provides ECMAScript modules and TypeScript
declarations. CI uses Node.js 22.

## A complete example

Save this as `greet.mjs` and run `node greet.mjs` after installing the packages above.

```js
import { Task } from "@minamorl/berylx";
import { z } from "zod";
import {
  Kit,
  Machine,
  PortAdapter,
  PortRegistry,
  ProgramRegistry,
  PROGRAM_SUBMIT_TAG,
  projectView,
} from "@minamorl/gear";

const GREET_TAG = "greet_upcase";
const ports = new PortRegistry();
ports.register(
  new PortAdapter("greet").operation(
    GREET_TAG,
    z.object({ name: z.string() }),
    z.object({ shout: z.string() }),
    ({ name }) => ({ shout: `HELLO, ${name.toUpperCase()}` }),
  ),
);

const programs = new ProgramRegistry().register({
  name: "greet",
  task: Task.of("greet", (lay, io) => {
    const result = io.perform(GREET_TAG, { name: lay.at("name").fetch() });
    return lay.put("shout", result.shout);
  }),
  input: z.object({ name: z.string() }).describe("GreetInput"),
  output: z.object({ shout: z.string() }).describe("GreetOutput"),
});

const kit = Kit.of({
  ports: [GREET_TAG, PROGRAM_SUBMIT_TAG],
  programs: ["greet"],
  depth: 1,
});

const machine = new Machine({ programs, ports });
machine.submit({ name: "greet", focus: { name: "Ada" }, kit });
const [done] = await machine.drain();

console.log(JSON.stringify(done.produced));
console.log(done.outcome.receipts.length);
console.log(projectView(done.outcome.journal).toJSON().last_tick);
```

Output:

```text
{"name":"Ada","shout":"HELLO, ADA"}
2
2
```

The two receipts cover the program submission and its greeting effect. Program
schemas need `.describe()` labels so recorded boundaries have stable names. Use
`PortAdapter.asyncOperation()` and Berylx `AsyncTask` for asynchronous operations.

## Execution and permissions

`submit()` records a submission without running it. `step()` executes one queued
item; `drain()` executes queued items until the queue is empty or its `limit` is
reached. An empty queue makes `step()` return `undefined`.

A `Kit` declares which port tags and program names a submission may use, together
with its remaining program-call depth. A top-level program submission needs
`PROGRAM_SUBMIT_TAG`, the program name, and a positive depth. `kit.narrow()` and
`kit.descend()` can reduce this authority. An optional admission `policy` can
restrict it further.

Programs and adapters are trusted application code. Kit controls operations sent
through Gear; it does not sandbox arbitrary JavaScript. The default port registry
includes shell, HTTP, and wall-clock adapters. Pass an explicit `PortRegistry`, as
in the example, to select the operations available to your application.

Continue the example with an empty kit to inspect a denial:

```js
machine.submit({ name: "greet", focus: { name: "Ada" }, kit: Kit.nothing() });
const [denied] = await machine.drain();
console.log(denied.denied); // true
console.log(denied.produced); // null
console.log(projectView(denied.outcome.journal).toJSON().denials.length); // 1
```

## Pause and resume

An effect budget stops execution before an operation would exceed `maxEffects`.
Resume the same ticket to continue from its journal:

```js
const resumable = new Machine({ programs, ports });
const submission = resumable.submit({
  name: "greet",
  focus: { name: "Ada" },
  kit,
});
const paused = await resumable.step({ maxEffects: 1 });
console.log(paused.suspended); // true

const resumed = await resumable.resume(submission.ticket);
console.log(resumed.suspended); // false
console.log(JSON.stringify(resumed.produced)); // {"name":"Ada","shout":"HELLO, ADA"}
```

Recorded external results are read back during replay. A different port or request,
or a result that no longer fits its schema, fails replay instead of silently using
incompatible history. Keep the program definitions and schemas compatible with
the journals you intend to resume.

## Journal, receipts, and persistence

| Component | Responsibility                                                                 |
| --------- | ------------------------------------------------------------------------------ |
| Clock     | Discrete ticks and deterministic random values derived from the run seed.      |
| Admission | Check permissions before an effect executes and record denials.                |
| Executor  | Run Berylx programs, suspend at an effect budget, and replay recorded results. |
| Journal   | Append-only records of execution and external results.                         |
| Receipt   | Record an effect's outcome, admission grounds, and predecessor link.           |

`projectView(journal)` derives a view from the journal. `Routine.fromJournal()` can
reconstruct a reusable sequence of recorded effects. The root package also exports
the lower-level `Executor`, `Journal`, `Admission`, `Routine`, and `View` APIs.

Memory is the default storage. To persist a Machine, pass `stateDir`:

```js
const persistent = new Machine({ programs, ports, stateDir: "./gear-state" });
```

A new Machine using the same directory restores its intake, ledger, and per-ticket
journals. Keep this directory outside disposable builds and use one writer per
directory. Persistence does not make an external operation and a journal write a
single transaction; adapters still need an appropriate recovery or idempotency
strategy for a crash between those operations.

## FIFO host

The package includes the Unix-oriented `gear-host` executable. It requires
`GEAR_STATE_DIR`, creates an `intake` FIFO there using `mkfifo`, and writes host
events to stdout and `host.log`. Submissions are newline-delimited JSON objects
with `name`, `focus`, `kit`, and an optional integer `seed`.

The supplied host starts with an empty program registry. It cannot execute useful
application work until you register application programs in `src/bin/host.ts` and
build your deployment. It is a starting point for an application host, not a
remotely configurable workflow service. It does not expose an HTTP server.

[Linux deployment instructions](https://github.com/minamorl/gear-ts/blob/main/deploy/README.md)
cover the user systemd service, immutable releases, health checks, and rollback.
The host's wall-clock log timestamps are separate from the execution clock.

## Development

```sh
git clone https://github.com/minamorl/gear-ts.git
cd gear-ts
npm ci
npm run format:check
npm run check
```

`check` runs type-checking, tests, and a build. `prepare` builds the package after a
development install and before packing. CI repeats the checks on pull requests
and pushes to `main`.

Releases use Release Please and publish to npm from GitHub Actions with provenance.
See [the release guide](https://github.com/minamorl/gear-ts/blob/main/.github/RELEASING.md).

## License

[MIT](LICENSE).
