/**
 * Runs before each test file's module graph is evaluated — which matters here,
 * because decoration happens at module-evaluation time, before any `beforeAll`.
 *
 * `ParameterDecoratorFactory` emits `console.debug` diagnostics on every
 * decoration and on every decorated call (SMELL-3). Silencing them keeps test
 * output readable. Remove this once SMELL-3 is fixed.
 */
console.debug = () => undefined;

export {};
