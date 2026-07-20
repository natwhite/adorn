# adorn

> A collection of convenient TypeScript decorators, plus a factory that makes writing your own decorators simple.

**Status: early / experimental prototype.** The core idea works, several decorators are usable, but large parts are stubbed, undocumented, or contain known bugs. See [Project State](#project-state) before relying on anything here.

---

## Objective

`adorn` has two goals:

1. **Ship a set of ready-to-use decorators** for common needs — validating parameters and fields (positivity, numeric bounds, string length), memoizing method results, and logging calls.

2. **Make decorators easy to author.** TypeScript's raw decorator APIs are awkward, especially *parameter* decorators, which normally can only record metadata and cannot inspect or reject argument values at call time. `adorn` provides a factory that hides that plumbing: you write a plain function that receives a friendly `ParamObject` (parameter name, value, and a formatted call signature), and the factory turns it into a working decorator.

### The core trick

A standard TypeScript parameter decorator runs once, at class-definition time, and receives only `(target, propertyKey, parameterIndex)` — it never sees actual argument values. `adorn` bridges that gap by splitting the work in two:

1. **Parameter decorators record.** `@StringMinLength(10)` files its constraint against `(prototype, method, parameterIndex)` in a contract registry. It writes nothing to the method itself.
2. **`@Contract()` installs.** A class decorator runs *after* every member decorator, so by then the registry holds the complete picture for the whole class. It replaces each contracted method with a wrapper that, on every call, checks the recorded constraints against the runtime arguments before delegating to the original.

```ts
import {Contract, StringMinLength, GreaterThanEqual, LessThanEqual} from 'adorn';

@Contract()
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

> #### ⚠ Breaking change — `@Contract()` is required
>
> Parameter constraints **do nothing on their own**. A class that declares them without `@Contract()` is not enforced, and is also invisible to any documentation or fuzzing generated from the registry.
>
> Because that failure is silent, adorn emits a development-mode warning naming the offending class and methods. It is off under `NODE_ENV=production` and can be routed or silenced with `setContractDiagnosticsSink` / `setContractDiagnosticsEnabled` — though silencing it does not make the contracts work.
>
> `@Validate()` is available as a per-method alternative when annotating the whole class is not wanted. It enforces, but it does **not** register the class for documentation.
>
> **Why the annotation exists at all:** the previous design made the wrapper stick by monkey-patching the global `Object.defineProperty`, because `tslib`'s `__decorate` re-applies the pre-decoration method descriptor and would otherwise discard the wrapper. A parameter decorator's return value is ignored by the language, so there was no other way. Moving installation to a class decorator removes the need for the patch entirely — and is the same shape a standard-decorators (TC39) adapter will need.

Constraints are evaluated in **declaration order**: parameters left to right, stacked decorators top to bottom. When several arguments are invalid, the first one you would read in the signature is the one reported.

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
| `Contract()` | Class | **Required.** Installs every contract recorded on the class, and registers it for documentation. |
| `Validate()` | Method | Per-method alternative to `@Contract()`. Enforces only; does not register for documentation. |
| `setContractDiagnosticsSink(fn)` | Utility | Routes the missing-`@Contract()` warning somewhere other than `console.warn`. |
| `setContractDiagnosticsEnabled(bool)` | Utility | Silences the warning. Does not install anything. |
| `flushContractDiagnostics()` | Utility | Runs the check immediately instead of on the next microtask. |

### The decorator factory (`src/Core`)

- **`Descriptor.ts`** — the reified constraint model: a constraint is *data* (identity + params) with its predicate **derived** from those params, so documentation and enforcement cannot disagree.
- **`ContractRegistry.ts`** — where contracts are recorded. A `WeakMap` for per-prototype lookup, plus an enumerable companion so tooling can ask "which classes have contracts?" — a question a `WeakMap` cannot answer.
- **`MethodDecoratorFactory.ts`** — the single sanctioned installation path. Builds a wrapper from an *around* behaviour and installs it either by returning a descriptor (`__decorate` honours that) or by direct `defineProperty` after member decoration has finished.
- **`ParameterDecoratorFactory.ts`** — `CreateConstraintDecorator` (records a descriptor) and `CreateSimpleDecorator` (records a hand-written closure). Neither installs anything.
- **`ContractInstaller.ts`** — `@Contract()` and `@Validate()`.
- **`ContractDiagnostics.ts`** — the development-mode warning for a forgotten `@Contract()`.
- **`common.ts`** — `getParamNames` (parses a function's source to recover parameter names), `getObjectName`, and `attributeToCaller` (trims adorn's own frames out of a violation's stack by boundary rather than by counting).
- **`DecoratorConfiguration.ts`** — a small global `Configuration` object (currently only `ErrorOnFieldConstraintMismatch`, and currently unused).

A constraint authored with `CreateSimpleDecorator` is a plain closure, so it carries no identity or parameters and **cannot be projected into documentation or a generator**. Author constraints as descriptors if you want them to appear in generated artifacts.

---

## Project structure

```
adorn/
├── index.ts                              # Public entry point + roadmap notes
├── src/
│   ├── Core/
│   │   ├── Descriptor.ts                 # Constraints as data (identity + params -> predicate)
│   │   ├── ContractRegistry.ts           # Where contracts are recorded; public introspection
│   │   ├── MethodDecoratorFactory.ts     # The only sanctioned wrapper-installation path
│   │   ├── ParameterDecoratorFactory.ts  # Parameter decorators — record only, never install
│   │   ├── ContractInstaller.ts          # @Contract() / @Validate()
│   │   ├── ContractDiagnostics.ts        # Missing-@Contract() dev warning
│   │   ├── common.ts                     # Param-name recovery, stack attribution
│   │   ├── DecoratorConfiguration.ts     # Global configuration flags (unused)
│   │   └── FieldDecoratorFactory.ts      # EMPTY — planned
│   ├── Contracts/                        # Built-in constraint descriptors (decorator-free)
│   │   ├── number.ts
│   │   └── string.ts
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

- Parameter-constraint decorators (`Positive`, `GreaterThanEqual`, `LessThanEqual`, `StringMinLength`), the constraint-descriptor model behind them, and the `@Contract()` installer that enforces them. `CreateSimpleDecorator` still works for hand-written checks.
- `Log()` method decorator.
- `Memoize()` for `Observable`-returning methods (the runtime type check is commented out, so non-Observable returns will fail later).

### Incomplete / stubbed

- **`FieldDecoratorFactory.ts` is empty.** (`MethodDecoratorFactory.ts` is now implemented and is the shared installation path for `@Contract()` and `@Validate()`.)
- **`src/MethodDecorators/queue.ts`** contains only an unused import.
- **`DecoratorConfiguration.Configuration`** is defined but not consulted anywhere.
- `src/Tests.ts` is a manual demo, not an automated test suite.

### Known issues / rough edges

- ~~The parameter factory rewrites methods and calls `OverrideObjectDefineProperty`, a global patch to `Object.defineProperty`.~~ **Fixed** — the patch is deleted; installation goes through a class decorator that runs after `__decorate` has finished.
- ~~Factory internals emit `console.debug`/`console.log` diagnostics on every decorated call.~~ **Fixed** — the only console output is the one-shot missing-`@Contract()` warning.
- Wrapped methods report `length === 0` rather than their real arity. Their `.name` is now correct.
- A `null` argument to `StringMinLength` raises a bare `TypeError` instead of a contract violation; `Positive()` accepts `0`.
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