import { describe, expect, it } from 'vitest'
import { countsAsCheck, isCheckCommand } from '@main/agent/feedback/checkCommands'

// Every string here is a command agents actually ran (userData, 2026-09).
// The recogniser decides what counts as verification, so a false positive
// marks unchecked code verified; a miss only costs a nudge.
describe('isCheckCommand', () => {
  it.each([
    'pnpm exec vitest run tests/renderer/composer/composer.dictation.test.tsx --reporter=verbose',
    'pnpm vitest run tests/renderer/task/recordModel.test.ts',
    'npx vitest run tests/main/unit/memory.test.ts',
    'vitest run tests/renderer/task',
    'node_modules/.bin/vitest.cmd run tests/renderer/app/appShell.test.tsx',
    'node node_modules/vitest/vitest.mjs run tests/main/unit',
    'npx tsc --noEmit -p tsconfig.node.json',
    'pnpm exec tsc -p tsconfig.web.json --noEmit --pretty false',
    'tsc --noEmit -p tsconfig.web.json',
    'node node_modules/typescript/bin/tsc -p tsconfig.tests-node.json --noEmit',
    'pnpm exec tsc -p tsconfig.web.json --noEmit; exit $LASTEXITCODE',
    'pnpm exec eslint src/renderer/src/features/chat/components/composer/Composer.tsx',
    'node node_modules/eslint/bin/eslint.js .; exit $LASTEXITCODE',
    'node --test "test/*.test.ts"',
    'node --test --test-name-pattern=createAgent test/loop.test.ts',
    'npm exec --no -- tsc --noEmit --pretty false',
    'pnpm typecheck',
    'pnpm typecheck:tests',
    'pnpm lint',
    'pnpm test:reliability',
    'npm test',
    'npm run test -- --run',
    'python -m pytest tests/test_api.py',
    'pytest -q',
    'cargo test',
    'go test ./...',
    'dotnet test',
    'cd app && pnpm test',
    'CI=1 pnpm vitest run'
  ])('counts %s', (command) => {
    expect(isCheckCommand(command)).toBe(true)
  })

  it.each([
    // What run_tests was mostly used for.
    'python --version',
    'ffprobe -version',
    "python -c \"import re; s=open('a.html').read()\"",
    'python motion-loop/assets/_work/fetch.py https://mixkit.co/license/',
    'node -e "const fs=require(\'fs\')"',
    'node output/verify-gates.mjs',
    // A runner asked about itself.
    'pnpm exec tsc --version',
    'vitest --help',
    // Chained or piped: the exit code is the last command's, not the check's.
    'pnpm exec tsc -p tsconfig.node.json --noEmit 2>&1 | Select-String -Pattern "agentCon"',
    'node --test test/ 2>&1 | Select-Object -Last 12',
    'pnpm test && rm -rf dist',
    'pnpm test; echo done',
    'pnpm test > out.txt',
    // Package scripts that are not checks.
    'pnpm run dev',
    'npm run deploy',
    'pnpm install',
    '',
    '   '
  ])('does not count %s', (command) => {
    expect(isCheckCommand(command)).toBe(false)
  })

  // One group per false negative closed in audit finding R9: a real check the
  // recogniser used to discard, plus the plain forms the same edit endangers.
  describe('R9 — genuine checks that used to be missed', () => {
    it('counts a trailing -v as the verbose flag, not a self-query', () => {
      for (const command of [
        'pytest -v',
        'cargo test -v',
        'go test -v ./...',
        // The plain forms the same edit must not break.
        'pytest -q',
        'cargo test',
        'go test ./...'
      ]) {
        expect(isCheckCommand(command), command).toBe(true)
      }
      // A self-query is still rejected, in either spelling of help.
      expect(isCheckCommand('python --version')).toBe(false)
      expect(isCheckCommand('pnpm exec tsc --version')).toBe(false)
      expect(isCheckCommand('vitest --help')).toBe(false)
      expect(isCheckCommand('vitest -h')).toBe(false)
    })

    it('counts a package-manager flag run before the script name', () => {
      for (const command of [
        'pnpm -r test',
        'pnpm -F @app/main test',
        'pnpm --filter=x test',
        'npm --silent run test:unit',
        'yarn --cwd packages/app lint',
        // The plain forms the same edit must not break.
        'pnpm test',
        'npm run test:unit'
      ]) {
        expect(isCheckCommand(command), command).toBe(true)
      }
      // A flag run is not a licence for a non-check script.
      expect(isCheckCommand('pnpm -r dev')).toBe(false)
      expect(isCheckCommand('npm --silent run deploy')).toBe(false)
    })

    it('counts task-runner flags before the subcommand and a hyphenated make target', () => {
      for (const command of [
        'mvn -q test',
        'mvn --batch-mode -Dtest=Foo test',
        './gradlew -q test',
        'make test-unit',
        'make check-all',
        'make lint',
        // The plain forms the same edit must not break.
        'mvn test',
        'make check',
        'gradlew test'
      ]) {
        expect(isCheckCommand(command), command).toBe(true)
      }
    })

    it('counts a pinned runner and the Python package runners', () => {
      for (const command of [
        'npx tsc@5.9.3 --noEmit',
        'uvx pytest',
        'poetry run pytest',
        'pipenv run pytest',
        // The plain forms the same edit must not break.
        'npx tsc --noEmit -p tsconfig.node.json',
        'pytest tests/'
      ]) {
        expect(isCheckCommand(command), command).toBe(true)
      }
    })

    it('counts a dotted Python version before -m', () => {
      for (const command of [
        'python3.12 -m pytest tests/',
        // The plain forms the same edit must not break.
        'python3 -m pytest tests/',
        'python -m pytest tests/test_api.py'
      ]) {
        expect(isCheckCommand(command), command).toBe(true)
      }
    })

    it('counts the bash `; exit $?` spelling, and still rejects a real chain', () => {
      expect(isCheckCommand('pnpm test; exit $?')).toBe(true)
      expect(isCheckCommand('pnpm exec tsc -p tsconfig.node.json --noEmit; exit $?')).toBe(true)
      // The PowerShell spelling, unchanged.
      expect(isCheckCommand('pnpm exec tsc -p tsconfig.web.json --noEmit; exit $LASTEXITCODE')).toBe(true)
      // Stripping the exit tail must not admit a genuine second command.
      expect(isCheckCommand('pnpm test; echo done')).toBe(false)
      expect(isCheckCommand('pnpm test && rm -rf dist')).toBe(false)
    })
  })
})

