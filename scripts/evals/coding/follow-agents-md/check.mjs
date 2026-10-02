import { join } from 'node:path'
import { createChecker, parseCheckArgs, readText, runHiddenTests, runNodeTest } from '../_lib/check-lib.mjs'

const { workspace, fixture } = parseCheckArgs()
const c = createChecker()

const hidden = runHiddenTests(fixture, workspace)
c.check('clamp correct and re-exported from src/index.js', hidden.ok, hidden.output)

const changelog = readText(join(workspace, 'CHANGELOG.md')) ?? ''
const unreleased = changelog.split(/^## Unreleased[^\n]*\n/m)[1]?.split(/^## /m)[0] ?? ''
c.check(
  'CHANGELOG.md has a `- clamp:` bullet under Unreleased',
  /^- clamp:\s*\S/m.test(unreleased),
  `Unreleased section: ${JSON.stringify(unreleased.trim().slice(0, 300))}`
)
c.check('CHANGELOG.md keeps the 1.0.0 entries', /## 1\.0\.0[\s\S]*- sum:[\s\S]*- mean:/.test(changelog))

const suite = runNodeTest(workspace)
c.check('node --test passes', suite.ok, suite.output)

c.finish()
