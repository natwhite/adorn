# Contract-Driven Development, Runtime Validation, and Design by Contract: Prior Art and Paradigms for *adorn*

> **Scope.** This is a reference document produced to situate the `adorn` decorator library within the broader landscape of runtime validation and Design by Contract (DbC). Part 1 surveys existing libraries, tools, and language features that overlap with `adorn`'s goals. Part 2 documents the Design by Contract paradigm itself. A closing section relates the findings back to `adorn`.
>
> **Neutrality and sourcing.** Claims are grounded in primary sources (official docs, source repositories, and Bertrand Meyer's papers) wherever possible, with inline links and a consolidated [References](#references) section. Where a claim could not be independently verified, or where the exact name requested does not correspond to a real package, this is stated explicitly rather than fabricated.

---

## 0. What *adorn* is (baseline for comparison)

`adorn` (see the repository `README.md` and `src/`) is an early-stage TypeScript decorator library with two goals: ship ready-made decorators, and make decorators easy to author. Its technically distinctive feature concerns **parameter decorators**.

Under TypeScript's *legacy / experimental* decorator model (`experimentalDecorators`), a parameter decorator is "called as a function at runtime, with the following three arguments" — the class prototype or constructor, the member name, and "the ordinal index of the parameter in the function's parameter list" — and "the return value of the parameter decorator is ignored." The handbook is explicit that "a parameter decorator can only be used to *observe* that a parameter has been declared on a method" ([TypeScript Handbook — Decorators](https://www.typescriptlang.org/docs/handbook/decorators.html)). In other words, a parameter decorator sees no argument **values**; it fires once at class-definition time. The community-standard workaround is to pair a parameter decorator (which records metadata via `reflect-metadata`) with a *method* decorator that wraps the call and reads the actual arguments ([reflect-metadata](https://www.npmjs.com/package/reflect-metadata)).

`adorn`'s `ParameterDecoratorFactory.CreateSimpleDecorator` (`src/Core/ParameterDecoratorFactory.ts`) implements a variant of that workaround **without an explicit method decorator**: the first parameter decorator applied to a method *rewrites the method* into a wrapper. On each call the wrapper gathers the runtime `args`, builds a friendly `ParamObject` (parameter name, value, and a formatted signature) for each decorated parameter, and runs the registered validator functions before delegating to the original method via `originalFunction.apply(this, args)`. Subsequent parameter decorators on the same method append themselves to the wrapper's validator list rather than re-wrapping. Parameter names are recovered by parsing `func.toString()` with a regular expression (`src/Core/common.ts`), and a global patch to `Object.defineProperty` (`OverrideObjectDefineProperty`) is used as a workaround after rewriting.

Functionally, this turns parameter decorators into **runtime precondition checks**: if `message` is too short or `someNumber` is out of range, an `Error` is thrown before the method body runs. `adorn` also offers field validation via property setters (`Enforce`, `src/FieldDeocrators/Enforce.ts`) and two method decorators (`Memoize` for RxJS `Observable`s and `Log`).

The rest of this document measures that design against prior art.

---

## Part 1 — Survey of Similar Implementations and Prior Art

The overlapping tools fall into four rough families. The classification axis that matters most for `adorn` is **how a check is *invoked*** (decorator vs. schema/combinator vs. compile-time macro/transform vs. language keyword) and **when it runs** (compile-time vs. runtime).

### 1.1 Decorator-based property/DTO validation (TS/JS)

These libraries are the closest ecosystem neighbours to `adorn`: they attach validation to classes via decorators and check at runtime.

- **class-validator** (`typestack/class-validator`). "Decorator-based property validation for classes." You annotate *class properties* with decorators such as `@IsEmail()`, `@MinLength()`, `@IsString()`, then call `validate(instance)` to get an array of errors. It internally delegates to `validator.js`. Crucially, because decorators attach to properties (not parameters), the object "has to be instantiated using `new Class()`"; to validate a plain object (e.g. from `JSON.parse`) you must first convert it to a class instance ([class-validator repo](https://github.com/typestack/class-validator), [npm](https://www.npmjs.com/package/class-validator)). This differs from `adorn` in target (fields/DTOs vs. method parameters) and in that class-validator does not rewrite methods.

- **class-transformer** (`typestack/class-transformer`). Its companion. `plainToInstance()` converts a plain object into a typed class instance so that decorator-based validation has real instances to inspect; `@Type()` plus `@ValidateNested()` handle nested objects ([This Dot Labs, NestJS validators/transformers](https://www.thisdot.co/blog/combining-validators-and-transformers-in-nestjs)). Not a validator itself; it addresses the "plain object has no class identity" gap that class-validator's decorator approach creates.

- **tsdv-joi → joiful.** `tsdv-joi` lets you apply Joi constraints on class properties via decorators — "combining your type schema and validation schema in one go." It has since been renamed **joiful** with breaking API changes ([tsdv-joi on npm](https://www.npmjs.com/package/tsdv-joi)). *Note on naming:* the task brief lists "tsdv"; the concrete, verifiable package is `tsdv-joi`/`joiful`. Other decorator-validation packages with similar goals include `typescript-decorator-validation` and `validator.ts`.

Decorator validators share `adorn`'s *invocation ergonomics* (annotations on class members) but generally validate **object shape/fields**, not per-call method arguments, and they do not intercept method invocation.

### 1.2 Schema / combinator runtime validators with static type inference (TS/JS)

This is today's dominant idiom for TS validation. You build a **schema object** and both (a) validate at runtime and (b) infer a static TypeScript type from it. The invocation is a fluent or functional *API*, not a decorator; the check is runtime.

| Library | API style | Static type story | Notes |
|---|---|---|---|
| **Zod** | Fluent chain: `z.string().email().min(5)` | `z.infer<typeof S>` | Most popular in the TS ecosystem; schema-first "define once, infer the type, validate at runtime" ([overview](https://www.bitovi.com/blog/comparing-schema-validation-libraries-ajv-joi-yup-and-zod)). |
| **Valibot** | Functional, per-validator imports | inferred | Modular/tree-shakeable design for small bundles ([Zod vs Valibot](https://dev.to/sheraz4194/zod-vs-valibot-which-validation-library-is-right-for-your-typescript-project-303d)). |
| **io-ts** | Combinators/codecs: `t.type({...})` | `t.TypeOf<typeof S>` | "Runtime type system for IO decoding/encoding," built on `fp-ts`; each type is a *codec* with `decode`/`encode`/`is` ([io-ts repo](https://github.com/gcanti/io-ts)). |
| **runtypes** | Combinators | inferred | Lightweight, minimal-overhead runtime type checks ([npm-compare](https://npm-compare.com/arktype,io-ts,joi,runtypes,superstruct,yup,zod)). |
| **superstruct** | Combinators | inferred | Lightweight; good for libraries that don't want to pull in Zod. |
| **ArkType** | Type syntax as strings: parses `"string>5"` into a type | inferred | Ships a runtime parser turning string literals into types; often benchmarked as fastest but heaviest bundle ([Pockit comparison](https://pockit.tools/blog/zod-valibot-arktype-comparison-2026/)). |

All of these differ from `adorn` in three ways: (1) they validate *data values you pass to `.parse`/`.decode`*, not method parameters intercepted transparently; (2) their static type is *derived from the schema*, giving a single source of truth; and (3) they do not rewrite functions. Their advantage over `adorn`'s regex-parsed parameter names and method-rewriting is robustness and type inference; their cost is that the developer must explicitly call the validator at each boundary.

### 1.3 JSON Schema and standalone validators (JS)

- **ajv.** A JSON Schema validator that **compiles schemas into efficient validation functions** ahead of use, supporting JSON Schema drafts 04/06/07/2019-09/2020-12 and JSON Type Definition (RFC 8927). Generally regarded as the fastest, most standards-compliant option, favoured server-side ([Bitovi comparison](https://www.bitovi.com/blog/comparing-schema-validation-libraries-ajv-joi-yup-and-zod), [npm-compare](https://npm-compare.com/ajv,joi,jsonschema,validator,yup)).
- **joi.** A declarative, feature-rich schema/validation library originally built for hapi.js; supports sync and async validation.
- **yup.** A schema builder that separates parsing (`cast()`) from validating (`validate`), popular on the client and in form libraries.

These are schema-first and framework-agnostic; none use decorators or intercept method calls, so they overlap with `adorn` only in *purpose* (runtime validation), not in mechanism.

### 1.4 Compile-time / transform-based type validators (TS)

These generate validators from **actual TypeScript types** at build time, eliminating schema duplication — a fundamentally different mechanism from `adorn`.

- **typia** (`samchon/typia`). A **compile-time TypeScript transformer**: `typia.is<T>()`, `typia.assert<T>()`, and `typia.validate<T>()` are rewritten by the transformer into dedicated, inlined checks derived from `T` "by analyzing the target type `T` in the compilation level." Because the work happens at compile time, typia advertises order-of-magnitude speedups (its docs claim up to "20,000× faster than `class-validator`"). It requires a special build toolchain (a transformer plugin such as `ttsc`/`ttsx`/`@ttsc/unplugin`); "stock `tsc` will not produce it" ([typia docs](https://typia.io/docs/), [typia repo](https://github.com/samchon/typia)). It uses *pure TypeScript types*, not schemas or decorators.
- **typescript-is / ts-auto-guard family.** Older/related projects that likewise synthesize runtime type guards from TS types via a transformer or codegen step. (The modern, actively promoted representative of this idea is typia; the exact historical package `typescript-is` was the predecessor of this transformer-based approach.)

Relative to `adorn`, these represent the opposite pole: they move validation *toward* the type system and compile time, whereas `adorn` operates entirely at runtime via method rewriting and hand-written predicates.

### 1.5 Framework-integrated validators (TS/JS)

- **NestJS `ValidationPipe`.** NestJS wires class-validator + class-transformer into the request pipeline. Incoming payloads are converted to DTO instances via `plainToInstance()` and validated against class-validator decorators; on failure the pipe throws an HTTP 400. It can be registered globally with `app.useGlobalPipes(new ValidationPipe())` ([NestJS validation docs](https://docs.nestjs.com/techniques/validation), [NestJS pipes docs](https://docs.nestjs.com/pipes)). Conceptually a NestJS pipe *is* a precondition check on a route handler's inputs — the same intent as `adorn`'s parameter checks, but at the HTTP boundary and driven by property decorators plus a pipe rather than by method rewriting.
- **Angular Validators.** Angular's forms module provides `Validators` (e.g. `Validators.required`, `Validators.minLength`) attached to form controls, plus custom `ValidatorFn`/directives. These are runtime validators bound to UI form state, again field-oriented rather than method-parameter-oriented.

### 1.6 Design-by-Contract libraries specifically (TS/JS)

This family is the *closest in spirit* to what `adorn` gestures toward (preconditions), and the most relevant for Part 2.

- **babel-plugin-contracts** (`codemix/babel-plugin-contracts`). A **Babel plugin** (compile-time transform) implementing DbC via labelled statements: `pre:` (preconditions), `post:` (postconditions), `invariant:`, and `assert:`. Postconditions reference the return value via a special `it`, and `old()` captures pre-execution state for comparison. Contracts are checked at runtime but **can be stripped in production builds** via configuration ([repo](https://github.com/codemix/babel-plugin-contracts), [npm](https://www.npmjs.com/package/babel-plugin-contracts)). Example:
  ```js
  function withdraw(account, amount) {
    pre: amount > 0, "Cannot withdraw zero or negative amounts";
    post: account.balance < old(account.balance);
    account.balance -= amount;
  }
  ```
  This covers pre-, post-, and invariants — a superset of `adorn`'s preconditions — but via a build-time macro rather than decorators. (Last published years ago; treat as mature-but-dormant.)
- **decorator-contracts** (`final-hill/decorator-contracts`). A TypeScript/ECMAScript **decorator**-based contract library that most closely mirrors what a "complete" `adorn` might become. It provides `@invariant`, `@requires`/`@demands` (preconditions), `@ensures` (postconditions), and `@rescue`. Invariants are enforced "after construction, before and after every method execution, and before and after every get/set usage." It explicitly targets **behavioural subtyping** — the Liskov Substitution Principle — weakening preconditions and strengthening postconditions down inheritance chains, and it wraps instances in a **JavaScript `Proxy`** (classes extend `Contracted` and instantiate via a static `.new()`). Checked mode can be toggled off in production (e.g. `Contracted[checkedMode] = process.env.NODE_ENV === 'development'`) ([repo](https://github.com/final-hill/decorator-contracts)).
- **Contractual** (`codemix/contractual`). "Unobtrusive, backwards-compatible syntactic sugar for Design by Contract in JavaScript," validated at runtime ([site](https://codemix.github.io/contractual/)).
- **contracts.js** (`contracts-js`) and **contract-js** (`derekchiang/contract-js`). `contracts.js` lets you specify invariants checked at runtime and is "heavily inspired by the contract system found in Racket" ([npm search: design by contract](https://www.npmjs.com/search?q=design+by+contract)). `contract-js` is a small DbC library.
- **SpecJS.** A "tiny (≈0.7 KB) library to implement design by contract in JavaScript and TypeScript" ([site](https://alfonsofilho.github.io/SpecJS/)).
- **design-by-contract** (npm). A TS/JS library adding runtime checks in the DbC style ([npm](https://www.npmjs.com/package/design-by-contract)).

> **Verification note on requested names.** The brief lists several packages by specific names — `contractjs`, `cont.racts`, `ts-design-by-contract`, and `dbc-code-contracts`. I could not verify packages published under those *exact* names. The real, verifiable JS/TS DbC packages found are: **babel-plugin-contracts**, **decorator-contracts**, **contractual**, **contracts.js / contracts-js**, **contract-js**, **SpecJS**, and **design-by-contract**. It is likely the brief's names were approximate references to these. They are reported here under their actual names rather than invented to match.

### 1.7 Non-JavaScript precedents

`adorn`'s "checks as part of the method" idea has a long lineage outside JS.

- **Eiffel / Design by Contract (Bertrand Meyer).** The origin. Eiffel builds contracts into the language with `require` (precondition), `ensure` (postcondition), and `invariant` (class invariant) clauses, enforced by the compiler/runtime; Eiffel Software describes DbC as delivering full value only when "native to the language," combining language constructs, compiler support, runtime enforcement, and tooling ([Eiffel Software — Design by Contract](https://www.eiffel.com/values/design-by-contract/), [Meyer, *Applying Design by Contract*](https://se.inf.ethz.ch/~meyer/publications/computer/contract.pdf)). Detailed in Part 2.
- **.NET Code Contracts.** A Microsoft Research project integrated with .NET Framework 4.0 that brought DbC to C# and other .NET languages via a library API (`Contract.Requires`, `Contract.Ensures`, `Contract.Invariant`) plus a binary rewriter and a static checker. (Widely referenced as bringing DbC to .NET; the project is now largely unmaintained but historically significant.) ([Hillel Wayne — Contract programming overview](https://www.hillelwayne.com/post/contracts/))
- **JML (Java Modeling Language).** "A specification language tailored to Java." Contracts are written as structured comments/annotations (`requires`, `ensures`, `invariant`) that can be checked at runtime or fed to static verifiers; it is a "huge and complicated DSL you have to learn" ([JML overview lecture](https://formal.kastel.kit.edu/beckert/teaching/Formale-Verifikation-SS09/05JML.pdf), [Hillel Wayne](https://www.hillelwayne.com/post/contracts/)).
- **Racket contracts.** The Racket/Scheme lineage pioneered **higher-order contracts** — contracts on functions (via the `->` combinator) and on module boundaries, checked at runtime — and is notable for rigorous **blame** assignment: a violation "must blame the guilty party" with an accurate explanation ([Racket Guide — Contracts](https://docs.racket-lang.org/guide/contracts.html), [Hillel Wayne](https://www.hillelwayne.com/post/contracts/)). `contracts.js` and `TreatJS` (a research higher-order-contract system for JavaScript) descend from this line.
- **Clojure `spec`.** A specification/contract system for Clojure; specs describe the shape of data and function args/returns, support runtime instrumentation (`s/fdef`, `instrument`) and generative testing, and draw explicitly on Racket's contract work ([InfoQ — clojure.spec as a contract system](https://www.infoq.com/news/2016/05/clojure-spec-contract/)).
- **Python contract tooling.**
  - **icontract** (`Parquery/icontract`). DbC via `@icontract.require` (preconditions), `@icontract.ensure` (postconditions), and `@icontract.invariant` (class invariants). Its signature feature is *informative* violation messages that include "the source code of the contract condition as well as variable values at the time of the breach" (e.g. `x > 3: x was 1`), and it supports contract inheritance with weakening of preconditions and strengthening of postconditions/invariants ([icontract repo](https://github.com/Parquery/icontract), [docs](https://icontract.readthedocs.io/en/latest/usage.html)).
  - **PyContracts / dpcontracts / deal.** Other Python DbC packages using decorators; PyContracts implements pre-/post-conditions (requiring its own contract syntax); `deal` and `dpcontracts` are noted as not supporting recursion/inheritance of contracts ([icontract docs comparison](https://github.com/Parquery/icontract)).
  - **pydantic.** Not DbC — a *runtime data-validation and settings library* driven by Python type hints (the analogue of Zod/typia in Python). Included because it is often conflated with contract tools; it validates data models, not method pre/postconditions.

### 1.8 Comparison table — mechanism and timing

| Tool / feature | Invocation | Check time | What it guards | Pre / Post / Invariant | Rewrites/wraps the function? |
|---|---|---|---|---|---|
| **adorn** | Parameter decorators (+ field setters) | Runtime | Method **parameters**; field assignment | Preconditions only | **Yes** — rewrites the method |
| class-validator | Property decorators | Runtime | Object fields (DTOs) | Field constraints (≈ invariant-ish on data) | No |
| Zod / Valibot / io-ts / runtypes / superstruct / ArkType | Schema/combinator API | Runtime | Data passed to `.parse`/`.decode` | Data-shape validation | No |
| ajv / joi / yup | Schema API | Runtime (ajv compiles ahead) | Data objects | Data-shape validation | No |
| typia / typescript-is | Compile-time transform of `is/assert<T>` | Runtime code, **generated at compile time** | Data against a TS type | Data-shape validation | No (inlines checks) |
| NestJS ValidationPipe | Pipe + property decorators | Runtime | HTTP handler inputs | Precondition on request | Wraps handler input |
| babel-plugin-contracts | `pre:`/`post:`/`invariant:` labels | Runtime (Babel-inserted; strippable) | Function args, results, blocks | **All three** | Yes (compile-time transform) |
| decorator-contracts | `@requires`/`@ensures`/`@invariant` decorators | Runtime (via `Proxy`; toggleable) | Methods, accessors, class state | **All three** + LSP | Yes (`Proxy`) |
| Eiffel | `require`/`ensure`/`invariant` keywords | Runtime (compiler-enforced; toggleable) | Routines & classes | **All three** | Built into language |
| .NET Code Contracts | `Contract.*` API + rewriter | Runtime and/or static | Methods & objects | **All three** | Yes (binary rewriter) |
| JML | Annotation/comment DSL | Runtime or static verification | Methods & classes | **All three** | Tooling-dependent |
| Racket contracts | `->` combinators at boundaries | Runtime | Function/module boundaries | Pre/post + higher-order, **blame** | Wraps values at boundary |
| Clojure spec | `s/fdef` + instrument | Runtime (opt-in) + test-gen | Function args/returns, data | Pre/post via specs | Instrumentation wrapper |
| icontract (Py) | `@require`/`@ensure`/`@invariant` | Runtime | Functions & classes | **All three** | Decorator wrapper |

---

## Part 2 — Contract-Driven Development / Design by Contract (DbC)

### 2.1 Core concepts

**Design by Contract** models the relationship between a routine (the *supplier*) and its callers (the *clients*) as a formal **contract** with reciprocal obligations and benefits. Bertrand Meyer frames "a module … as offering a service to potential clients" through an explicit agreement of mutual obligations ([Meyer, *Applying Design by Contract*](https://se.inf.ethz.ch/~meyer/publications/computer/contract.pdf)). Three assertion kinds express the contract:

- **Precondition** — what must hold *before* a routine runs. In Meyer's formulation it is "an obligation on the client and a benefit to the supplier": the client must establish it; the supplier may then *assume* it and skip defensive checks. `adorn`'s parameter checks are preconditions.
- **Postcondition** — what the routine guarantees *after* it returns, *provided* the precondition held. It is "an obligation on the supplier and a benefit to the client." Postconditions frequently reference the result and the *prior* state (hence `old()` in JS/Eiffel).
- **Class invariant** — a consistency constraint that holds for every instance across its observable lifetime (it may be temporarily broken *inside* a routine but must be restored on exit). "The invariant characterizes the class as a whole rather than its individual routines" ([Eiffel Software](https://www.eiffel.com/values/design-by-contract/)).

Two further ideas recur:

- **Blame assignment.** When a contract is violated, a well-designed system identifies *which party is at fault* — a precondition failure blames the caller, a postcondition failure blames the callee. The Racket contract system is the canonical example: a violation "must blame the guilty party" with an accurate explanation ([Racket Guide](https://docs.racket-lang.org/guide/contracts.html)). This is more than "an error occurred"; it localizes responsibility.
- **Fail-fast.** Contracts detect violations "automatically, at the moment they occur" ([Eiffel Software](https://www.eiffel.com/values/design-by-contract/)), converting silent corruption or downstream failures into an immediate, localized, diagnosable error.

### 2.2 History and originators

- **Design by Contract** was introduced by **Bertrand Meyer** (late 1980s), coined and implemented in the **Eiffel** language, and popularized by his *Applying "Design by Contract"* (IEEE *Computer*, 1992) and the book *Object-Oriented Software Construction* ([Meyer paper](https://se.inf.ethz.ch/~meyer/publications/computer/contract.pdf)). "Design by Contract" is a trademark of Eiffel Software.
- Antecedents include **Hoare logic** (pre/postcondition reasoning about programs) and **Floyd's** assertions; DbC operationalized these as first-class, runtime-checked language constructs.
- The idea spread outward: **JML** (Java), **.NET Code Contracts**, **Racket/Scheme higher-order contracts** (which added *blame* and contracts on functions), **Clojure spec**, and the Python (`icontract`, PyContracts, `deal`) and JS/TS (`babel-plugin-contracts`, `decorator-contracts`, `contracts.js`) libraries surveyed in Part 1.

### 2.3 How contracts differ from type systems and from ordinary validation

| Aspect | Static type system | Ordinary input validation | Design by Contract |
|---|---|---|---|
| Question answered | "Is this the right *shape*?" (checked before running) | "Is this untrusted *data* acceptable?" | "Is the caller/callee upholding its *obligations*?" |
| When | Compile time | Runtime, at trust boundaries | Runtime (optionally compile/static), at every call |
| Expressiveness | Structural/shape; limited value constraints | Arbitrary value predicates | Arbitrary predicates over args, result, **and prior state** |
| Directionality | Symmetric | One-sided (guard untrusted input) | **Two-sided**: pre = client's duty, post = supplier's duty, plus invariants |
| Failure semantics | Won't compile | Reject/parse error | Contract violation → **blame** a specific party, fail fast |
| Typical goal | Prevent shape errors | Sanitize external data | Encode and enforce internal correctness assumptions |

Key distinctions:

- **Types are checked before the program runs; contracts run *while* it runs.** A type says `x: number`; a contract says `x > 0 ∧ x ≤ 1000`, and *checks the result and object state too*. Value-level predicates (`amount > 0`, "balance decreased") are generally beyond mainstream structural type systems.
- **Validation is one-sided; contracts are reciprocal.** Input validation defends against untrusted data at a boundary. A contract also *binds the callee* (postconditions) and the *class* (invariants), and its precondition explicitly *frees* the supplier from re-checking. DbC is typically used for *internal* correctness assumptions among cooperating code, not primarily for hostile external input.
- **Contracts assign blame.** Ordinary validation reports "bad input"; a contract localizes fault to caller vs. callee, which is a debugging and design aid.

### 2.4 Patterns for expressing contracts in TS/JS

Because JavaScript lacks native contract keywords, real-world approaches include:

1. **Assertion helpers / guard clauses** — hand-written `if (!cond) throw` or `assert()` at function entry/exit. Simple, universal, but verbose and easy to forget; no blame or invariant machinery. (`adorn`'s validator bodies are exactly this pattern, factored behind decorators.)
2. **Decorators** — `@requires`/`@ensures`/`@invariant` (e.g. `decorator-contracts`) or per-constraint parameter decorators (e.g. `adorn`). Ergonomic and declarative; on legacy decorators, preconditions on *parameters* require intercepting the call (method wrapping, a `Proxy`, or `reflect-metadata` + a method decorator).
3. **Proxies** — wrapping an object/class in a `Proxy` to enforce invariants before/after every method and accessor (the `decorator-contracts` approach). Handles invariants and accessors cleanly at some runtime cost.
4. **Compile-time transforms** — Babel/TS transformers that inject checks from a contract syntax (`babel-plugin-contracts`) or from types (typia). Enables `old()`/postcondition sugar and production stripping, at the cost of a build-tool dependency.
5. **Schema libraries at boundaries** — Zod/io-ts/ajv used as ad-hoc pre/postcondition checks at module edges. Not "contracts" in Meyer's sense (no blame, no invariants), but the pragmatic mainstream substitute.

### 2.5 Tradeoffs

- **Runtime cost.** Every contract check executes on every call. Meaningful for hot paths; hence most systems make checks *toggleable* — Eiffel can disable them per assertion level, `babel-plugin-contracts` strips them in production builds, and `decorator-contracts` gates on a checked-mode flag (e.g. `NODE_ENV`). A design question is whether preconditions (guarding *external* callers) should ever be disabled at all, versus postconditions/invariants (internal self-checks) which are commonly disabled in release.
- **Production toggling risk.** Disabling contracts in production means the *guarantees you tested against no longer hold at runtime*. Preconditions on untrusted inputs generally should **not** be stripped; internal invariants often can be. This is a genuine tension, not a solved problem.
- **Error-message quality.** A major differentiator. `icontract` renders the *source of the failed condition and the offending variable values*; Racket emphasizes accurate blame. `adorn` already invests here: its `ParamObject.signature` produces messages like `Task.test(message, someNumber) parameter 'someNumber' expected a number less than or equal to 1000 but received 2000 instead`.
- **Testing implications.** Contracts and tests are complementary. Contracts turn many would-be assertions into always-on runtime checks and enable *contract-based / generative testing* (e.g. Clojure spec's generators, icontract's testing integration): the contract is the oracle. But contracts are not a substitute for tests, and expensive or side-effecting contracts can distort behaviour (contracts should be *pure*).
- **Purity and side effects.** Contract predicates must not mutate state; `babel-plugin-contracts` "maintains purity constraints, discouraging side effects." A contract that changes what it observes is worse than none.
- **Inheritance / substitutability.** Correct DbC obeys the **Liskov Substitution Principle**: subclasses may *weaken* preconditions and *strengthen* postconditions/invariants, never the reverse. `icontract` and `decorator-contracts` implement this; ad-hoc guard clauses do not.

---

## 3. Where *adorn* sits in this landscape

**What adorn already models.** `adorn`'s parameter-decorator mechanism is, in DbC terms, a **precondition system for method parameters**. Each decorated parameter carries a predicate that is checked, fail-fast, before the method body runs — exactly Meyer's precondition ("obligation on the client"). Its `Enforce` field decorator adds a lightweight, per-assignment invariant-like check on a property via a setter. Its error messages, built from a formatted call signature, are closer to the *informative-violation-message* philosophy of `icontract` than to a bare `throw`. In mechanism, `adorn` is a **runtime, method-rewriting** contract enforcer — the same broad family as `decorator-contracts` (which uses a `Proxy`) and `babel-plugin-contracts` (which uses a build transform), and distinct from the schema-first (Zod/io-ts) and compile-time-transform (typia) families.

**What adorn does *not* yet cover.**

- **Postconditions.** There is no `@ensures`-style check on the return value or resulting state, and no `old()`-style capture of prior state for comparison. This is the single largest gap versus a full DbC library.
- **Class invariants.** `Enforce` guards one property assignment at a time; there is no whole-object invariant re-checked before/after every method and accessor (the `@invariant` + `Proxy` pattern of `decorator-contracts`).
- **Blame assignment as a first-class concept.** Messages are informative but do not formally distinguish caller-fault (precondition) from callee-fault (postcondition) — partly because postconditions are absent.
- **Behavioural subtyping (LSP).** No handling of precondition weakening / postcondition strengthening across inheritance.
- **Production toggling.** A `Configuration` object exists (`ErrorOnFieldConstraintMismatch`) but is not consulted; there is no global switch to disable checks in production, unlike Eiffel's assertion levels, `babel-plugin-contracts`' stripping, or `decorator-contracts`' checked mode.
- **Robustness of the mechanism.** Recovering parameter names by regex-parsing `func.toString()` and globally patching `Object.defineProperty` are fragile relative to `reflect-metadata`-based interception or a compile-time transform. Schema/transform libraries avoid this class of problem entirely.
- **Static-type integration.** Unlike Zod/io-ts (schema → inferred type) or typia (type → checks), `adorn`'s runtime predicates are decoupled from TypeScript's type system; there is no single source of truth linking the check to the declared type.

**Net positioning.** `adorn` is best understood as an ergonomic, **runtime precondition** layer — the parameter-level slice of Design by Contract — implemented by method rewriting. To become a fuller DbC library it would add postconditions (with prior-state capture), class invariants (likely via a `Proxy` or a generalized method-decorator factory, which the code's own `TODO`s anticipate), explicit blame, LSP-aware inheritance, and a real production toggle. To instead compete with the mainstream TS validation ecosystem, it would move toward schema-inferred or type-derived checks (Zod/typia style) to gain a single source of truth and avoid `toString()`/`defineProperty` fragility. These are different destinations; the current design clearly points at the **contract** one.

---

## References

Primary sources and official documentation (accessed July 2026):

**Design by Contract — foundational**
- Bertrand Meyer, *Applying "Design by Contract"* (IEEE *Computer*, 1992). https://se.inf.ethz.ch/~meyer/publications/computer/contract.pdf
- Bertrand Meyer, *Design by Contract* (chapter draft). https://se.inf.ethz.ch/~meyer/publications/old/dbc_chapter.pdf
- Eiffel Software — Design by Contract. https://www.eiffel.com/values/design-by-contract/
- Hillel Wayne — "Contract programming" overview (JML, .NET Code Contracts, Racket, Clojure). https://www.hillelwayne.com/post/contracts/

**TypeScript decorator mechanics**
- TypeScript Handbook — Decorators (parameter decorators, three args, return ignored, observe-only). https://www.typescriptlang.org/docs/handbook/decorators.html
- reflect-metadata (npm). https://www.npmjs.com/package/reflect-metadata

**Decorator / DTO validation (TS/JS)**
- class-validator (repo). https://github.com/typestack/class-validator · (npm) https://www.npmjs.com/package/class-validator
- Combining validators and transformers in NestJS (class-transformer `plainToInstance`). https://www.thisdot.co/blog/combining-validators-and-transformers-in-nestjs
- tsdv-joi (→ joiful) (npm). https://www.npmjs.com/package/tsdv-joi

**Schema / combinator validators (TS/JS)**
- io-ts (repo). https://github.com/gcanti/io-ts
- Zod vs Valibot comparison. https://dev.to/sheraz4194/zod-vs-valibot-which-validation-library-is-right-for-your-typescript-project-303d
- Zod / Valibot / ArkType comparison (2026). https://pockit.tools/blog/zod-valibot-arktype-comparison-2026/
- arktype vs runtypes vs io-ts vs joi vs superstruct vs yup vs zod (npm-compare). https://npm-compare.com/arktype,io-ts,joi,runtypes,superstruct,yup,zod

**JSON Schema / standalone validators**
- Comparing schema validation libraries: AJV, Joi, Yup, Zod (Bitovi). https://www.bitovi.com/blog/comparing-schema-validation-libraries-ajv-joi-yup-and-zod
- ajv / joi / jsonschema / validator / yup (npm-compare). https://npm-compare.com/ajv,joi,jsonschema,validator,yup

**Compile-time transform validators**
- typia — docs. https://typia.io/docs/ · (repo) https://github.com/samchon/typia

**Framework validators**
- NestJS — Validation. https://docs.nestjs.com/techniques/validation · Pipes. https://docs.nestjs.com/pipes

**DbC libraries (JS/TS)**
- babel-plugin-contracts (repo). https://github.com/codemix/babel-plugin-contracts · (npm) https://www.npmjs.com/package/babel-plugin-contracts
- decorator-contracts (final-hill) (repo). https://github.com/final-hill/decorator-contracts
- Contractual (codemix). https://codemix.github.io/contractual/
- SpecJS. https://alfonsofilho.github.io/SpecJS/
- design-by-contract (npm). https://www.npmjs.com/package/design-by-contract
- npm search — "design by contract" (contracts.js / contract-js). https://www.npmjs.com/search?q=design+by+contract

**Non-JS precedents**
- Racket Guide — Contracts (blame, higher-order, `->`). https://docs.racket-lang.org/guide/contracts.html
- JML overview (Beckert, lecture notes). https://formal.kastel.kit.edu/beckert/teaching/Formale-Verifikation-SS09/05JML.pdf
- clojure.spec as a contract system (InfoQ). https://www.infoq.com/news/2016/05/clojure-spec-contract/
- icontract (Python DbC) (repo). https://github.com/Parquery/icontract · (docs) https://icontract.readthedocs.io/en/latest/usage.html

---

*Verification caveats:* Package names requested as `contractjs`, `cont.racts`, `ts-design-by-contract`, and `dbc-code-contracts` could not be confirmed under those exact identifiers; the corresponding real packages are reported under their verified names (§1.6). `.NET Code Contracts` and `typescript-is` are described from secondary/historical sources rather than a live primary page, as both are now largely unmaintained. Benchmark figures (e.g. typia's "20,000×") are vendor-reported and should be treated as such.
