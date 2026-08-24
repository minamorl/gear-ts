import { exec } from 'node:child_process';
import { z } from 'zod';
import { Adapter } from './core.js';

export const SHELL_RUN_TAG = 'shell_run' as const;
export const ShellPayload = z.object({ cmd: z.string() });
export const ShellResult = z.object({
  exit_status: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
});

export type ShellPayload = z.infer<typeof ShellPayload>;
export type ShellResult = z.infer<typeof ShellResult>;

function perform(payload: ShellPayload): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    exec(payload.cmd, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ exit_status: 0, stdout, stderr });
        return;
      }
      if (typeof error.code === 'number') {
        resolve({ exit_status: error.code, stdout, stderr });
        return;
      }
      reject(error);
    });
  });
}

export function buildShellAdapter(): Adapter {
  return new Adapter('shell').asyncOperation(SHELL_RUN_TAG, ShellPayload, ShellResult, perform);
}

export const ShellAdapter = buildShellAdapter();
export const Shell = Object.freeze({
  TAG: SHELL_RUN_TAG,
  PAYLOAD: ShellPayload,
  RESULT: ShellResult,
  build: buildShellAdapter,
  ADAPTER: ShellAdapter,
});
