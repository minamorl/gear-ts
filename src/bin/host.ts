#!/usr/bin/env node
// ==================================================================
// Long-lived entry point for gear.
//
// Rows are injected one per line through a FIFO. HTTP is not listened on — this
// avoids making any route through which something external can reach the core
// (pin runtime.not_a_daemon_core / pin ui.transport_core_in_process).
//
// Environment variables:
//   GEAR_STATE_DIR  Where state lives (required). The FIFO sits at <STATE_DIR>/intake.
//                   Never written to from within the release (release is immutable,
//                   discarded by generation).
// ==================================================================
import { mkdirSync, existsSync, createReadStream, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Host, type HostEvent } from '../host.js';
import { Registry } from '../program.js';

const stateDir = process.env.GEAR_STATE_DIR;
if (stateDir === undefined || stateDir.length === 0) {
  throw new Error('GEAR_STATE_DIR is required and must point outside the release directory');
}
const fifo = join(stateDir, 'intake');
const logFile = join(stateDir, 'host.log');

mkdirSync(stateDir, { recursive: true, mode: 0o700 });
// A FIFO can only be created with mkfifo. Do not recreate if one already exists
// (a writer may still have it open).
if (!existsSync(fifo)) execFileSync('mkfifo', ['-m', '600', fifo]);

function record(event: HostEvent | { kind: string; [key: string]: unknown }): void {
  // The timestamp is host-side concern, not Clock's. gear's tick cannot advance in
  // wall-clock time (pin tick.discrete), so this timestamp does not mingle with the
  // ordering of trips.
  const line = JSON.stringify({ at: new Date().toISOString(), ...event });
  appendFileSync(logFile, line + '\n', { mode: 0o600 });
  process.stdout.write(line + '\n');
}

// There are no passengers yet. An empty registry is a machine that accepts nothing,
// not one that pretends to accept — an unregistered program will fall through
// admission.
const programs = new Registry();

record({ kind: 'starting', stateDir, fifo, programs: 0, pid: process.pid });

// The FIFO becomes EOF once every writer closes it. Because this is a long-lived
// daemon, reopen it each time.
async function serve(): Promise<void> {
  for (;;) {
    const io = createReadStream(fifo, { encoding: 'utf8' });
    const host = new Host({ io, programs, stateDir, report: record });
    const stop = (): void => host.stop();
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    const totals = await host.run();
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    if (stopping) { record({ kind: 'exiting', ...totals }); return; }
  }
}

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => { stopping = true; record({ kind: 'signal', signal }); });
}

serve().catch((error: unknown) => {
  record({ kind: 'crashed', error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
