# adorn

> A collection of convenient TypeScript decorators, plus a factory that makes writing your own decorators simple.

**Status: early / experimental prototype.** The core idea works, several decorators are usable, but large parts are stubbed, undocumented, or contain known bugs. See [Project State](#project-state) before relying on anything here.

---

## Objective

`adorn` has two goals:

1. **Ship a set of ready-to-use decorators** for common needs — validating parameters and fields (positivity, numeric bounds, string length), memoizing method results, and logging calls.

2. **Make decorators easy to author.** TypeScript's raw decorator APIs are awkward, especially *parameter* decorators, which normally can only record metadata and cannot inspect or reject argument values at call time. `adorn` provides a factory that hides that plumbing: you write a plain function that receives a friendly `ParamObject` (parameter name, value, and a formatted call signature), and the factory turns it into a working decorator.

### The core trick

A standard TypeScript parameter decorator runs once, at class-definition time, and receives only `(target, propertyKey, parameterIndex)` — it never sees actual argument values. `adorn`'s `ParameterDecoratorFactory.CreateSimpleDecorator` works around this by **rewriting the decorated method**: the first decorator on a method replaces it with a wrapper that, on every call, collects the runtime arguments, builds a `ParamObject` for each decorated parameter, and runs the registered validators before delegating to the original method. Additional parameter decorators on the same method simply append themselves to the wrapper's validator list.

This is what lets you write, for example:

```ts
class Task {
    test(
        @StringMinLength(10) message: string,
        @GreaterThanEqual(100) @LessThanEqual(1000) someNumber: number,
    ) {
        // If message is too short, or someNumber is out of range,
        // an Error is thrown before this body runs.
    }
}
```

---

## What's included

### Public API (`index.ts`)

| Export | Kind | Purpose |
| --- | --- | --- |
| `Positive` | Parameter | Throws if the argument is negative. |
| `GreaterThanEqual(n)` | Parameter | Throws if the argument is `< n`. |
| `LessThanEqual(n)` | Parameter | Throws if the argument is `> n`. |
| `StringMinLength(n)` | Parameter | Throws if the string argument is shorter than `n`. |
| `Enforce` | Field/property | Installs a setter that validates on assignment (e.g. `Enforce.positive()`). |
| `Verify` | Utility | Static validation helpers used by the field decorators. |
| `Memoize()` | Method | Caches a method that returns an RxJS `Observable` (via `publishReplay` + `refCount`). |
| `Log()` | Method | Logs each call as `Call: name(args) => result`. |

### The decorator factory (`src/Core`)

- **`common.ts`** — `DecoratorFactory` base class with helpers: `getParamNames` (parses a function's source to recover parameter names), `getObjectName`, and `OverrideObjectDefineProperty` (a workaround used after method rewriting).
- **`ParameterDecoratorFactory.ts`** — `CreateSimpleDecorator`, the working heart of the library (see [The core trick](#the-core-trick)).
- **`DecoratorConfiguration.ts`** — a small global `Configuration` object (currently only `ErrorOnFieldConstraintMismatch`).

---

## Project structure

```
adorn/
├── index.ts                              # Public entry point + roadmap notes
├── src/
│   ├── Core/
│   │   ├── ParameterDecoratorFactory.ts  # Working: parameter-decorator factory
│   │   ├── common.ts                     # DecoratorFactory helpers
│   │   ├── DecoratorConfiguration.ts     # Global configuration flags
│   │   ├── FieldDecoratorFactory.ts      # EMPTY — planned
│   │   └── MethodDecoratorFactory.ts     # EMPTY — planned
│   ├── ParameterDecorators/
│   │   └── Constraints.ts                # Positive / LessThanEqual / GreaterThanEqual / StringMinLength
│   ├── FieldDeocrators/                  # (sic) typo in directory name
│   │   └── Enforce.ts                    # Field decorators via property setters
│   ├── MethodDecorators/
│   │   ├── queue.ts                      # Stub (only an rxjs import)
│   │   └── promise/
│   │       └── Memoize.ts               # Memoize() + Log()
│   ├── Validation/
│   │   └── Verify.ts                     # Static validation helpers
│   └── Tests.ts                          # Manual demo / smoke script (not a real test suite)
├── tsconfig.json
└── package.json
```

---

## Getting started

### Prerequisites

- Node.js (dev-dependencies target `@types/node` 12)
- TypeScript 3.6+ with decorators enabled

The project relies on `experimentalDecorators` and `emitDecoratorMetadata`, both already set in `tsconfig.json`.

### Install

```bash
npm install
```

### Build & run the demo

There is currently no `build` script, so compile with `tsc` directly, then run the demo:

```bash
npx tsc            # emits to ./dist
npm test           # runs: node dist/src/Tests.js
```

Or run the demo straight from source with the bundled `ts-node`:

```bash
npx ts-node src/Tests.ts
```

`src/Tests.ts` is a hand-written demonstration script that constructs a `Task` and calls decorated methods — it prints output but does not assert anything.

---

## Project state

This is a **single-commit, work-in-progress prototype**. Treat it as a proof of concept, not a released package.

### Working

- Parameter-constraint decorators (`Positive`, `GreaterThanEqual`, `LessThanEqual`, `StringMinLength`) and the `CreateSimpleDecorator` factory behind them.
- `Log()` method decorator.
- `Memoize()` for `Observable`-returning methods (the runtime type check is commented out, so non-Observable returns will fail later).

### Incomplete / stubbed

- **`FieldDecoratorFactory.ts` and `MethodDecoratorFactory.ts` are empty.** A recurring `TODO` states the intent to generalize `CreateSimpleDecorator` so one factory serves parameter, method, and class decorators.
- **`src/MethodDecorators/queue.ts`** contains only an unused import.
- **`DecoratorConfiguration.Configuration`** is defined but not consulted anywhere.
- `src/Tests.ts` is a manual demo, not an automated test suite.

### Known issues / rough edges

- The parameter factory rewrites methods and calls `OverrideObjectDefineProperty`, a global patch to `Object.defineProperty`; a `TODO` flags the desire for a "pure" approach.
- Factory internals emit `console.debug`/`console.log` diagnostics on every decorated call.
- Directory name `src/FieldDeocrators/` is misspelled.
- No published build output, no `dist` committed, and no CI.

### Roadmap

The comment block at the bottom of `index.ts` sketches the intended surface area:

- **String** — length (min/max), regex (matches / URL / email), modifiers (default, regex-replace)
- **Number** — constraints (positive, negative, less-than, greater-than, between, filter), modifiers (map)
- **Generic `T`** — map
- **Method** — memoize, time

Most of these are not yet implemented.

---

## License

ISC (per `package.json`). Author: `natwhite`.
```