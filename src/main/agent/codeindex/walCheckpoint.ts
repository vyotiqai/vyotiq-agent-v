import { Worker } from 'node:worker_threads'

/**
 * Runs in the worker: its own connection copies the WAL back into the
 * database and fsyncs it, then closes. PASSIVE, so it never waits on the main
 * thread's connection; there is nothing to wait on anyway, since callers
 * await it with nothing else writing.
 */
const WORKER_SOURCE = `
const { DatabaseSync } = require('node:sqlite')
const { parentPort, workerData } = require('node:worker_threads')
let db
try {
  db = new DatabaseSync(workerData)
  db.exec('PRAGMA busy_timeout = 5000')
  db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()
  parentPort.postMessage(true)
} catch {
  parentPort.postMessage(false)
} finally {
  try { db && db.close() } catch {}
}
`

/** Checkpoint `dbPath` from a worker thread; false when the worker could not. */
export function checkpointInWorker(dbPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let worker: Worker
    try {
      worker = new Worker(WORKER_SOURCE, { eval: true, workerData: dbPath })
    } catch {
      resolve(false)
      return
    }
    worker.once('message', (ok: unknown) => resolve(ok === true))
    worker.once('error', () => resolve(false))
    worker.once('exit', () => resolve(false))
  })
}
