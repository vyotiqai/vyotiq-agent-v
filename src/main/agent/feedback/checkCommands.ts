/**
 * Which commands are checks — a test, typecheck or lint run whose exit code
 * says whether the code is right. The verification gate and the receipt count
 * only these, whether they ran through `run_tests` or `terminal`.
 *
 * `run_tests` takes any sandboxed command, and most real calls were not tests:
 * of 1,679 recorded, 143 ran a test, typecheck or lint command; the rest were
 * `python --version`, ffprobe, fetch scripts. Every one that exited 0 used to
 * count as a clean verification.
 *
 * Deliberately narrow: a command that is not recognised verified nothing, so
 * the cost of a miss is a nudge, while a false match would mark unchecked code
 * verified. A chained or piped command is never a check — its exit code is the
 * last command's (`tsc | Select-String x` exits by the filter, not by tsc).
 */

const PM = String.raw`(?:npm|pnpm|yarn|bun)`
/** Package scripts that check: `test`, `test:unit`, `typecheck`, `lint`, `build`… */
const CHECK_SCRIPT = String.raw`(?:test|tests|typecheck|type-check|types|tsc|lint|check|verify|build)(?::[\w:.-]+)?`
/** Flags a runner or package manager may carry, each with its own value: `pnpm -F @app/main`, `mvn -Dtest=Foo`. */
const FLAG = String.raw`--?[\w-][\w.-]*(?:[= ][^\s]+)*`
/** The same run, minus its flags: `pnpm -F @app/main test` is `pnpm … test`. */
const FLAGS = String.raw`(?:${FLAG}\s+)*`
/** Binaries that check, as run directly or through a package runner. */
const RUNNER = String.raw`(?:vitest|jest|mocha|ava|tap|tsc|vue-tsc|svelte-check|eslint|oxlint|biome\s+(?:check|lint|ci)|stylelint|prettier\s+(?:--check|-c)|playwright\s+test|cypress\s+run|astro\s+check)`
const PY_MODULE = String.raw`(?:pytest|unittest|mypy|pyright|ruff|flake8|pylint|py_compile|compileall)`
/** The Python checkers a package runner may dispatch: `uvx pytest`, `poetry run mypy`. */
const PY_BIN = String.raw`(?:pytest|mypy|pyright|ruff\s+check|flake8|pylint|tox|nox)`

const CHECK_COMMAND_RES: readonly RegExp[] = [
  new RegExp(String.raw`^${PM}\s+${FLAGS}(?:run\s+|run-script\s+)?${CHECK_SCRIPT}(?:\s|$)`, 'i'),
  new RegExp(String.raw`^npm\s+t(?:\s|$)`, 'i'),
  new RegExp(
    String.raw`^(?:npx|pnpx|bunx|uvx|uv\s+tool\s+run|pnpm(?:\s+(?:exec|dlx))?|yarn(?:\s+(?:exec|dlx))?|bun(?:\s+x)?|(?:poetry|pipenv|hatch|pdm|rye)\s+run|npm\s+exec(?:\s+--?[\w-]+)*\s+--)\s+(?:--?[\w-]+\s+)*(?:${RUNNER}|${PY_BIN})(?:@\S+)?(?:\s|$)`,
    'i'
  ),
  new RegExp(String.raw`^(?:(?:\.[\\/])?node_modules[\\/]\.bin[\\/])?${RUNNER}(?:\.cmd)?(?:\s|$)`, 'i'),
  // A runner's entry script run by node, as this repo's own agents do.
  /^node\s+(?:\.[\\/])?node_modules[\\/](?:typescript[\\/]bin[\\/]tsc|vitest[\\/]vitest\.mjs|eslint[\\/]bin[\\/]eslint\.js|jest[\\/]bin[\\/]jest\.js|mocha[\\/]bin[\\/]mocha(?:\.js)?)(?:\s|$)/i,
  new RegExp(
    String.raw`^(?:python3?(?:\.\d+)?|py)(?:\.exe)?\s+(?:-\w\s+)*-m\s+${PY_MODULE}(?:\s|$)`,
    'i'
  ),
  /^(?:pytest|mypy|pyright|ruff\s+check|flake8|pylint|tox|nox)(?:\s|$)/i,
  /^cargo\s+(?:test|check|clippy|build|nextest)(?:\s|$)/i,
  /^go\s+(?:test|vet|build)(?:\s|$)/i,
  /^dotnet\s+(?:test|build)(?:\s|$)/i,
  new RegExp(String.raw`^(?:\.[\\/])?gradlew?(?:\.bat)?\s+${FLAGS}(?:test|check|build)(?:\s|$)`, 'i'),
  new RegExp(String.raw`^mvn\s+${FLAGS}(?:test|verify|compile)(?:\s|$)`, 'i'),
  /^deno\s+(?:test|check|lint)(?:\s|$)/i,
  /^bun\s+test(?:\s|$)/i,
  /^node\s+--test(?:\s|$)/i,
  /^swift\s+(?:test|build)(?:\s|$)/i,
  // A hyphen is a target boundary here, not an end of word: `make test-unit`, `make check-all`.
  new RegExp(String.raw`^make(?:\s+${FLAGS})?(?:test|check|lint)(?:\s|-|$)`, 'i'),
  /^(?:bundle\s+exec\s+)?(?:rspec|rake\s+test)(?:\s|$)/i,
  /^(?:vendor[\\/]bin[\\/])?phpunit(?:\s|$)/i
]

/** A redirect of stderr into stdout changes no exit code; strip it before the chain test. */
const HARMLESS_REDIRECT_RE = /\s+2>&1(?=\s|$)/g
/** Leading `cd dir &&` / `cd dir;` / `Set-Location dir;` — where it runs, not what. */
const LEADING_CD_RE = /^(?:cd|Set-Location|pushd)\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/i
/** Leading `FOO=1 ` environment assignments. */
const LEADING_ENV_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/
/** PowerShell's call operator: `& .\node_modules\.bin\vitest.cmd run`. */
const LEADING_CALL_OP_RE = /^&\s+/
/** `…; exit $LASTEXITCODE` (PowerShell) / `…; exit $?` (bash): hands back the check's own exit code. */
const TRAILING_EXIT_RE = /\s*;\s*exit\s+\$(?:LASTEXITCODE|\?)\s*$/i
const CHAIN_RE = /\|\||&&|[|;&`]|\$\(|>|</
/**
 * `tsc --version`, `vitest --help`: a runner asked about itself checks nothing.
 * `-v`/`-V` is dropped — it is the verbose flag on `pytest -v`,
 * `cargo test -v`, `go test -v` — but `-h` stays, help being the only
 * meaning `-h` has on every runner here.
 */
const SELF_QUERY_RE = /(?:^|\s)(?:--version|-h|--help)\s*$/

export function isCheckCommand(command: string | null | undefined): boolean {
  if (!command) return false
  let cmd = command.trim().replace(HARMLESS_REDIRECT_RE, '').replace(TRAILING_EXIT_RE, '')
  cmd = cmd.replace(LEADING_CD_RE, '').replace(LEADING_ENV_RE, '').replace(LEADING_CALL_OP_RE, '').trim()
  if (!cmd || CHAIN_RE.test(cmd) || SELF_QUERY_RE.test(cmd)) return false
  return CHECK_COMMAND_RES.some((re) => re.test(cmd))
}
