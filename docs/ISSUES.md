# adorn — Issue Tracker

Running log of bugs, code smells, infrastructure gaps, and open questions found while working on adorn.

> **Maintenance convention:** this file is kept current as work proceeds. Anything encountered — a bug, a smell, a feature idea, an unanswered question — gets an entry here *when it is found*, even if it is not being fixed at the time. Architectural choices go in [DECISIONS.md](DECISIONS.md) instead. Large feature directions live in [vision.md](vision.md); this file tracks only the pointer, not the prose.

**Status legend:** `OPEN` · `FIXED` · `PARTIAL` (fixed in part, residue remains) · `DEFERRED` (accepted, scheduled) · `WONTFIX`

---

## Bugs

| ID | Status | Sev | Summary | Location |
|---|---|---|---|---|
| BUG-1 | **PARTIAL** | High | `Enforce` installs an accessor with a `set` but **no `get`**, and the setter never stores the value. Decorated fields validate on assignment then read back `undefined`, permanently. Also defines on the *prototype* with `configurable: false`. Argument wiring was fixed in `a2ddc5f`; the storage defect remains. | `src/FieldDeocrators/Enforce.ts:5-10` |
| BUG-2 | OPEN | High | `OverrideObjectDefineProperty` is a **one-shot** patch: it swallows the *next* `Object.defineProperty` call anywhere in the program, then restores. A class containing both a parameter-decorated method and an `@Enforce` field can silently no-op the field decorator, since `Enforce` is itself a `defineProperty` call. Cross-feature and silent. See DEC-005 — this cannot simply be deleted. | `src/Core/common.ts:24-33` |
| BUG-3 | OPEN | High | `Memoize` stores its cache on the **prototype**, so it is shared across all instances, is never invalidated, and **ignores `args` entirely** — the same cached value is returned regardless of arguments. | `src/MethodDecorators/promise/Memoize.ts:13,20-32` |
| BUG-4 | OPEN | Med | `StringMinLength` dereferences `params.value.length` with no null/undefined guard, throwing a `TypeError` instead of a contract violation. | `src/ParameterDecorators/Constraints.ts:22-25` |
| BUG-5 | OPEN | Med | `Memoize`'s runtime "must return Observable" check is commented out, so a non-Observable return fails later with an obscure error rather than at the point of misuse. | `src/MethodDecorators/promise/Memoize.ts:23-27` |
| BUG-6 | OPEN | Med | Package ships **no type declarations** — `declaration` is not enabled, so TypeScript consumers get no types from `main`. | `tsconfig.json` |
| BUG-F1 | **FIXED** | High | `Verify.positive` had an inverted condition — it threw when the value *was* positive, contradicting its own error message. Now rejects `value < 0`. | `src/Validation/Verify.ts:8-13` · `a2ddc5f` |
| BUG-F2 | **FIXED** | High | `Enforce.generator` passed the *target object* to the validator instead of the assigned value, so `Enforce.positive` validated the wrong thing. Setter now calls `func(v, key, target)`. Residue tracked as BUG-1. | `src/FieldDeocrators/Enforce.ts:8` · `a2ddc5f` |
| BUG-F3 | **FIXED** | High | `index.ts` used non-relative specifiers (`'src/...'`). `baseUrl` resolves those at compile time but TypeScript does not rewrite specifiers on emit, so `dist/index.js` emitted `require("src/...")` and **threw on load** — the published entry point was non-functional. Verified fixed by loading the compiled output. | `index.ts:2-4` · `0a54e8d` |

## Code smells

| ID | Status | Summary | Location |
|---|---|---|---|
| SMELL-1 | OPEN | Parameter *names* are recovered by regex-parsing `func.toString()`. Breaks under minification — empirically, esbuild `--minify` degrades `["message","someNumber"]` to `["s","t"]`. Not fully solvable at runtime; `emitDecoratorMetadata` supplies types, not names. | `src/Core/common.ts:9-17` |
| SMELL-2 | OPEN | Error re-throwing manipulates `e.stack` via `split('\n')` + `slice(3)`, hardcoding the wrapper's call depth. Silently produces wrong stacks if nesting changes. | `src/Core/ParameterDecoratorFactory.ts:78-82` |
| SMELL-3 | OPEN | `console.debug`/`console.log` diagnostics fire on every decorated call. | `src/Core/ParameterDecoratorFactory.ts:42,65,105` |
| SMELL-4 | OPEN | `Configuration.ErrorOnFieldConstraintMismatch` is defined but never consulted anywhere. | `src/Core/DecoratorConfiguration.ts` |
| SMELL-5 | OPEN | `FieldDecoratorFactory.ts` and `MethodDecoratorFactory.ts` are **empty files**. The code's own TODOs call for generalizing the parameter factory across all three. | `src/Core/` |
| SMELL-6 | OPEN | `queue.ts` contains only an unused `rxjs` import. | `src/MethodDecorators/queue.ts` |
| SMELL-7 | OPEN | Directory name misspelled: `FieldDeocrators` → `FieldDecorators`. Renaming touches the public entry point. | `src/FieldDeocrators/` |
| SMELL-8 | OPEN | `Verify.lessThanEqual` and `Verify.greaterThanEqual` are dead code — nothing calls them. | `src/Validation/Verify.ts:15-25` |
| SMELL-9 | OPEN | `package.json` keywords are malformed: `"prameter"` typo and `"decorators"` repeated four times. | `package.json:9-18` |
| SMELL-10 | OPEN | The wrapper copies every own property off the original function on each decoration; an existing TODO notes this is unwieldy for large objects. | `src/Core/ParameterDecoratorFactory.ts:96-99` |