describe('countsAsCheck', () => {
  it('counts a test file run by its interpreter, which the receipt used to flag as unchecked', () => {
    for (const command of [
      'node test.js',
      'node tests.mjs',
      'node --test-reporter=spec src/math.test.js',
      'tsx test/api.spec.ts',
      'python test_math.py',
      'python3 -u tests/math_test.py',
      'py -3 test_app.py',
      'bun run math.test.ts',
      'deno run --allow-read add_test.ts',
      'ruby spec/user_spec.rb',
      'cd app && node test.js',
      'node .\\tests\\math.test.js'
    ]) {
      expect(countsAsCheck(command), command).toBe(true)
    }
  })

  it('still counts every runner isCheckCommand does', () => {
    expect(countsAsCheck('pnpm test')).toBe(true)
    expect(countsAsCheck('npx vitest run')).toBe(true)
  })

  it('does not count scripts that only mention a test, chained runs or inline code', () => {
    for (const command of [
      'node scripts/test-data-gen.js',
      'node build.js',
      'python manage.py runserver',
      'node -e "require(\'./test.js\')"',
      'node test.js | tail -5',
      'node test.js; echo ok',
      'cat test.js'
    ]) {
      expect(countsAsCheck(command), command).toBe(false)
    }
  })

  it('leaves autonomy’s matcher narrow: an interpreter-run file is not a runner', () => {
    expect(isCheckCommand('node test.js')).toBe(false)
  })
})
