import { join } from 'node:path'
import { createChecker, listFiles, parseCheckArgs, readText, runHiddenTests, runNodeTest } from '../_lib/check-lib.mjs'

const { workspace, fixture } = parseCheckArgs()
const c = createChecker()

const hidden = runHiddenTests(fixture, workspace)
c.check('slugify behaves as specified', hidden.ok, hidden.output)

const testFiles = listFiles(join(workspace, 'test')).filter((f) => /\.(c|m)?js$/.test(f))
const covering = testFiles.filter((f) => /slugify\s*\(/.test(readText(join(workspace, 'test', f)) ?? ''))
c.check('a test under test/ calls slugify', covering.length > 0, `test files: ${testFiles.join(', ') || '(none)'}`)

const original = readText(join(workspace, 'test', 'strings.test.js')) ?? ''
c.check(
  'original capitalize/truncate tests kept',
  /capitalize\(/.test(original) && /truncate\(/.test(original),
  'test/strings.test.js lost its capitalize or truncate tests'
)

const suite = runNodeTest(workspace)
c.check('node --test passes', suite.ok, suite.output)

c.finish()