## Infrastructure gaps

| ID | Status | Summary |
|---|---|---|
| GAP-1 | OPEN | **No real test suite.** `src/Tests.ts` is a manual demo script with no assertions; `npm test` merely runs compiled output. Contract/validation code is exactly the kind that needs real assertions. |
| GAP-2 | OPEN | No `build` script in `package.json`; `dist` must be produced by invoking `tsc` manually. |
| GAP-3 | OPEN | TypeScript pinned at `^3.6.4`; current release is **7.0.2**. |
| GAP-4 | OPEN | No CI. |
| GAP-5 | OPEN | No linter or formatter configuration. |

## Open questions

| ID | Status | Question |
|---|---|---|
| Q-1 | OPEN | `Positive` accepts `0` (it rejects only `value < 0`), but "positive" strictly means `> 0`. The name and the semantics disagree. Pick one and apply it consistently across `Positive`, `Verify.positive`, and any future `Negative`. |
| Q-2 | OPEN | Should preconditions guarding *untrusted external* input ever be strippable in production? A single blanket toggle is unsafe — internal self-checks can be stripped, boundary checks generally cannot. Tracked as DEC-008. |
| Q-3 | OPEN | Generating meaningful arbitraries for *arbitrary hand-written predicates* is unsolved — a closure is a black box to a generator. Built-in constraints are tractable via their descriptors; **user-written predicates are not**, and generate-and-filter degrades badly for narrow ones. Consequence to state publicly rather than bury: **"decorate your code, get a fuzz suite" is not deliverable.** Coverage is partial by construction. |
| Q-4 | OPEN | **Descriptor/predicate drift** — the worst failure mode this goal introduces. If a descriptor says `min: 0` while its predicate checks `> 0`, generated documentation *looks* authoritative while disagreeing with what is actually enforced. Mitigated by deriving predicates from params (DEC-010), but any escape hatch permitting hand-written predicates reopens it. |
| Q-5 | OPEN | **Postcondition expressiveness**, not plumbing, is the real difficulty. Useful postconditions often need prior state and can be as hard to write correctly as the implementation they describe. Adoption may stall here regardless of how good the tooling is. |
| Q-6 | OPEN | Registry introspection becomes **semver-relevant** the moment a projection binds to it (DEC-011). It was internal and freely changeable before; what subset becomes public API is undecided. |

## Feature ideas

Large directions live in [vision.md](vision.md) and are not duplicated here. Items below are those with a concrete bearing on near-term work:

| ID | Status | Summary |
|---|---|---|
| IDEA-1 | **Adopted** | Reified constraint **descriptors** (contract as data, not closure) — prerequisite for the source-of-truth goal. Shape settled: derive predicates from params. See DEC-006, DEC-010. |
| IDEA-2 | **Adopted** | Promote the contract registry from an internal install mechanism to a first-class, introspectable public API. Requires a second, enumerable structure — see DEC-011. |
| IDEA-3 | OPEN | Integrate **fast-check** for property testing / fuzzing driven by contract descriptors. Precedent: `clojure.spec` yields validation *and* generative testing from one declaration. |
| IDEA-4 | OPEN | Postconditions with `old()` state capture. Promoted in priority — fuzzing needs an oracle, and without postconditions generated inputs only test "it didn't throw." |
| IDEA-5 | OPEN | Class invariants, likely `Proxy`-based (the `decorator-contracts` approach). |
| IDEA-6 | OPEN | Cross-parameter contracts (`start < end`; "if mode is custom then config is required"). Highest marginal value — hardest rules to maintain by hand. |
| IDEA-7 | OPEN | Generate documentation / OpenAPI-style specs from the registry. **Recommended as the first projection to build** — it is the safest of the four, needing only descriptors and enumeration, with no oracle and no generator problem. |
