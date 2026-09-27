/**
 * One table of rule-file shapes, read by both sides of the "is this rule
 * already in the prompt?" question: the agent's mention list
 * (tests/shared/ruleFrontmatter.test.ts) and the composer
 * (tests/renderer/composer/mentionModel.test.ts). They used to be hand-synced
 * copies of the same decision; running both against one table is what keeps
 * them from drifting apart again.
 *
 * No imports, so it type-checks under both the node and the web test configs.
 */
export const RULE_APPLY_CASES: readonly { file: string; raw: string; applies: boolean }[] = [
  { file: 'plain.md', raw: 'no frontmatter at all', applies: true },
  { file: 'off.md', raw: '---\nalwaysApply: false\n---\nrequestable', applies: false },
  { file: 'on.md', raw: '---\nalwaysApply: true\n---\nalways', applies: true },
  { file: 'no-flag.md', raw: '---\ndescription: just a note\n---\nbody', applies: true },
  { file: 'empty-flag.md', raw: '---\nalwaysApply:\n---\nbody', applies: true },
  { file: 'yes.md', raw: '---\nalwaysApply: yes\n---\nbody', applies: true },
  { file: 'zero.md', raw: '---\nalwaysApply: 0\n---\nbody', applies: false },
  { file: 'unterminated.md', raw: '---\nalwaysApply: false\nno closing fence', applies: true },
  // The last frontmatter line of a CRLF file keeps its CR; the composer's old
  // line pattern could not match past it and called this rule auto-injected.
  { file: 'crlf-off.md', raw: '---\r\nalwaysApply: false\r\n---\r\nbody', applies: false }
]
