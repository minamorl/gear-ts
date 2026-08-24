declare module 'node:crypto' {
  interface Hash {
    update(data: string): Hash;
    digest(encoding: 'hex'): string;
  }
  export function createHash(algorithm: string): Hash;
}

declare module 'node:child_process' {
  interface ExecError extends Error {
    readonly code?: number | string | null;
  }
  export function exec(
    command: string,
    options: { readonly encoding: 'utf8' },
    callback: (error: ExecError | null, stdout: string, stderr: string) => void,
  ): unknown;
}
