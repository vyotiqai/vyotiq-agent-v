import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ws = process.env.EVAL_WORKSPACE
const load = (rel) => import(pathToFileURL(join(ws, rel)).href)

test('getDisplayName keeps the behaviour', async () => {
  const { getDisplayName } = await load('src/displayName.js')
  assert.equal(getDisplayName({ nickname: 'Ace' }), 'Ace')
  assert.equal(getDisplayName({ firstName: 'Grace', lastName: 'Hopper' }), 'Grace Hopper')
  assert.equal(getDisplayName({ lastName: 'Hopper' }), 'Hopper')
  assert.equal(getDisplayName({ email: 'gh@navy.mil' }), 'gh')
  assert.equal(getDisplayName({}), 'anonymous')
})

test('callers still work', async () => {
  const { greet } = await load('src/greeting.js')
  const { profileCard } = await load('src/profile.js')
  assert.equal(greet({ email: 'x@y.z' }), 'Hello, x!')
  assert.equal(profileCard({ firstName: 'Grace' }), 'Grace (member)')
})
