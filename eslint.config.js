import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import css from '@eslint/css';
import html from '@html-eslint/eslint-plugin';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';

export default defineConfig(
    {
        ignores: ['**/.yarn/', '**/.pnp.cjs', '**/.pnp.loader.mjs'],
    },

    {
        files: ['**/*.js'],
        plugins: {
            js,
        },
        extends: ['js/recommended'],
    },

    {
        files: ['serve.js', 'eslint.config.js'],
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
    },

    {
        files: ['site/**/*.js'],
        languageOptions: {
            globals: {
                ...globals.browser,
            },
        },
    },

    {
        files: ['site/**/*.css'],
        plugins: {
            css,
        },
        language: 'css/css',
        extends: ['css/recommended'],
        rules: {
            'css/use-baseline': ['warn', { available: 'newly' }],
        },
    },

    {
        files: ['site/**/*.html'],
        plugins: {
            html,
        },
        language: 'html/html',
        extends: ['html/recommended'],
        rules: {
            'html/attrs-newline': 'off',
            'html/element-newline': 'off',
            'html/indent': 'off',
            'html/no-extra-spacing-tags': 'off',
            'html/no-extra-spacing-text': 'off',
            'html/no-multiple-empty-lines': 'off',
            'html/no-trailing-spaces': 'off',
            'html/quotes': 'off',

            'html/require-closing-tags': [
                'error',
                {
                    selfClosing: 'always',
                },
            ],
        },
    },

    prettier
);
