import { existsSync } from 'fs'
import { join } from 'path'
import { atomicWriteFile } from '../storage/atomicWrite'
import { DEFAULT_PLAN_STUB } from '../../shared/planStub'

/** Seed run plan.md with the Goal / Steps / Done when stub when missing. */
export function ensurePlanStub(runDir: string): void {
  const planPath = join(runDir, 'plan.md')
  if (existsSync(planPath)) return
  atomicWriteFile(planPath, DEFAULT_PLAN_STUB)
}
