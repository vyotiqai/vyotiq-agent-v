export const CONFIGS: string[]

export function parseTscErrors(output: string): { byFile: Map<string, string[]>; syntax: string[] }

export function regressions(
  byFile: Map<string, string[]>,
  baseline: Record<string, number>
): Array<{ file: string; allowed: number; count: number; lines: string[] }>
