// ==================================================================
// Host — gear を「別プロセスの常駐」として立てるための殻。
//
// gear.spec の位置づけ:
//   pin runtime.in_language        : gear.runtime.form = in_language_runtime
//   pin runtime.not_a_daemon_core  : forbid gear.runtime.form = separate_process_daemon_core
//   free machine.hosting           : 機械を別プロセスの常駐として立てるときの監督
//                                    (起動・再起動・複数台) の形は未決
//
// 禁じられているのは「核を daemon にすること」であって「常駐として立てること」では
// ない。Host は Machine を **言語内 runtime のまま** 抱えるだけの殻で、外から核へ
// RPC する経路を一切作らない。投入は pin ui.transport_core_in_process のとおり
// in-process の受付列 (Intake) へ、Feed 経由で 1 件 1 行の素データとして入る。
//
// Ruby 側に対応物が無い (gear gem に bin/ も executables も無い)。よってこれは
// 移植ではなく新規であり、Ruby との答え合わせが効かない唯一の面である。
// ==================================================================
import { Err } from '@minamorl/berylx';
import { Machine } from './machine.js';
import { Feed } from './machine/feed.js';
import type { Registry as ProgramRegistry } from './program.js';

export interface HostOptions {
  /** 1 件 1 行の素データが流れてくる読み口。FIFO でも stdin でも良い。 */
  readonly io: NodeJS.ReadableStream;
  /** 走らせられる program。乗客が居なければ空で良い (何も受け付けない機械になる)。 */
  readonly programs: ProgramRegistry;
  /** Machine ledger and per-ticket journals live below this directory when provided. */
  readonly stateDir?: string;
  /** 1 回の drain で処理する上限。null なら受付列が空になるまで。 */
  readonly drainLimit?: number | null;
  /** 進捗の報告先。既定は無音。 */
  readonly report?: (event: HostEvent) => void;
}

export type HostEvent =
  | { readonly kind: 'accepted'; readonly ticket: number }
  | { readonly kind: 'rejected'; readonly line: string; readonly reason: string }
  | {
      readonly kind: 'completed';
      readonly ticket: number;
      /** admission が拒んだか。実行が失敗したのとは別のこと。 */
      readonly denied: boolean;
      /** 走行そのものの結果。ok / err / suspended。 */
      readonly outcome: 'ok' | 'err' | 'suspended';
      /** err のときの理由。常駐は覗けないので、ここを空にしない。 */
      readonly error?: string;
      readonly receipts: number;
      readonly lastTick: number;
    }
  | { readonly kind: 'stopped'; readonly accepted: number; readonly completed: number };

/**
 * 受け取った行を Machine へ投入し、走り終わるまで進める。
 *
 * Feed#absorb は io が閉じるまで返らないので、投入と実行を交互に回す。
 * 走行そのものは Machine が持つ言語内 runtime で、Host は tick を進める側に立たない
 * (進めるのは Machine#drain)。
 */
export class Host {
  readonly machine: Machine;
  readonly #feed: Feed;
  readonly #drainLimit: number | null;
  readonly #report: (event: HostEvent) => void;
  #accepted = 0;
  #completed = 0;
  #stopping = false;

  constructor(options: HostOptions) {
    this.machine = new Machine({ programs: options.programs, stateDir: options.stateDir });
    this.#feed = new Feed({ io: options.io, machine: this.machine });
    this.#drainLimit = options.drainLimit ?? null;
    this.#report = options.report ?? (() => {});
  }

  /** 外から止める。いま走っている分は捨てずに走り切ってから返る。 */
  stop(): void {
    this.#stopping = true;
  }

  /**
   * io が閉じるまで走り続ける。
   *
   * 1 行ずつ吸って、そのつど受付列を空にする。まとめて吸ってからまとめて走らせると、
   * 投入した順と走った順の対応が journal から読み取りにくくなるため。
   */
  async run(): Promise<{ readonly accepted: number; readonly completed: number }> {
    // A previous process may have durably accepted an item before it could pick it up.
    await this.#drain();
    while (!this.#stopping) {
      const before = this.#feed.rejected.length;
      const submissions = await this.#feed.absorb({ limit: 1 });
      for (const rejected of this.#feed.rejected.slice(before)) {
        this.#report({ kind: 'rejected', line: rejected.line, reason: rejected.reason });
      }
      if (submissions.length === 0) break; // io が閉じた
      for (const submission of submissions) {
        this.#accepted += 1;
        this.#report({ kind: 'accepted', ticket: submission.ticket });
      }
      await this.#drain();
    }
    await this.#drain(); // 停止指示の時点で残っていた分を取りこぼさない
    const totals = { accepted: this.#accepted, completed: this.#completed };
    this.#report({ kind: 'stopped', ...totals });
    return totals;
  }

  async #drain(): Promise<void> {
    const completions = await this.machine.drain({ limit: this.#drainLimit });
    for (const completion of completions) {
      this.#completed += 1;
      const outcome = completion.outcome;
      // 「完了した」だけを報告すると、失敗した走行が成功と見分けられなくなる。
      // 常駐は外から覗けないので、結果の別と理由をここで必ず残す。
      const failed = outcome.result instanceof Err;
      this.#report({
        kind: 'completed',
        ticket: completion.ticket,
        denied: Machine.denied(outcome),
        outcome: outcome.suspended ? 'suspended' : failed ? 'err' : 'ok',
        ...(failed ? { error: String((outcome.result as Err).error ?? 'unknown') } : {}),
        receipts: outcome.receipts.length,
        lastTick: outcome.lastTick,
      });
    }
  }
}
