import { join } from 'node:path'
import { createChecker, isFile, listFiles, parseCheckArgs, readText, runHiddenTests, runNodeTest } from '../_lib/check-lib.mjs'

const { workspace, fixture } = parseCheckArgs()
const c = createChecker()

c.check('src/displayName.js exists', isFile(join(workspace, 'src', 'displayName.js')))
c.check('src/userName.js removed', !isFile(join(workspace, 'src', 'userName.js')))

const stale = listFiles(workspace).filter((rel) => /getUserName|userName\.js/.test(readText(join(workspace, rel)) ?? ''))
c.check('no getUserName / userName.js references left', stale.length === 0, `still mentioned in: ${stale.join(', ')}`)

const readme = readText(join(workspace, 'README.md')) ?? ''
c.check('README documents getDisplayName', /getDisplayName/.test(readme), 'README.md does not mention getDisplayName')

const hidden = runHiddenTests(fixture, workspace)
c.check('behaviour unchanged (hidden tests)', hidden.ok, hidden.output)

const suite = runNodeTest(workspace)
c.check('node --test passes', suite.ok, suite.output)

c.finish()
