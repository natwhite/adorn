import {defineConfig} from 'tsup';

/**
 * ESM dual build — ADDITIVE (DEC-096).
 *
 * The CJS build stays the untouched `tsc` dist-mirror (`dist/index.js` + `dist/src/**` + `dist/addons/**` +
 * the CLI + the sensitive-flow detector), preserving every runtime-`require` path, the `bin`, and the
 * `tslib`-only isolation of the core graph. This pass adds ESM bundles for the three library entry points
 * ONLY, into `dist/esm/`, so a modern consumer's `import` resolves to real ESM a bundler can tree-shake, while
 * `require('adorn')` still resolves to the identical CJS. Types are shared: the `.d.ts` the CJS `tsc` already
 * emits are referenced by both `exports` conditions, so tsup emits no declarations here.
 *
 * A note on decorators and duplicated core: adorn authors legacy (experimental) TypeScript decorators, whose
 * SYNTAX esbuild transforms; adorn never reads its OWN decorator metadata (only a consumer's
 * `design:paramtypes`), so esbuild's lack of `emitDecoratorMetadata` is irrelevant to the shipped runtime
 * (DEC-004). The add-on bundles inline the core they import, so a consumer loading `adorn` (CJS) and
 * `adorn/otel` (ESM) has two core copies — which is SAFE precisely because of the process-global singletons
 * (DEC-095): both copies share one registry/sink/config on `globalThis`.
 */
export default defineConfig({
    entry: {
        index: 'index.ts',
        'otel/index': 'addons/otel/index.ts',
        'test/index': 'addons/test/index.ts',
    },
    outDir: 'dist/esm',
    format: ['esm'],
    outExtension: () => ({js: '.mjs'}),
    target: 'es2019',
    platform: 'node',
    dts: false,
    sourcemap: false,
    clean: false,
    splitting: false,
    treeshake: true,
    // Never inline a dependency (tslib) or the add-ons' optional peers — the same externalisation the CJS
    // isolation guarantee relies on.
    external: ['tslib', '@opentelemetry/api', 'fast-check'],
});
