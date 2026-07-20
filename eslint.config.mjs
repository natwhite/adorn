// @ts-check
/**
 * ESLint flat config for adorn (GAP-5).
 *
 * Deliberately low-friction. This is the *first* linter this project has had, over a codebase
 * that predates it, so the goal is a configuration that runs clean enough to be worth wiring
 * into CI — not one that reports a thousand findings nobody will read.
 *
 * Two deliberate choices:
 *
 *  1. **Non-type-checked preset.** `typescript-eslint` offers `recommendedTypeChecked`, which is
 *     considerably more powerful but requires a full program per lint run and surfaces a large
 *     class of findings (floating promises, unsafe `any` flow) that overlap heavily with what
 *     enabling `strict` would surface. Those are tracked together under SMELL-12; turning both
 *     on at once would make the diff unreadable. Upgrade this to `recommendedTypeChecked` in the
 *     same change that flips `strict`.
 *
 *  2. **No formatting rules.** Formatting is Prettier's job (`.prettierrc.json`), and Prettier is
 *     deliberately NOT wired into `lint`, and NOT wired into CI.
 *
 *     `.prettierrc.json` was chosen to match the code already in the tree (4-space indent, single
 *     quotes, no bracket spacing, 110 columns) rather than to impose Prettier's defaults — but it
 *     still reports **46 of ~50 files** as needing a rewrite, because no formatter has ever been
 *     run here. Applying that is a whole-repo diff and MUST NOT be bundled into unrelated work:
 *     it would collide with anything in flight and bury every real change under reflows.
 *
 *     So `npm run format` exists and is correct, but running it is a deliberate standalone task,
 *     ideally landed as one commit on a quiet tree and recorded in `.git-blame-ignore-revs`.
 *     `npm run format:check` is likewise kept out of CI until that happens.
 *
 * `npm run lint` reports; it does not modify. `npm run lint:fix` exists but should not be run
 * across `src/` while other work is in flight.
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        // Build output, dependencies, and coverage are never linted.
        ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
    },

    js.configs.recommended,
    ...tseslint.configs.recommended,

    {
        files: ['**/*.ts'],
        rules: {
            /**
             * adorn is a decorator library: its entire job is receiving values whose type is not
             * known until a constraint validates them. `any` in a signature that accepts an
             * arbitrary decorated value is the honest type, not a lapse. Downgraded to a warning
             * so genuinely lazy `any`s are still visible without burying the report.
             */
            '@typescript-eslint/no-explicit-any': 'warn',

            /**
             * 50 findings, and every one of them is the same idiom: `Function` used to mean
             * "a class constructor". That is the registry's *published* shape —
             * `getContractedClasses(): Function[]` (DEC-011), and `getContractsForClass(ctor)`
             * (DEC-018) — so it is an API decision, not an oversight, and narrowing it to
             * `abstract new (...args: any[]) => unknown` is a semver-relevant change that
             * belongs to Q-6 ("what subset of registry introspection becomes public API").
             *
             * Kept as a warning rather than switched off: the imprecision is real, and Q-6 should
             * be able to see how widely it is relied on. Not an error, because it cannot be fixed
             * without settling Q-6 first.
             */
            '@typescript-eslint/no-unsafe-function-type': 'warn',

            /**
             * `src/MethodDecorators/Time.ts` loads rxjs via a guarded, lazy `require()` on
             * purpose. GAP-6 removed rxjs from the package outright — not demoted to an optional
             * peer, *removed* — so `@Time` keeps its Observable branch as dormant interop that
             * reaches rxjs only if the consumer happens to have it. A static import would make
             * rxjs a hard requirement of every `@Time` consumer, which is precisely what it must
             * not be. Off rather than warn, because the one place it fires is the place it is
             * deliberately correct.
             *
             * See SMELL-16: this lazy require is not bundler-proof, which is a real open issue —
             * but it is an issue with bundlers, not one this rule would help with.
             */
            '@typescript-eslint/no-require-imports': 'off',

            /**
             * Unused *arguments* are routine in decorator signatures — a decorator must accept
             * `(target, key, descriptor)` to be callable even when it only reads one of them.
             * Unused locals and imports are still reported. Leading-underscore is the opt-out.
             */
            '@typescript-eslint/no-unused-vars': ['warn', {
                args: 'none',
                varsIgnorePattern: '^_',
                caughtErrors: 'none',
            }],

            /**
             * The next three fire only inside method-*wrapper* construction, where each is the
             * correct idiom rather than a lapse. A decorator library that installs wrappers is
             * close to the only kind of code for which that is true, so they are relaxed here
             * rather than worked around at the call sites.
             *
             * `no-this-alias` — a wrapper must capture the calling instance before handing
             * control to a closure, and there is no way to write that the rule would accept.
             * It currently fires **nowhere**: the occurrence it was relaxed for was `@Memoize`
             * keying its per-instance cache, and GAP-6 deleted that decorator. Kept `off`
             * because the idiom is intrinsic to wrapper construction and the next wrapper will
             * reach for it again — not because anything relies on it today.
             *
             * `prefer-rest-params` — forwarding `arguments` verbatim is how a wrapper passes a
             * call through untouched. Rest parameters would be equivalent here, so this is
             * `warn`, not `off`: it stays visible without blocking.
             *
             * `no-wrapper-object-types` — one occurrence, `common.ts:40`, and it is a genuine
             * one-word fix (`Object` → `object`). It is `warn` ONLY because that file is owned
             * by another agent in the current round of work. **Promote this back to `error`
             * once that fix lands** — nothing else in the repo trips it.
             */
            '@typescript-eslint/no-this-alias': 'off',
            'prefer-rest-params': 'warn',
            '@typescript-eslint/no-wrapper-object-types': 'warn',
        },
    },

    {
        // Tests and the demo legitimately do things production code should not: reach into
        // internals to characterize them, log to the console, declare throwaway shapes.
        files: ['**/*.test.ts', 'test/**/*.ts', 'examples/**/*.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-empty-function': 'off',
            'no-console': 'off',
        },
    },

    {
        // Jest config and this file are Node scripts, not library sources.
        files: ['jest.config.js', 'eslint.config.mjs'],
        languageOptions: {
            globals: {module: 'writable', require: 'readonly', __dirname: 'readonly'},
        },
    },
);
