import { describe, expect, it } from 'vitest'
import { buildCommitPrompt, historyIsConventional, parseGeneratedCommitMessage } from '@main/git/commitMessage'
import type { CommitChangeFile } from '@main/git/git'

function file(path: string, diffChars: number, over: Partial<CommitChangeFile> = {}): CommitChangeFile {
  const lines = Array.from({ length: Math.ceil(diffChars / 20) }, (_, i) => `+line ${i} of ${path}`.padEnd(19, '.'))
  return {
    path,
    kind: 'modified',
    added: lines.length,
    removed: 0,
    binary: false,
    untracked: false,
    diff: `diff --git a/${path} b/${path}\n${lines.join('\n')}`,
    ...over
  }
}

describe('commit message prompt', () => {
  it('lists every file and shares the diff budget so one huge file cannot hide the rest', () => {
    const files = [file('src/huge.ts', 500_000), ...Array.from({ length: 30 }, (_, i) => file(`src/small${i}.ts`, 400))]
    const prompt = String(buildCommitPrompt(files, 'feat(app): earlier').content)
    expect(prompt).toContain('31 files: 0 new, 31 modified, 0 deleted')
    for (let i = 0; i < 30; i++) {
      expect(prompt).toContain(`M src/small${i}.ts`)
      // Each small file's diff is there whole.
      expect(prompt).toContain(`diff --git a/src/small${i}.ts`)
    }
    expect(prompt).toContain('diff --git a/src/huge.ts')
    expect(prompt).toMatch(/more diff lines in this file/)
    expect(prompt).toContain('(Diffs of 31 of 31 files, longer ones cut short; the file list above is complete.)')
    expect(prompt.length).toBeLessThan(60_000)
  })

  it('lists lockfiles and binaries without spending the diff on them', () => {
    const prompt = String(
      buildCommitPrompt(
        [
          file('pnpm-lock.yaml', 30_000),
          file('logo.png', 0, { binary: true, diff: null }),
          file('src/a.ts', 200, { kind: 'added', untracked: true })
        ],
        ''
      ).content
    )
    expect(prompt).toContain('M pnpm-lock.yaml (+1500 -0; lockfile or generated)')
    expect(prompt).not.toContain('diff --git a/pnpm-lock.yaml')
    expect(prompt).toContain('M logo.png (binary)')
    expect(prompt).toContain('A src/a.ts (+10 -0; new, untracked)')
    expect(prompt).toContain('diff --git a/src/a.ts')
    expect(prompt).toContain('<recent-commit-subjects>\n(none)')
  })

  it('names the rest of a very large change set by count', () => {
    const files = Array.from({ length: 450 }, (_, i) => file(`f${String(i).padStart(3, '0')}.ts`, 40))
    const prompt = String(buildCommitPrompt(files, '').content)
    expect(prompt).toContain('… and 50 more files')
    expect(prompt).toContain('(Diffs of 60 of 450 files')
  })
})

