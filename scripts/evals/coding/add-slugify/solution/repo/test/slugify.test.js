import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slugify } from '../src/strings.js'

test('slugify collapses punctuation and whitespace runs', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world')
  assert.equal(slugify('A  B'), 'a-b')
})

test('slugify trims leading and trailing dashes', () => {
  assert.equal(slugify('--x--'), 'x')
  assert.equal(slugify('!!!'), '')
})
