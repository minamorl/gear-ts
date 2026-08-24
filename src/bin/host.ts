#!/usr/bin/env node
// ==================================================================
// gear の常駐入口。
//
// 投入は FIFO から 1 件 1 行。HTTP は listen しない —— 核へ外から到達する経路を
// 作らないため (pin runtime.not_a_daemon_core / pin ui.transport_core_in_process)。
//
// 環境変数:
//   GEAR_STATE_DIR  状態の置き場所。既定 ./var。FIFO は <STATE_DIR>/intake。
//                   release の中には書かない (release は不変で、世代で捨てられる)。
// ==================================================================
import { mkdirSync, existsSync, createReadStream, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Host, type HostEvent } from '../host.js';
import { Registry } from '../program.js';

const stateDir = process.env.GEAR_STATE_DIR ?? join(process.cwd(), 'var');
const fifo = join(stateDir, 'intake');
const logFile = join(stateDir, 'host.log');

mkdirSync(stateDir, { recursive: true, mode: 0o700 });
// FIFO は mkfifo でしか作れない。既に在れば作り直さない (書き手が開いている可能性がある)。
if (!existsSync(fifo)) execFileSync('mkfifo', ['-m', '600', fifo]);

function record(event: HostEvent | { kind: string; [key: string]: unknown }): void {
  // 時刻は Clock ではなくホスト側の関心。gear の tick は実時間で進めない
  // (pin tick.discrete) ので、この時刻が走行の順序に混ざることはない。
  const line = JSON.stringify({ at: new Date().toISOString(), ...event });
  appendFileSync(logFile, line + '\n', { mode: 0o600 });
  process.stdout.write(line + '\n');
}

// 乗客はまだ居ない。空の registry は「何も受け付けない機械」であって、
// 受け付けたふりをする機械ではない —— 未登録の program は admission で落ちる。
const programs = new Registry();

record({ kind: 'starting', stateDir, fifo, programs: 0, pid: process.pid });

// FIFO は書き手が全員閉じると EOF になる。常駐なので、そのたびに開き直す。
async function serve(): Promise<void> {
  for (;;) {
    const io = createReadStream(fifo, { encoding: 'utf8' });
    const host = new Host({ io, programs, report: record });
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
