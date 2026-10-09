/**
 * @vitest-environment jsdom
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { renderMermaid, repairMermaid } from '@renderer/lib/markdown/mermaidRepair'

type Mermaid = (typeof import('mermaid'))['default']
let mermaid: Mermaid

beforeAll(async () => {
  mermaid = (await import('mermaid')).default
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })
})

async function parses(source: string): Promise<boolean> {
  try {
    await mermaid.parse(source)
    return true
  } catch {
    return false
  }
}

/** Run 8a71e5dd's "Architecture map", as the model wrote it (2026-10-08). */
const RUN_DIAGRAM = `flowchart TD
  UI["AppShell → ChatView → ChatPaneHost → SessionChatColumn → TaskPane"]
  CTRL["createChatStreamController (owns items, itemsRevision)"]
  UWM["useWorkspaceManager (2,920 lines — state hub)"]
  Q[("runDir: messages.jsonl, events.jsonl,<br/>status.json, loopCheckpoint.json")]
  UI --> CTRL  UWM --> CTRL
  UI --> Q
  CTRL --> Q`

describe('repairMermaid', () => {
  it('draws the run whose two edges shared a line', async () => {
    expect(await parses(RUN_DIAGRAM)).toBe(false)
    const fixed = repairMermaid(RUN_DIAGRAM)
    expect(fixed).toContain('  UI --> CTRL\n  UWM --> CTRL')
    expect(await parses(fixed)).toBe(true)
  })

  it.each([
    ['two edges on a line', 'flowchart TD\n  A --> B  C --> D', 'flowchart TD\n  A --> B\n  C --> D'],
    ['two nodes on a line', 'flowchart TD\n  A["x"]  B["y"]\n  A --> B', 'flowchart TD\n  A["x"]\n  B["y"]\n  A --> B'],
    ['brackets in a label', 'flowchart TD\n  A[loop.ts (runAgent)] --> B', 'flowchart TD\n  A["loop.ts (runAgent)"] --> B'],
    ['brackets in an edge label', 'graph LR\n  A -->|calls (x)| B', 'graph LR\n  A -->|"calls (x)"| B'],
    ['braces in a label', 'flowchart TD\n  A[obj {a}] --> B', 'flowchart TD\n  A["obj {a}"] --> B'],
    ['a scoped package', 'flowchart TD\n  A[@scope/pkg] --> B', 'flowchart TD\n  A["@scope/pkg"] --> B'],
    ['end as a node', 'flowchart TD\n  start --> end', 'flowchart TD\n  start --> End']
  ])('repairs %s', async (_name, source, expected) => {
    expect(await parses(source)).toBe(false)
    expect(repairMermaid(source)).toBe(expected)
    expect(await parses(expected)).toBe(true)
  })

  it.each([
    ['spaced arrows', 'flowchart TD\n  A  -->  B'],
    ['a text link', 'flowchart TD\n  A -- some  words --> B'],
    ['shapes of their own', 'flowchart TD\n  Q[("db (x)")] --> C(("hub"))\n  D{{"hex"}} --> E[/"in"/]'],
    ['a subgraph', 'flowchart TD\n  subgraph Main process\n    A --> B\n  end\n  B --> C'],
    ['names that only start or end with end', 'flowchart TD\n  endpoint --> send\n  x-end --> endgame'],
    ['quoted labels', 'flowchart TD\n  A["say (hi) @x"] -->|"via (y)"| B'],
    ['styles and classes', 'flowchart TD\n  A --> B\n  classDef hot fill:#f00\n  class A hot\n  style B stroke:#333']
  ])('leaves %s as written', async (_name, source) => {
    expect(repairMermaid(source)).toBe(source)
    expect(await parses(source)).toBe(true)
  })

  it('leaves other diagram kinds alone', () => {
    const seq = 'sequenceDiagram\n  A->>B: call (x)  B->>A: ok'
    expect(repairMermaid(seq)).toBe(seq)
  })
})

describe('renderMermaid', () => {
  /** What mermaid leaves in the body when a render throws part-way. */
  function stray(id: string): void {
    const el = document.createElement('div')
    el.id = `d${id}`
    document.body.append(el)
  }

  it('draws the repair when the source as written fails, and clears the first try', async () => {
    const render = vi.fn(async (id: string, text: string) => {
      if (text.includes('B  C')) {
        stray(id)
        throw new Error('Parse error')
      }
      return { svg: `<svg data-id="${id}"></svg>` }
    })
    const drawn = await renderMermaid({ render }, 'm1', 'flowchart TD\n  A --> B  C --> D')
    expect(drawn.svg).toContain('m1-r')
    expect(render).toHaveBeenLastCalledWith('m1-r', 'flowchart TD\n  A --> B\n  C --> D')
    expect(document.getElementById('dm1')).toBeNull()
  })

  it('rejects with the first error when there is nothing to repair', async () => {
    const render = vi.fn(async () => {
      throw new Error('first')
    })
    await expect(renderMermaid({ render }, 'm2', 'flowchart TD\n  A --> ')).rejects.toThrow('first')
    expect(render).toHaveBeenCalledTimes(1)
  })

  it('rejects with the first error when the repair fails too, leaving no strays', async () => {
    let n = 0
    const render = vi.fn(async (id: string) => {
      stray(id)
      throw new Error(n++ === 0 ? 'first' : 'second')
    })
    await expect(renderMermaid({ render }, 'm3', 'flowchart TD\n  A[x (y)] --> B')).rejects.toThrow('first')
    expect(render).toHaveBeenCalledTimes(2)
    expect(document.getElementById('dm3')).toBeNull()
    expect(document.getElementById('dm3-r')).toBeNull()
  })
})
