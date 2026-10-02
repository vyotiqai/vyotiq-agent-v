import { changedFiles, createChecker, parseCheckArgs } from '../_lib/check-lib.mjs'

const { workspace, repo, answer } = parseCheckArgs()
const c = createChecker()

c.check('answer names port 8443', /(^|[^\d])8443([^\d]|$)/.test(answer), `answer: ${JSON.stringify(answer.slice(0, 400))}`)
c.check('answer names VY_LISTEN_PORT', /\bVY_LISTEN_PORT\b/.test(answer), `answer: ${JSON.stringify(answer.slice(0, 400))}`)

const touched = changedFiles(workspace, repo, '', { allowAdded: false })
c.check('workspace untouched', touched.length === 0, touched.join(', '))

c.finish()
