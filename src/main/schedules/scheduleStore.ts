import { existsSync, readFileSync, renameSync } from 'fs'
import { join } from 'path'
import { TaskScheduleSchema, type TaskSchedule } from '../../shared/ipc'
import { logger } from '../../shared/logger'
import { atomicWriteJson } from '../storage/atomicWrite'
import { userDataRoot } from '../storage/paths'

/**
 * Repeating tasks, one file in userData for every workspace. Written
 * synchronously and whole (tmp + rename), like the task store: the scheduler
 * reads, decides and writes inside one tick, so a launch and the record of it
 * can never be split by an await.
 */
const FILENAME = 'schedules.json'
const VERSION = 1 as const

type SchedulesFile = { version: typeof VERSION; schedules: TaskSchedule[] }

let cache: TaskSchedule[] | null = null

export function schedulesPath(): string {
  return join(userDataRoot(), FILENAME)
}

/** Parse what is on disk; a damaged entry is dropped, a damaged file is set aside. */
export function parseSchedulesFile(raw: unknown): TaskSchedule[] {
  const list = (raw as Partial<SchedulesFile> | null)?.schedules
  if (!Array.isArray(list)) return []
  const schedules: TaskSchedule[] = []
  for (const value of list) {
    const parsed = TaskScheduleSchema.safeParse(value)
    if (parsed.success) schedules.push(parsed.data)
    else logger.warn('Dropped an unreadable schedule', { scope: 'schedules' })
  }
  return schedules
}

function readFromDisk(): TaskSchedule[] {
  const file = schedulesPath()
  if (!existsSync(file)) return []
  try {
    return parseSchedulesFile(JSON.parse(readFileSync(file, 'utf8')))
  } catch (err) {
    logger.warn('Unreadable schedules file; set aside', { scope: 'schedules', code: 'PERSIST', err })
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      /* the next write replaces it anyway */
    }
    return []
  }
}

export function readSchedules(): TaskSchedule[] {
  if (!cache) cache = readFromDisk()
  return cache.map((s) => ({ ...s }))
}

export function writeSchedules(schedules: readonly TaskSchedule[]): void {
  const file: SchedulesFile = { version: VERSION, schedules: schedules.map((s) => ({ ...s })) }
  atomicWriteJson(schedulesPath(), file)
  cache = file.schedules
}

/** Forget the in-memory copy (tests, or a file changed underneath). */
export function resetScheduleStoreCache(): void {
  cache = null
}
