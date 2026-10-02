import { join } from 'node:path'
import { changedFiles, createChecker, parseCheckArgs, readText, runHiddenTests, runNodeTest } from '../_lib/check-lib.mjs'

const { workspace, fixture, repo } = parseCheckArgs()
const c = createChecker()

const hidden = runHiddenTests(fixture, workspace)
c.check('behaviour identical + applyDiscount exported', hidden.ok, hidden.output)

const source = readText(join(workspace, 'src', 'pricing.js')) ?? ''
const rounds = source.match(/Math\.round\(/g)?.length ?? 0
c.check('rounding logic appears once', rounds === 1, `Math.round( appears ${rounds} times`)

const callers = ['priceForStudent', 'priceForSenior', 'priceForMember'].filter((name) => {
  // The declaration (function or const arrow) up to the next top-level statement.
  const decl = new RegExp(`(?:function\\s+${name}\\b|\\b${name}\\s*=)[\\s\\S]*?(?=\\n(?:export|function|const|let|var)\\b|$)`)
  const body = source.match(decl)?.[0] ?? ''
  return !/applyDiscount\(/.test(body)
})
c.check('each price function calls applyDiscount', callers.length === 0, `not calling it: ${callers.join(', ')}`)

const suite = runNodeTest(workspace)
c.check('node --test passes', suite.ok, suite.output)

const touched = changedFiles(workspace, repo, 'test', { allowAdded: true })
c.check('existing tests unchanged', touched.length === 0, touched.join(', '))

c.finish()