describe('commit message generation', () => {
  it('accepts a conventional subject from a fenced model response', () => {
    expect(parseGeneratedCommitMessage('```text\nfeat(cli): add shell tools\n```')).toBe(
      'feat(cli): add shell tools'
    )
  })

  it('rejects vague file-count and placeholder suggestions', () => {
    expect(parseGeneratedCommitMessage('Update 11 files')).toBeNull()
    expect(parseGeneratedCommitMessage('chore: update 11 files')).toBeNull()
    expect(parseGeneratedCommitMessage('WIP')).toBeNull()
    expect(parseGeneratedCommitMessage('fix')).toBeNull()
    expect(parseGeneratedCommitMessage('fix: fix')).toBeNull()
  })

  it('normalizes a useful plain-language response into a conventional subject', () => {
    // The verb that only repeats the type goes ("fix: Fix add() in math.js"
    // was seen in the app, 2026-10-09); a capitalized first word is lowered.
    expect(parseGeneratedCommitMessage('Fix the shell tool exit handling')).toBe(
      'fix: the shell tool exit handling'
    )
    expect(parseGeneratedCommitMessage('Fixes add() in math.js')).toBe('fix: add() in math.js')
    expect(parseGeneratedCommitMessage('Add a retry to the fetch tool')).toBe('feat: add a retry to the fetch tool')
    expect(parseGeneratedCommitMessage('README covers the sandbox now')).toBe('docs: README covers the sandbox now')
  })

  it('keeps a plain subject plain in a repository that does not use Conventional Commits', () => {
    expect(parseGeneratedCommitMessage('Fix add() in math.js', false)).toBe('Fix add() in math.js')
    // A conventional answer is still the model's choice there.
    expect(parseGeneratedCommitMessage('fix: handle empty input', false)).toBe('fix: handle empty input')
  })

  it('reads the house style from the recent subjects and names it in the prompt', () => {
    expect(historyIsConventional('')).toBe(true)
    expect(historyIsConventional('feat(app): one\nfix: two\nUpdate readme')).toBe(true)
    expect(historyIsConventional('Add login\nFix crash on start\nchore: bump deps')).toBe(false)
    const plain = String(buildCommitPrompt([], 'Add login\nFix crash on start').content)
    expect(plain).toContain('does not use Conventional Commits')
    const conventional = String(buildCommitPrompt([], 'feat(app): earlier').content)
    expect(conventional).toContain('Subject form: Conventional Commits')
  })

  it('drops a preamble before the subject and keeps the body after it', () => {
    expect(
      parseGeneratedCommitMessage(
        'Here is the suggested commit message:\n\nrefactor(tools): share shell execution helpers\n\nThis keeps the tools consistent.'
      )
    ).toBe('refactor(tools): share shell execution helpers\n\nThis keeps the tools consistent.')
  })

  it('keeps a bulleted body, as "- " bullets wrapped at 72, without closing remarks', () => {
    const message = parseGeneratedCommitMessage(
      [
        '```',
        'feat(git): read every changed file when drafting a commit message.',
        '',
        '* list all files with their line counts, so a large change set is described as a whole and not by the few files that fit',
        '• skip lockfiles in the diff budget',
        '',
        '```',
        'Let me know if you want a shorter version.'
      ].join('\n')
    )
    expect(message).toBe(
      [
        'feat(git): read every changed file when drafting a commit message',
        '',
        '- list all files with their line counts, so a large change set is',
        '  described as a whole and not by the few files that fit',
        '- skip lockfiles in the diff budget'
      ].join('\n')
    )
    for (const line of message!.split('\n')) expect(line.length).toBeLessThanOrEqual(72)
  })

  it('rejoins bullets the model wrapped itself before wrapping them once (mimo-v2.6-flash, 2026-10-08)', () => {
    const message = parseGeneratedCommitMessage(
      [
        'feat(app): add reply renderer and thread mockups',
        '',
        '- add a streaming reply renderer for the record with block splitting, code,',
        '  mermaid repair and workspace path chips',
        '- let appearance settings take a numeric font scale from 0.85 to 2.0'
      ].join('\n')
    )
    expect(message).toBe(
      [
        'feat(app): add reply renderer and thread mockups',
        '',
        '- add a streaming reply renderer for the record with block splitting,',
        '  code, mermaid repair and workspace path chips',
        '- let appearance settings take a numeric font scale from 0.85 to 2.0'
      ].join('\n')
    )
  })

  it('cuts an overlong subject without leaving it on "and" or a comma', () => {
    // The shape mimo-v2.6-flash returned on this repository: a subject past 72.
    const subject = parseGeneratedCommitMessage(
      'feat(app): reply renderer, thread mockups, numeric font scale and git tooling for PRs'
    )!
    expect(subject.length).toBeLessThanOrEqual(72)
    expect(subject).toBe('feat(app): reply renderer, thread mockups, numeric font scale')
    // Exactly 72 stays whole.
    expect(parseGeneratedCommitMessage(`fix: ${'a'.repeat(65)} b`)).toBe(`fix: ${'a'.repeat(65)} b`)
  })

  it('caps a long body at a bullet boundary', () => {
    const bullets = Array.from({ length: 20 }, (_, i) => `- change number ${i + 1}`)
    const message = parseGeneratedCommitMessage(['fix(app): many things', '', ...bullets].join('\n'))!
    const body = message.split('\n\n')[1]!.split('\n')
    expect(body).toHaveLength(14)
    expect(body.every((line) => line.startsWith('- '))).toBe(true)
  })

  it('drops a body that only repeats the subject', () => {
    expect(parseGeneratedCommitMessage('fix(app): stop the crash\n\nfix(app): stop the crash')).toBe('fix(app): stop the crash')
  })

  it('keeps generated subjects within the review-friendly length limit', () => {
    const result = parseGeneratedCommitMessage(
      'feat: add a deliberately long but still meaningful change description that should be shortened safely'
    )
    expect(result).toBeTruthy()
    expect(result!.length).toBeLessThanOrEqual(72)
  })
})
