import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const mod = await import(pathToFileURL(join(process.env.EVAL_WORKSPACE, 'src/strings.js')).href)

test('slugify is exported', () => {
  assert.equal(typeof mod.slugify, 'function')
})

test('slugify spec', () => {
  const { slugify } = mod
  assert.equal(slugify('Hello, World!'), 'hello-world')
  assert.equal(slugify('  --Already--slugged--  '), 'already-slugged')
  assert.equal(slugify('A  B\tC'), 'a-b-c')
  assert.equal(slugify('Version 2.0 Release'), 'version-2-0-release')
  assert.equal(slugify('!!!'), '')
  assert.equal(slugify(''), '')
})

test('existing helpers still work', () => {
  assert.equal(mod.capitalize('abc'), 'Abc')
  assert.equal(mod.truncate('abcdef', 4), 'abc…')
})
