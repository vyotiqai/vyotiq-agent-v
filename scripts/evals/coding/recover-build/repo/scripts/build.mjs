// Build dist/catalog.json from data/products.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'data', 'products.json')

let products
try {
  products = JSON.parse(readFileSync(source, 'utf8'))
} catch (err) {
  console.error(`build: data/products.json is not valid JSON: ${err.message}`)
  process.exit(1)
}

const problems = []
products.forEach((p, i) => {
  if (!/^[A-Z]{3}-\d{3}$/.test(p.sku ?? '')) problems.push(`products[${i}].sku must look like ABC-123`)
  if (typeof p.name !== 'string' || !p.name.trim()) problems.push(`products[${i}].name must be a non-empty string`)
  if (!Number.isInteger(p.priceCents) || p.priceCents < 0) {
    problems.push(`products[${i}].priceCents must be a non-negative integer number of cents (got ${JSON.stringify(p.priceCents)})`)
  }
})
if (problems.length > 0) {
  console.error(`build: invalid products:\n  ${problems.join('\n  ')}`)
  process.exit(1)
}

const catalog = {
  count: products.length,
  totalCents: products.reduce((sum, p) => sum + p.priceCents, 0),
  skus: products.map((p) => p.sku).sort()
}
mkdirSync(join(root, 'dist'), { recursive: true })
writeFileSync(join(root, 'dist', 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`)
console.log(`build: wrote dist/catalog.json (${catalog.count} products)`)
