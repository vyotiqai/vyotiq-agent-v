import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getUserName } from '../src/userName.js'
import { greet } from '../src/greeting.js'
import { profileCard } from '../src/profile.js'

test('getUserName prefers the nickname', () => {
  assert.equal(getUserName({ nickname: 'Ace', firstName: 'Ada' }), 'Ace')
})

test('getUserName falls back to the full name, then the email', () => {
  assert.equal(getUserName({ firstName: 'Ada', lastName: 'Lovelace' }), 'Ada Lovelace')
  assert.equal(getUserName({ email: 'ada@example.com' }), 'ada')
})

test('greet and profileCard use the display name', () => {
  assert.equal(greet({ firstName: 'Ada' }), 'Hello, Ada!')
  assert.equal(profileCard({ nickname: 'Ace', role: 'admin' }), 'Ace (admin)')
})
