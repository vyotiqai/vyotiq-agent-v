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
    ignores: ['out/**', 'dist/**', 'node_modules/**', 'release/**', 'test-results/**', '**/*.d.ts', '.tmp/**']
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
  }
]
