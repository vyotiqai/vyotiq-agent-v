import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { toolConceptSearch } from '@main/agent/tools/conceptSearch'
import { CodeIndexStore } from '@main/agent/codeindex/store'
import { codeindexDbPath } from '@main/agent/codeindex/store'
import { runDenseVectorization, type DenseEmbedder } from '@main/agent/codeindex/denseJob'
import { EMBED_DIM } from '@main/agent/codeindex/embed/embedModels'

const TOKEN_DIM: Record<string, number> = { alpha: 0, beta: 1, gamma: 2, delta: 3 }

function stubEmbedder(): DenseEmbedder {
  return async (texts) =>
    texts.map((text) => {
      const vec = new Float32Array(EMBED_DIM)
      let norm = 0
      for (const [token, dim] of Object.entries(TOKEN_DIM)) {
        if (text.includes(token)) {
          vec[dim] = 1
          norm += 1
        }
      }
      if (norm > 0) {
        for (let d = 0; d < 4; d++) vec[d] = vec[d]! / norm
      } else {
        vec[3] = 1
      }
      return vec
    })
}

const dirs: string[] = []
function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vy-concept-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs) {
    CodeIndexStore.openDbPath(codeindexDbPath(dir)).close()
    rmSync(dir, { recursive: true, force: true })
  }
  dirs.length = 0
})

function seed(workspace: string): void {
  const store = CodeIndexStore.openDbPath(codeindexDbPath(workspace))
  try {
    for (const [path, name, text] of [
      ['src/alpha.ts', 'alphaFn', 'alpha handling'],
      ['src/beta.ts', 'betaFn', 'beta handling'],
      ['src/mix.ts', 'mixFn', 'alpha beta handling']
    ] as const) {
      store.replaceFileChunks(path, `hash-${path}`, 1, 100, [
        {
          startLine: 1,
          endLine: 4,
          kind: 'function',
          name,
          ftsBody: `${name}\n${text}`,
          text
        }
      ])
    }
  } finally {
    store.close()
  }
}

describe('toolConceptSearch', () => {
  it('degrades with an explicit message on an empty index', async () => {
    const workspace = makeWorkspace()
    const out = await toolConceptSearch(workspace, 'anything')
    expect(out).toContain('Concept index is empty')
  })

  it('degrades with an explicit message while the index is still cold', async () => {
    const workspace = makeWorkspace()
    seed(workspace)
    const out = await toolConceptSearch(workspace, 'anything')
    expect(out).toContain('still embedding')
  })

  it('returns dense-ranked hits with a header once vectors are embedded', async () => {
    const workspace = makeWorkspace()
    seed(workspace)
    const store = CodeIndexStore.openDbPath(codeindexDbPath(workspace))
    try {
      await runDenseVectorization(store, { embed: stubEmbedder() })
    } finally {
      store.close()
    }
    const out = await toolConceptSearch(workspace, 'alpha', { embed: stubEmbedder() })
    expect(out).toMatch(/hits=\d+ \(dense\)/)
    expect(out).toContain('src/alpha.ts')
    expect(out.indexOf('src/alpha.ts')).toBeLessThan(out.indexOf('src/beta.ts'))
  })

  it('maps embedder failures to an actionable message', async () => {
    const workspace = makeWorkspace()
    seed(workspace)
    const store = CodeIndexStore.openDbPath(codeindexDbPath(workspace))
    try {
      await runDenseVectorization(store, { embed: stubEmbedder() })
    } finally {
      store.close()
    }
    const out = await toolConceptSearch(workspace, 'alpha', {
      embed: async () => {
        throw new Error('Embedding worker exited')
      }
    })
    expect(out).toContain('concept_search unavailable: Embedding worker exited')
  })

  it('rejects empty queries', async () => {
    await expect(toolConceptSearch(makeWorkspace(), '   ')).rejects.toThrow(/query is required/)
  })
})