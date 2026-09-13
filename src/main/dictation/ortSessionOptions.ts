/**
 * ORT session caps for desktop background embedding.
 */

export type OrtSessionOptions = {
  intraOpNumThreads: number
  interOpNumThreads: number
  executionMode: 'sequential'
}

export type OrtThreadContext = 'in-process' | 'utility'

/** UtilityProcess budget — enough for Whisper ingest without taking every core. */
const UTILITY_INTRA_OP_DEFAULT = 4

/**
 * In-process stays at 1 (UI freeze guard / Vitest).
 * Utility: default 4, env clamp 1–8.
 */
export function resolveOrtIntraOpThreads(
  envValue: string | undefined = process.env.VYOTIQ_ORT_INTRA_OP_THREADS,
  context: OrtThreadContext = 'in-process',
  _cpuCount?: number
): number {
  if (context === 'in-process') return 1
  const n = Number(envValue)
  if (!Number.isFinite(n) || n < 1) return UTILITY_INTRA_OP_DEFAULT
  return Math.min(8, Math.max(1, Math.floor(n)))
}

export function buildOrtSessionOptions(
  envValue?: string,
  context: OrtThreadContext = 'in-process',
  cpuCount?: number
): OrtSessionOptions & Record<string, unknown> {
  const intra = resolveOrtIntraOpThreads(envValue, context, cpuCount)
  return {
    intraOpNumThreads: intra,
    interOpNumThreads: 1,
    executionMode: 'sequential',
    enableCpuMemArena: false,
    enableMemPattern: false,
    'session.intra_op.allow_spinning': '0'
  }
}

/** Apply process-level ORT/OpenMP hints before loading native bindings. */
export function applyOrtThreadEnvHints(
  intraOpThreads = resolveOrtIntraOpThreads()
): void {
  const n = String(intraOpThreads)
  if (!process.env.OMP_NUM_THREADS) process.env.OMP_NUM_THREADS = n
  if (!process.env.ORT_INTRA_OP_NUM_THREADS) process.env.ORT_INTRA_OP_NUM_THREADS = n
  if (!process.env.ORT_INTER_OP_NUM_THREADS) process.env.ORT_INTER_OP_NUM_THREADS = '1'
}
