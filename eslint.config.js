import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import globals from 'globals';

export default [
	{
		ignores: ['lib/**', 'coverage/**', 'site/**'],
	},
	{
		files: ['**/*.ts'],
		...js.configs.recommended,
	},
	{
		// Build tooling (scripts/) is plain ESM JavaScript so it can run on
		// node against lib/ without pulling in a TypeScript runner.
		files: ['**/*.mjs'],
		...js.configs.recommended,
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: {
				...globals.node,
				...globals.es2021,
			},
		},
	},
	{
		files: ['**/*.ts'],
		languageOptions: {
			parser: tsParser,
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: {
				...globals.node,
				...globals.es2021,
			},
		},
		plugins: {
			'@typescript-eslint': tsPlugin,
		},
		rules: {
			...tsPlugin.configs.recommended.rules,
		},
	},
];
