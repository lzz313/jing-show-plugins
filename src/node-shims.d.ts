// The Orca worker runs on Node, but the plugin's type roots do not include
// @types/node. Declare only the small surface src/worker.ts and its tests use.
declare module 'node:fs/promises' {
  export function readFile(path: string, encoding: 'utf8'): Promise<string>
  export function writeFile(path: string, data: string): Promise<void>
  export function mkdir(path: string): Promise<void>
  export function mkdtemp(prefix: string): Promise<string>
  export function rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void>
}

declare module 'node:os' {
  export function homedir(): string
  export function tmpdir(): string
}

declare module 'node:path' {
  export function join(...parts: string[]): string
}

declare const process: {
  env: Record<string, string | undefined>
}
