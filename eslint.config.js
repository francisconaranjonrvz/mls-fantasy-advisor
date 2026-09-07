import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * Reglas del monorepo.
 *
 * La eleccion de fondo: el compilador ya se ocupa de los tipos, asi que aqui
 * solo estan las reglas que atrapan cosas que TypeScript deja pasar. En
 * particular las que ya han costado un bug real en este proyecto:
 *
 *  - `no-unnecessary-condition` habria cazado `if (info.injury)` sobre un array
 *    vacio, que marcaba lesionada a la plantilla entera.
 *  - `no-floating-promises` importa en un scraper hecho de llamadas de red.
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.wrangler/**', 'data/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Los ficheros de configuracion no pertenecen a ningun proyecto de
          // TypeScript, pero conviene que el linter los mire igual.
          allowDefaultProject: ['*.js', '*.ts', 'apps/*/*.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // El proyecto usa `undefined` explicito por exactOptionalPropertyTypes.
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // Los datos vienen de una API sin documentar: hay `any` inevitables al
      // borde, y ahi el tipado se hace con zod, no con aserciones.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Los tests declaran fixtures a proposito incompletos.
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-unused-expressions': 'off',
      // Los dobles de prueba imitan firmas asincronas sin serlo por dentro.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    files: ['apps/web/**/*.tsx'],
    languageOptions: {
      globals: { window: 'readonly', document: 'readonly', fetch: 'readonly', console: 'readonly' },
    },
  },
)
