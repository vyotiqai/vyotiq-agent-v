import { copyFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { changedFiles, createChecker, isFile, parseCheckArgs, runNodeTest, withWorkspaceCopy } from '../_lib/check-lib.mjs'

const { workspace, fixture, repo } = parseCheckArgs()
const c = createChecker()

const src = changedFiles(workspace, repo, 'src', { allowAdded: false })
c.check('src/ unchanged', src.length === 0, src.join(', '))

const testFile = join(workspace, 'test', 'parseDuration.test.js')
c.check('test/parseDuration.test.js exists', isFile(testFile))

const suite = runNodeTest(workspace)
c.check('node --test passes on the real implementation', suite.ok, suite.output)

if (isFile(testFile) && suite.ok) {
  const mutantsDir = join(fixture, 'hidden', 'mutants')
  const survivors = []
  for (const mutant of readdirSync(mutantsDir).filter((f) => f.endsWith('.js')).sort()) {
    const killed = withWorkspaceCopy(
      workspace,
      (dir) => copyFileSync(join(mutantsDir, mutant), join(dir, 'src', 'parseDuration.js')),
      (dir) => !runNodeTest(dir).ok
    )
    if (!killed) survivors.push(mutant.replace(/\.js$/, ''))
  }
  c.check('every mutant is caught by the tests', survivors.length === 0, `surviving mutants: ${survivors.join(', ')}`)
} else {
  c.check('every mutant is caught by the tests', false, 'skipped: no passing test/parseDuration.test.js')
}

c.finish()
