import { changedFiles, createChecker, parseCheckArgs, runHiddenTests, runNodeTest } from '../_lib/check-lib.mjs'

const { workspace, fixture, repo } = parseCheckArgs()
const c = createChecker()

const suite = runNodeTest(workspace)
c.check('node --test passes', suite.ok, suite.output)

const touched = changedFiles(workspace, repo, 'test', { allowAdded: false })
c.check('test/ unchanged', touched.length === 0, touched.join(', '))

const hidden = runHiddenTests(fixture, workspace)
c.check('loadAll ordered + rejecting (hidden tests)', hidden.ok, hidden.output)

c.finish()
