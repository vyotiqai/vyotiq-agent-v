import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import babelParser from '@babel/eslint-parser'

const sharedLanguageOptions = {
  globals: {
    ...globals.browser,
    ...globals.node
  },
  parser: babelParser,
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    requireConfigFile: false,
    babelOptions: {
      presets: ['@babel/preset-typescript'],
      parserOpts: {
        plugins: ['jsx']
      }
    }
  }
}

const sharedRules = {
  'no-unused-vars': 'off',
  'no-undef': 'off',
  // ESLint 10 defaults are noisy on this codebase; typecheck covers many cases.
  'no-useless-assignment': 'off',
  'preserve-caught-error': 'off',
  'no-redeclare': 'off'
}

export default [
  {
    // errand-main is a separate reference codebase (no node_modules of its own);
    // linting it fails on unresolvable plugins and is out of scope. Packaged
    // builds, generated output and agent worktrees (.claude/, each a full
    // checkout) are not source either; CI has none of them, so without these
    // a local `eslint .` failed where CI passed.
    // `.vyotiq/**` is the app's own per-workspace state directory (memory,
    // rules, hooks.json, skills, tasks.json) plus whatever scratch a session
    // leaves in it. It is never repo source; linting a scratch probe a session
    // dropped there reddened `eslint .` with 46 errors that CI cannot see.
    ignores: ['out/**', 'dist/**', 'node_modules/**', 'release/**', 'test-results/**', '**/*.d.ts', '.tmp/**', 'errand-main/**', 'site/**', 'dist-package*/**', 'output/**', '.claude/**', '.vyotiq/**']
  },
  js.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'module',
      ecmaVersion: 'latest'
    }
  },
  {
    // Scripts a bundled skill hands the agent to inline into a user's page:
    // classic browser scripts, never loaded by the app itself.
    files: ['resources/marketplace/packages/**/assets/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser },
      sourceType: 'script',
      ecmaVersion: 'latest'
    }
  },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'script',
      ecmaVersion: 'latest'
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: sharedLanguageOptions,
    rules: sharedRules
  },
  {
    files: ['**/*.tsx'],
    plugins: {
      react,
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y
    },
    languageOptions: sharedLanguageOptions,
    settings: {
      react: { version: '19.2' }
    },
    rules: {
      ...sharedRules,
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.configs.recommended.rules,
      // Click/keyboard widgets must be real controls. Drag, image load, and
      // title-bar double-click are not click-target patterns.
      'jsx-a11y/click-events-have-key-events': 'warn',
      'jsx-a11y/no-static-element-interactions': [
        'warn',
        {
          handlers: [
            'onClick',
            'onMouseDown',
            'onMouseUp',
            'onKeyPress',
            'onKeyDown',
            'onKeyUp'
          ],
          allowExpressionValues: true
        }
      ],
      'jsx-a11y/no-noninteractive-element-interactions': [
        'warn',
        {
          handlers: [
            'onClick',
            'onMouseDown',
            'onMouseUp',
            'onKeyPress',
            'onKeyDown',
            'onKeyUp'
          ]
        }
      ],
      'jsx-a11y/interactive-supports-focus': 'warn',
      // APG: tabpanel/region/application may take Tab so the surface can scroll.
      'jsx-a11y/no-noninteractive-tabindex': [
        'warn',
        {
          roles: ['tabpanel', 'region', 'application', 'log', 'document'],
          allowExpressionValues: true
        }
      ],
      'jsx-a11y/label-has-associated-control': [
        'warn',
        {
          controlComponents: ['Input', 'Switch', 'Textarea'],
          depth: 3
        }
      ],
      'jsx-a11y/no-autofocus': 'warn',
      'jsx-a11y/role-supports-aria-props': 'warn',
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react/display-name': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off'
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@main', '@main/*'],
              message: 'Renderer must not import main-process code (@main/*).'
            }
          ]
        }
      ]
    }
  },
  {
    // The primitives in lib/ sit under the `lib/ui` barrel, so one of them
    // importing the barrel closes a module cycle. Rollup then splits the two
    // into separate chunks and warns about execution order on every build
    // (a11y/Dialog -> lib/ui -> Menu -> useDropdownMenu -> a11y did exactly
    // that). Import the leaf module instead. This block replaces the one above
    // for these files, so it repeats the @main restriction.
    files: ['src/renderer/src/lib/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@main', '@main/*'],
              message: 'Renderer must not import main-process code (@main/*).'
            },
            {
              regex: '^(@renderer/lib/ui|(\\.\\./)+(lib/)?ui|\\.)(/index)?$',
              message: 'Inside lib/, import the leaf module (e.g. @renderer/lib/ui/cn), not the lib/ui barrel.'
            }
          ]
        }
      ]
    }
  },
  {
    files: ['src/main/**/*.{ts,tsx}', 'src/preload/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@renderer', '@renderer/*'],
              message: 'Main/preload must not import renderer code (@renderer/*).'
            }
          ]
        }
      ]
    }
  },
  {
    // loop.ts importing the ./tools barrel closes loop -> tools/index ->
    // instanceTools -> agentInstances -> loop, and ESM cycle init leaves
    // AGENT_TOOLS empty: every builtin drops off the wire and ~111 agentLoop*
    // tests fail without naming the import. executeStepTools.ts is imported
    // only by loop.ts, so the barrel closes the same cycle from there. This
    // block replaces the one above for these files, so it repeats @renderer.
    files: ['src/main/agent/loop.ts', 'src/main/agent/executeStepTools.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['./tools', './tools/index', './tools/index.ts'].map((name) => ({
            name,
            message:
              'The ./tools barrel closes a cycle back to loop.ts that empties AGENT_TOOLS at init. Import the leaf module (./tools/<file>) instead.'
          })),
          patterns: [
            {
              group: ['@renderer', '@renderer/*'],
              message: 'Main/preload must not import renderer code (@renderer/*).'
            }
          ]
        }
      ]
    }
  }
]
