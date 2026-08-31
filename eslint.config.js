import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['**/dist/**', '**/node_modules/**', 'coverage/**']),

  {
    files: ['**/*.ts', '**/*.js'],
    extends: [
      js.configs.recommended,

      // Type-aware linting throughout. This design has deliberately few seams
      // and leans hard on the type system, so the rules that need type
      // information are the ones worth having.
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,

      // Turns off everything that would fight Prettier. Must stay last.
      prettier,
    ],
    languageOptions: {
      parserOptions: {
        projectService: {
          // Everything else is covered by the root `tsconfig.json`, which is
          // the nearest config to every source and test file in the repo.
          allowDefaultProject: ['eslint.config.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // Interpolating a `Secret` is safe by construction — it yields
      // `[redacted]`, which is the entire point of the type. The rule exists to
      // catch `${someObject}` rendering as "[object Object]"; a Secret is the
      // one type in this codebase designed to be interpolated.
      // Matched by name rather than by origin: `Secret` is declared in the DSL
      // package and reaches consumers through a workspace symlink, which the
      // `from: 'package'` specifier cannot see.
      '@typescript-eslint/restrict-template-expressions': ['error', { allow: ['Secret'] }],
    },
  },

  {
    // Type-level tests declare values solely to take `typeof` of them, and state
    // type arguments in full — including ones that happen to match a default —
    // because the stated contract is what is being asserted.
    files: ['**/*.test-d.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-unnecessary-type-arguments': 'off',
    },
  },
);
