export interface CiRun {
  databaseId: number
  status: string
  conclusion: string
  event: string
  url: string
}

export type CiVerdict =
  | { kind: 'pass'; run: CiRun }
  | { kind: 'wait'; reason: string }
  | { kind: 'fail'; reason: string }

export function ciVerdict(runs: CiRun[], opts: { noRunExpired: boolean }): CiVerdict
