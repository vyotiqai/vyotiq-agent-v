import { changedFiles, createChecker, parseCheckArgs, runHiddenTests, runNodeTest } from '../_lib/check-lib.mjs'

const { workspace, fixture, repo } = parseCheckArgs()
const c = createChecker()

const vendor = changedFiles(workspace, repo, 'src/vendor', { allowAdded: false })
c.check('src/vendor/ unchanged', vendor.length === 0, vendor.join(', '))

const hidden = runHiddenTests(fixture, workspace)
c.check('fetchUser makes exactly 5 attempts', hidden.ok, hidden.output)

const tests = changedFiles(workspace, repo, 'test', { allowAdded: true })
c.check('existing tests unchanged', tests.length === 0, tests.join(', '))

const suite = runNodeTest(workspace)
c.check('node --test passes', suite.ok, suite.output)

c.finish()
