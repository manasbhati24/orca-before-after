// Type-check only: the few Node built-ins src/worker.ts uses. Orca runs the worker in Node, so the
// real modules exist at runtime; this saves installing @types/node for `npx tsc -p .`.
declare module 'node:fs/promises' {
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>
  export function readFile(path: string, encoding: 'utf8'): Promise<string>
  export function readdir(path: string): Promise<string[]>
  export function rename(from: string, to: string): Promise<void>
  export function rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void>
  export function stat(path: string): Promise<{ mtimeMs: number; isFile(): boolean }>
  export function unlink(path: string): Promise<void>
  export function writeFile(path: string, data: string | Uint8Array): Promise<void>
  export function mkdtemp(prefix: string): Promise<string>
}
declare module 'node:path' {
  export function dirname(path: string): string
  export function join(...parts: string[]): string
  export function resolve(...parts: string[]): string
}
declare module 'node:url' {
  export function fileURLToPath(url: string): string
}
declare module 'node:os' {
  export function tmpdir(): string
}
declare const process: { env: Record<string, string | undefined> }
declare const Buffer: { from(data: string, encoding: 'base64'): Uint8Array }
