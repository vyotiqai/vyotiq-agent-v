import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { changedFiles, createChecker, parseCheckArgs, readText, runNode, withWorkspaceCopy } from '../_lib/check-lib.mjs'

const { workspace, repo } = parseCheckArgs()
const c = createChecker()

const EXPECTED = {
  count: 5,
  totalCents: 199 + 450 + 1299 + 1250 + 3499,
  skus: ['ABC-001', 'ABC-002', 'BCD-010', 'BCD-011', 'CDE-100']
}

function parse(text) {
  try {
    return JSON.parse(text ?? '')
  } catch {
    return null
  }
}

const script = changedFiles(workspace, repo, 'scripts', { allowAdded: false })
c.check('scripts/build.mjs unchanged', script.length === 0, script.join(', '))

const products = parse(readText(join(workspace, 'data', 'products.json')))
const refill = Array.isArray(products) ? products.find((p) => p?.sku === 'BCD-011') : null
c.check('data/products.json parses with all five products', Array.isArray(products) && products.length === 5)
c.check('BCD-011 priced at 1250 cents', refill?.priceCents === 1250, `BCD-011: ${JSON.stringify(refill)}`)

const built = parse(readText(join(workspace, 'dist', 'catalog.json')))
c.check('dist/catalog.json is the expected catalog', JSON.stringify(built) === JSON.stringify(EXPECTED), `got ${JSON.stringify(built)}`)

const rebuilt = withWorkspaceCopy(
  workspace,
  (dir) => rmSync(join(dir, 'dist'), { recursive: true, force: true }),
  (dir) => {
    const run = runNode(dir, ['scripts/build.mjs'])
    return { run, catalog: parse(readText(join(dir, 'dist', 'catalog.json'))) }
  }
)
c.check(
  'a clean rebuild succeeds with the same catalog',
  rebuilt.run.ok && JSON.stringify(rebuilt.catalog) === JSON.stringify(EXPECTED),
  rebuilt.run.output
)

c.finish()
