/**
 * Jest configuration for adorn.
 *
 * Test framework is ts-jest, NOT Vitest — see DEC-004. Vitest transforms via
 * esbuild, and esbuild permanently ignores `emitDecoratorMetadata`, which this
 * library's legacy parameter decorators depend on. ts-jest runs the real
 * TypeScript compiler, so `experimentalDecorators` + `emitDecoratorMetadata`
 * behave exactly as they do in `npm run build`.
 */
module.exports = {
    testEnvironment: 'node',

    // Convention: test files are `*.test.ts`, under `test/`.
    // The glob is location-agnostic so colocated `src/**/*.test.ts` also works.
    testMatch: ['**/*.test.ts'],

    // `test/fixtures/` holds decorated classes that must be `require`d at a
    // controlled moment (not import-hoisted); they are not test files.
    testPathIgnorePatterns: ['/node_modules/', '/dist/', '/test/fixtures/'],

    setupFiles: ['<rootDir>/test/jest.setup.ts'],

    transform: {
        '^.+\\.tsx?$': [
            'ts-jest',
            {
                tsconfig: 'tsconfig.test.json',
            },
        ],
    },

    clearMocks: true,
};
