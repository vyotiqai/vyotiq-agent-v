import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'

const userData = join(tmpdir(), `vyotiq-dlgasm-user-${process.pid}-${Date.now()}`)
const appPath = join(tmpdir(), `vyotiq-dlgasm-app-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    },
    getAppPath: () => appPath,
    isPackaged: false
  }
}))

import { loadHarness } from '@main/agent/harness'
import { modeSectionMarkdown } from '@main/agent/tools/modePolicy'
import { AGENT_TOOLS } from '@main/agent/schemas/tools'

/** Repo file that ships as the bundled harness — packaging copies it verbatim. */
const REPO_HARNESS = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  '..',
  'resources',
  'harness',
  'default.md'
)

/**
 * The root Agent-mode system prompt is assembled from three surfaces
 * (harness spine + mode section + tool catalog). Delegation guidance only
 * reaches the model if ALL THREE carry it — this pins the combined seam.
 */
describe('delegation prompt assembly (harness + mode section + catalog)', () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-dlgasm-ws-'))
    mkdirSync(join(appPath, 'resources', 'harness'), { recursive: true })
    // Bundle the REAL canonical harness (what packaging ships), not a stub.
    writeFileSync(join(appPath, 'resources', 'harness', 'default.md'), readFileSync(REPO_HARNESS), 'utf8')
    mkdirSync(userData, { recursive: true })
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(userData, { recursive: true, force: true })
    rmSync(appPath, { recursive: true, force: true })
  })

  it('root Agent run: every surface carries the delegation policy', () => {
    const prompt = [loadHarness(workspace), modeSectionMarkdown('agent', { autoModeSwitch: true })]
      .filter(Boolean)
      .join('\n')

    // Harness spine: delegation decision + brief contract.
    expect(prompt).toMatch(/Delegate independent, self-contained workstreams to child agent instances/)
    expect(prompt).toMatch(/child sees nothing of this conversation/)

    // Mode section (root, not inline): default-on decompose trigger + anti-overuse balance.
    expect(prompt).toMatch(/decompose the plan into a structured set/)
    expect(prompt).toMatch(/every single time/)
    expect(prompt).toMatch(/batch independent tool calls within a step first/i)

    // Catalog: the five instance tools with operational lifecycle text.
    const names = AGENT_TOOLS.map((t) => t.name)
    for (const name of [
      'spawn_agent_instance',
      'await_agent_instance',
      'pull_agent_instance',
      'merge_agent_instance',
      'cancel_agent_instance'
    ]) {
      expect(names, `${name} in catalog`).toContain(name)
    }
    const spawn = AGENT_TOOLS.find((t) => t.name === 'spawn_agent_instance')
    expect(spawn!.description).toMatch(/independent workstream/i)
    expect(spawn!.description).toMatch(/child never sees this conversation/i)
  })

  it('inline instance run: harness spine present, parent-only policy absent', () => {
    const prompt = [
      loadHarness(workspace),
      modeSectionMarkdown('agent', { autoModeSwitch: true, inlineInstance: true })
    ]
      .filter(Boolean)
      .join('\n')

    // Children still get the generic workstream-brief principle from the spine…
    expect(prompt).toMatch(/Delegate independent, self-contained workstreams/)
    // …but no parent-only delegation trigger or instance lifecycle.
    expect(prompt).not.toMatch(/decompose the plan into a structured set/)
    expect(prompt).not.toMatch(/spawn_agent_instance/)
    expect(prompt).not.toMatch(/merge_agent_instance/)
  })
})
