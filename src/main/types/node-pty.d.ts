declare module 'node-pty' {
  export interface IPty {
    readonly pid: number
    write(data: string): void
    resize(cols: number, rows: number): void
    kill(): void
    onData(callback: (data: string) => void): void
    onExit(callback: (e: { exitCode: number }) => void): void
  }
  export function spawn(
    file: string,
    args: string[],
    options: {
      name?: string
      cols?: number
      rows?: number
      cwd?: string
      env?: Record<string, string>
    }
  ): IPty
}
