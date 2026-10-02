import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getDisplayName } from '../src/displayName.js'
import { greet } from '../src/greeting.js'
import { profileCard } from '../src/profile.js'

test('getDisplayName prefers the nickname', () => {
  assert.equal(getDisplayName({ nickname: 'Ace', firstName: 'Ada' }), 'Ace')
})

test('getDisplayName falls back to the full name, then the email', () => {
  assert.equal(getDisplayName({ firstName: 'Ada', lastName: 'Lovelace' }), 'Ada Lovelace')
  assert.equal(getDisplayName({ email: 'ada@example.com' }), 'ada')
})

test('greet and profileCard use the display name', () => {
  assert.equal(greet({ firstName: 'Ada' }), 'Hello, Ada!')
  assert.equal(profileCard({ nickname: 'Ace', role: 'admin' }), 'Ace (admin)')
})
