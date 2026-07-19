# Decorators Modernization: Can *adorn*'s Per-Parameter Contracts Survive Modern TypeScript?

> **Purpose.** This document resolves the open decorator-model dependency flagged in [`implementation-plan-t0-t1.md` §8](./implementation-plan-t0-t1.md) — whether `adorn`'s signature per-parameter syntax is viable on current TypeScript, and if not, what replaces it.
>
> **Method.** Primary sources (TypeScript release notes and TSConfig reference, TC39 proposal repositories and the proposals tracker, library commits and issue threads) plus **direct empirical testing against TypeScript 7.0.2 and esbuild 0.28.1**, run locally on 2026-07-19. Every empirical claim below is labelled as such and is reproducible. Where a claim could not be verified, it is marked rather than filled in.
>
> **Tone and confidence.** Claims are tagged **[High]**, **[Medium]**, or **[Low]** confidence. Statements about *future* TypeScript or TC39 behaviour are explicitly separated from statements of current fact.
>
> **Status:** research document. No source under `src/` or `index.ts` was modified.

---

## 0. Executive summary

The brief's framing — "Stage-3 decorators have no parameter decorators, therefore adorn's headline feature is pinned to a legacy mode, which is a strategic risk" — is **half right**. The technical premise is correct. The risk assessment is overstated.

Five findings, in descending order of importance:

1. **The premise is confirmed.** The standard decorator model does not include parameter decorators, and TypeScript rejects them outright when `experimentalDecorators` is off. *Verified empirically:* TypeScript 7.0.2 emits `error TS1206: Decorators are not valid here.` for `m(@P a: string)` in standard mode. **[High]**

2. **`experimentalDecorators` is in far better health than the brief assumes.** It survived the TypeScript 6.0 deprecation sweep (which was explicitly a list of things to be *hard-removed* in 7.0), it is absent from every 7.0 removal list, and the TypeScript team **actively ported the legacy decorator emitter — including the `__param` helper for parameter decorators — to the new Go compiler** in December 2025. *Verified empirically:* TypeScript 7.0.2 (GA, 2026-07-08) compiles and runs legacy parameter decorators with `emitDecoratorMetadata`, emitting `__decorate` / `__param` / `__metadata` exactly as TypeScript 3.x did, with no deprecation diagnostic. **[High]**

3. **Ecosystem support for legacy *parameter* decorators is near-universal, with one silent-failure exception.** tsc, SWC, esbuild, Oxc, Bun, and Deno all transform them. **Babel is the exception and it fails silently** — in `version: "legacy"` mode it drops parameter decorators with no error. The real ecosystem dividing line is not parameter decorators but `emitDecoratorMetadata`, which esbuild refuses permanently. **[High]**

4. **The per-parameter *syntax* has no standards-track replacement on any credible timeline.** The TC39 parameter-decorators proposal is **Stage 1**, was last presented to committee in **March 2023**, and its own issue tracker consists largely of DI-library maintainers asking for updates and receiving none. Meanwhile the *parent* Decorators proposal was itself **moved back to Stage 2.7** around May 2026 and no browser has shipped it. Worse, the motivating use case is contested *within* the committee. **[High]**

5. **The best available approximation is a method-level `@Contract({...})` decorator, and it works today.** *Verified empirically:* a standard method decorator that wraps the method, validates by parameter index, and stores its spec in `context.metadata` compiles and runs correctly on TypeScript 7.0.2, producing error messages identical in quality to adorn's current ones. The cost is that the constraint moves from the parameter to the method signature — losing locality and gaining a positional-index correspondence that the compiler cannot check.

**Two precedents settle the design question.** `decorator-contracts` — the library closest to adorn in intent — migrated to standard decorators in 2023 by expressing argument contracts through *method* decorators (`@demands((_self, x) => x >= 0)`), so the method-level shape is a legitimate contract idiom, not a consolation prize. And **MikroORM v7 (March 2026) shipped exactly the dual-adapter design recommended below** — one engine, two decorator entry points (`/legacy` and `/es`), with the standard-mode path documented as a flavour carrying a stated capability loss. Meanwhile, in three years, **no library that depends on parameter decorators has migrated** — not NestJS, InversifyJS, TypeORM, TypeDI, tsyringe, routing-controllers, or TypeGraphQL. **[High]** on the direction; **[Medium]** on individual details.

**Recommendation, in one line:** stay on `experimentalDecorators` for the per-parameter syntax, but build the method-level `@Contract({...})` form **now**, as a first-class, co-equal, standard-decorators-compatible API — not as a fallback. See [§7](#7-recommendation).

**The main tradeoff:** this accepts a permanent dependency on a non-standard compiler flag for adorn's most distinctive feature, in exchange for keeping that feature at all. The hedge is that the *contract engine* becomes decorator-model-agnostic, so the flag governs only a thin, deletable adapter.

---

## 1. Verifying the premise (Question 1)

### 1.1 What the standard decorator model does and does not support

TypeScript 5.0 (March 2023) shipped the TC39 decorators proposal. The release notes are unambiguous on both counts:

> "Decorators can be used on more than just methods! They can be used on properties/fields, getters, setters, and auto-accessors. Even classes themselves can be decorated for things like subclassing and registration."

and

> "This new decorators proposal is not compatible with `--emitDecoratorMetadata`, and it **does not allow decorating parameters**."
> — [TypeScript 5.0 release notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-0.html) (emphasis added)

The proposal itself concurs. Its FAQ states: *"This proposal does not include parameter decorators, but they may be provided by future built-in decorators"* ([tc39/proposal-decorators README](https://github.com/tc39/proposal-decorators/blob/master/README.md)). The decoratable positions are classes, class fields, class methods, class accessors, and the new `accessor` auto-accessor element. **[High]**

**Empirical confirmation** (TypeScript 7.0.2, standard mode, `lib: ["es2022","esnext.decorators"]`):

```
modern.ts(3,5): error TS1206: Decorators are not valid here.
```

for the input:

```ts
function P(target: any, ctx: any) { }
class T {
  m(@P a: string) { return a; }   // ← TS1206
}
```

This is a hard parse-level rejection, not a type error — there is no escape hatch, no `any`-cast workaround, no declaration-merging trick. **[High]**

### 1.2 A correction to the brief's terminology: the proposal is currently Stage 2.7, not Stage 3

This does not change the conclusion, but it matters for how much weight to put on "the standard".

The [TC39 proposals tracker](https://github.com/tc39/proposals/blob/main/README.md) currently lists **both** *Decorators* and *Decorator Metadata* under the heading **`### Stage 2.7`**, not Stage 3:

| Proposal | Stage (per tracker) | Champion | Last presented |
|---|---|---|---|
| Decorators | **2.7** | Kristen Hewell Garrett | 2025-02 |
| Decorator Metadata | **2.7** | Kristen Hewell Garrett | 2023-05 |

Decorators reached Stage 3 in March 2022. The move back to 2.7 appears to have happened around **late May 2026** — a conference talk on 2026-05-30 describes the demotion as having occurred "three days" prior ([susisu, TSKaigi 2026 write-up](https://susisu.hatenablog.com/entry/2026/05/30/164040)). **[Medium]** on the precise date and reason; **[High]** that the tracker currently reads 2.7.

Stage 2.7 means *"the spec text is complete and the committee won't ask for changes except what surfaces through testing, implementing, and using the feature"* — it was introduced in November 2023 to carry roughly the old Stage 3 bar, making Stage 3 now additionally require a test suite ([The TC39 Process](https://tc39.es/process-document/); [The New Stack](https://thenewstack.io/inside-ecmascript-javascript-standard-gets-an-extra-stage/)). The most likely driver is incomplete test262 coverage. **[Medium]**

> **A dissenting reading, recorded for honesty.** The `proposal-decorators` README body still describes the feature in Stage 3 terms, and TypeScript, Babel, and the wider ecosystem all continue to ship and document it as "Stage 3 decorators". One plausible explanation is that the `Stage: 2.7` header is stale metadata. Against that: the *independent* `tc39/proposals` tracker also files it under a `### Stage 2.7` heading, and two independent sources agreeing is unlikely to be a single stale edit. **The practical impact either way is nil** — the feature is shipped in every major toolchain and unshipped in every browser engine, regardless of the label. This document uses "standard decorators" rather than "Stage 3 decorators" throughout to sidestep the ambiguity. **[Medium]**

Independently, at the February 2025 plenary the situation was summarized as: Edge has "an almost complete implementation on top of Chromium's V8 engine", Firefox's is in progress, but *"none of the three major browsers want to be the first one to ship among them, leaving the future of the proposal uncertain"* ([Igalia, Summary of the February 2025 TC39 plenary](https://blogs.igalia.com/compilers/2025/03/27/summary-of-the-february-2025-tc39-plenary/)). **[High]**

**Why this matters for adorn.** The argument "migrate to the standard because it is the standard" is weaker than it appears. As of July 2026, **no JavaScript engine ships decorators natively**; every consumer of standard decorators is running compiler output, exactly as legacy-decorator users are. The choice is between two transpiled dialects, not between a native feature and a legacy hack.

### 1.3 Is `experimentalDecorators` still supported? Is it deprecated? Is removal planned?

**Supported: yes, including in the Go-native compiler. Deprecated: no, not formally. Removal: not announced.** **[High]**

The evidence chain:

1. **TypeScript 5.0 statement of intent** — *"`--experimentalDecorators` will continue to exist for the foreseeable future; however, without the flag, decorators will now be valid syntax for all new code."* ([TS 5.0 release notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-0.html))

2. **The TSConfig reference does not mark it deprecated.** It describes it as enabling *"experimental support for decorators, which is a version of decorators that predates the TC39 standardization process"* ([TSConfig: experimentalDecorators](https://www.typescriptlang.org/tsconfig/experimentalDecorators.html)). Note the wording is a caution about divergence, not a deprecation notice.

3. **It is absent from the TypeScript 6.0 deprecation list.** TypeScript 6.0 was the transition release whose deprecations became hard removals in 7.0. That list covers `target: es5`, `--downlevelIteration`, `moduleResolution: node10` and `classic`, `module: amd`/`umd`/`systemjs`, `--baseUrl`, `--outFile`, `esModuleInterop: false`, `allowSyntheticDefaultImports: false`, `alwaysStrict: false`, legacy `module` block syntax, `asserts` on imports, and no-default-lib directives. **Neither `experimentalDecorators` nor `emitDecoratorMetadata` appears anywhere on it** ([microsoft/TypeScript#54500, "6.0 Deprecation List"](https://github.com/microsoft/TypeScript/issues/54500)). **[High]**

4. **Neither appears in the TypeScript 7.0 removal list** ([Announcing TypeScript 7.0 RC](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0-rc/), 2026-06-18; [Announcing TypeScript 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/), 2026-07-08).

5. **The strongest signal: the team paid to port it.** [microsoft/typescript-go#2343](https://github.com/microsoft/typescript-go/pull/2343) — *"--experimentalDecorators and --emitDecoratorMetadata"* by Wes Wigham, merged 2025-12-12 — ports the legacy decorator emitter to the Go compiler, generating `__decorate`, `__metadata`, and **`__param`** (the parameter-decorator helper specifically). The PR description reads: *"This PR ports emit for `--experimentalDecorators` and `--emitDecoratorMetadata`, since many users of the former also enable the later (which isn't even supported with standardized decorators in strada, apparently)."* Porting a feature to a from-scratch compiler is a costly, deliberate act; it is not what a team does to something it intends to remove. **[High]**

**Empirical verification** — TypeScript 7.0.2, `experimentalDecorators: true`, `emitDecoratorMetadata: true`, `target: es2022`:

```
COMPILE OK
param deco fired: T m 1
param deco fired: T m 0
```

with emit:

```js
__decorate([
    __param(0, P),
    __param(1, P),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Number]),
    __metadata("design:returntype", void 0)
], T.prototype, "m", null);
```

Byte-for-byte the same shape adorn already depends on, including the right-to-left decorator evaluation order and the trailing `Object.defineProperty` in `__decorate` that adorn's `OverrideObjectDefineProperty` patch exists to suppress. **No deprecation warning was emitted.** **[High]**

> **Caveat, and it is a real one.** adorn's *current* `tsconfig.json` does **not** compile on TypeScript 7 — but for reasons entirely unrelated to decorators. Verified empirically:
>
> ```
> error TS5102: Option 'baseUrl' has been removed. Please remove it from your configuration.
> error TS5108: Option 'moduleResolution=node10' has been removed. Please remove it from your configuration.
> ```
>
> Both are already flagged in [`implementation-plan-t0-t1.md` §1.3](./implementation-plan-t0-t1.md). `experimentalDecorators` and `emitDecoratorMetadata` passed without complaint. **[High]**

**Speculation, clearly labelled as such.** No removal is announced. Two things would have to happen before removal became plausible: (a) the standard proposal reaching Stage 4 and shipping in engines, and (b) a migration path existing for the parameter-decorator use case — which today it does not, since the replacement proposal is Stage 1 and dormant. Removing the flag before (b) would strand NestJS, TypeGraphQL, InversifyJS, TypeDI, tsyringe, and every codebase built on them. Note that Angular's documentation *asserts* removal will happen ("they will be unsupported once the `experimentalDecorators` option is removed from the TypeScript compiler"), but this is a downstream framework's forward-looking statement, **not** a TypeScript team commitment; no such commitment was found. **[Low]** on any removal timeline; treat "never in the practical planning horizon" and "removed in some future major" as both live, with the former better supported by current evidence.

### 1.4 Can legacy and standard decorators coexist in one compilation?

**No.** `experimentalDecorators` is a per-compilation compiler option, not a per-file or per-declaration one. There is no pragma, triple-slash directive, or comment-level override. Within a single `tsconfig.json` scope, all decorators are interpreted under one model, and the TS 5.0 notes warn that *"the type-checking rules and emit are sufficiently different that while decorators can be written to support both the old and new decorators behavior, any existing decorator functions are not likely to do so."* **[High]**

The practical consequences for a *library*:

- **A library cannot straddle the boundary for its consumers.** adorn's decorators are *applied* in consumer code, so the **consumer's** `tsconfig.json` governs. Compiling adorn itself under legacy mode does not let a standard-mode consumer use `@Positive()` on a parameter — they will hit TS1206 at their own call site.
- **Mixing is possible only via separate compilation units** (separate `tsconfig.json` projects, e.g. a `legacy/` and a `modern/` directory), which is a real but heavyweight escape hatch.
- **This is a live source of ecosystem pain, not a theoretical one.** From the TC39 parameter-decorators tracker: *"I recently ran into trouble creating my own decorator library using vanilla TS decorators which I couldn't then deploy in a project alongside TypeGraphQL, forcing me to downgrade my library to use the experimentalDecorators implementation"* (DMCTowns, 2025-04-16, [tc39/proposal-class-method-parameter-decorators#3](https://github.com/tc39/proposal-class-method-parameter-decorators/issues/3)). **[High]**

This is the single strongest argument for adorn eventually shipping **both** a legacy-mode and a standard-mode entry point: a consumer who cannot flip the flag (because something else in their build forbids it) is otherwise locked out entirely.

### 1.5 What `emitDecoratorMetadata` does, and whether there is a standard counterpart

**What it does.** When enabled alongside `experimentalDecorators`, tsc emits `Reflect.metadata` calls carrying design-time type information for decorated declarations ([TSConfig: emitDecoratorMetadata](https://www.typescriptlang.org/tsconfig/emitDecoratorMetadata.html)):

- `design:type` — the type of the decorated member
- `design:paramtypes` — an array of parameter type *constructors*
- `design:returntype` — the return type

It requires the [`reflect-metadata`](https://www.npmjs.com/package/reflect-metadata) polyfill at runtime to actually store anything; without it, the emitted `__metadata` helper is a no-op.

**Is there a standard counterpart? No — and the TypeScript team has signalled there probably never will be.** **[High]** Four confirmations:

1. TS 5.0 release notes: *"This new decorators proposal is not compatible with `--emitDecoratorMetadata`."*
2. The request to bridge the gap — [microsoft/TypeScript#57533](https://github.com/microsoft/TypeScript/issues/57533), *"Expose design-time type information in TC39 decorator metadata when `emitDecoratorMetadata: true`"* — was opened 2024-02-25 and remains **open**, labelled *"Needs Proposal"* / *"Suggestion"*, with **no milestone**. It explicitly notes that type-graphql, inversify, and Angular depend on this.
3. **The team's answer is a soft no.** Ryan Cavanaugh, on that issue, 2025-03-28:

   > "I don't think we're going to have decorator metadata in ES decorators. It's unlikely. Not impossible, but very unlikely. We are increasingly moving away from any type-based emit in all forms… Our hope is that most experimental decorators users will be able to transition to ES decorators, but they are definitely not at 100% parity."

   This is the clearest statement of TypeScript's position found anywhere in this research, and it cuts two ways: it closes the door on type-based metadata under standard decorators, **and** it confirms the team expects legacy users to migrate eventually — while conceding parity does not exist. **[High]**
4. *Verified empirically:* the flags are hard-coupled even in TypeScript 7.0.2:
   ```
   error TS5052: Option 'emitDecoratorMetadata' cannot be specified without specifying option 'experimentalDecorators'.
   ```

Note also that [`reflect-metadata`](https://www.npmjs.com/package/reflect-metadata) itself — the runtime the entire legacy metadata stack depends on — last released **v0.2.1 in December 2023**, with its last commit in March 2024. It is stable rather than actively developed. **[Medium]**

**What this means for adorn specifically.** `design:paramtypes` gives you the *types* of parameters (`[String, Number]`), which the implementation plan's P1.5 intends to use for advisory checks like "`@Positive()` is sitting on a `string`". It has never given parameter **names**. Losing it costs adorn a *nice-to-have* diagnostic, not a core capability. It is also lossy by nature — interfaces, unions, and generics all erase to `Object` — which the implementation plan already accounts for ([§P1.5 risk note](./implementation-plan-t0-t1.md)).

---

## 2. Standardization status of parameter decorators (Question 2)

### 2.1 The proposal exists, and its design is *better* for adorn than legacy

[tc39/proposal-class-method-parameter-decorators](https://github.com/tc39/proposal-class-method-parameter-decorators) — *"Decorators for ECMAScript class method and constructor parameters"*, champion **Ron Buckton** (a TypeScript team member).

Its motivation names adorn's neighbours directly: *"Dependency Injection systems often use constructor parameter injection to satisfy dependencies when an instance of a component is requested"*, and *"Many of these scenarios are drawn from existing uses of legacy decorators in TypeScript, as well as similar capabilities in languages like Java and C#."*

The proposed shape:

```ts
type ParameterDecoratorContext = {
  kind: "parameter";
  name: string | undefined;      // ← parameter NAME, from the compiler
  index: number;
  rest: boolean;
  function: {
    kind: "class" | "method" | "setter";
    name: string | symbol | undefined;
    static?: boolean;
    private?: boolean;
  };
  metadata: object;
  addInitializer(initializer: () => void): void;
}
```

**Two properties of this design would be transformative for adorn, and both should be noted because they invert the usual "legacy is more capable" framing:**

1. **`context.name` supplies the parameter name from the compiler.** This would eliminate adorn's `Function.prototype.toString()` regex parsing outright — the single most fragile mechanism in the library (see [§5](#5-the-parameter-name-problem)).

2. **The decorator can see the runtime value.** Per the proposal: *"A parameter decorator may either return `undefined`, or a function value. If a function is returned, it will be later invoked when that parameter is bound during its containing function's invocation."* The companion [EXTENSIONS.md](https://github.com/tc39/proposal-decorators/blob/master/EXTENSIONS.md) elaborates: *"A parameter decorator wraps the value of a function/method argument. It returns a function which does the wrapping"*, called *"with the `this` value that the surrounding function is called with."*

That second point is worth dwelling on. adorn's entire "core trick" — rewriting the decorated method so the wrapper can see argument values, with all the `__decorate` / `Object.defineProperty` fallout documented in [`implementation-plan-t0-t1.md` §1.1](./implementation-plan-t0-t1.md) — exists **only because legacy parameter decorators cannot see values**. The standards-track design makes value inspection a first-class, per-parameter primitive. If this proposal ever shipped, adorn's most complex and most fragile subsystem would be deleted, not ported. **[High]** on the proposal's text; **[Low]** that it will ship (see below).

### 2.2 Momentum: low, and the blocker is upstream

| Signal | Value | Source |
|---|---|---|
| Stage | **1** | [tc39/proposals stage-1 list](https://github.com/tc39/proposals/blob/main/stage-1-proposals.md) |
| Champion | Ron Buckton | ibid. |
| Last presented to committee | **2023-03** | ibid. |
| Repo created | 2023-03-06 | GitHub API |
| Last push to repo | 2025-01-28 | GitHub API |
| Open issues | 6 | GitHub API |
| Stars | 65 | GitHub API |

Stage 1 means "the committee is willing to spend time on it"; it carries **no** commitment to ever ship. Three years with no committee presentation is a strong dormancy signal. **[High]**

The tracker's flagship issue, [#3 "Towards stage 2"](https://github.com/tc39/proposal-class-method-parameter-decorators/issues/3) (opened 2023-12-19 by an InversifyJS maintainer), is a near-perfect illustration of the situation — three years of downstream demand meeting silence. Its full comment history:

| Date | Author | Comment |
|---|---|---|
| 2023-12-19 | PodaruDragos (InversifyJS) | *"A very very common question we get is 'when are we switching to vanilla decorators'"* — supporting standard decorators would require significant UX compromises |
| 2024-06-02 | pimmee | *"NestJS is also a library which heavily uses DI and parameter decorators, and this feature (along with decorator metadata), are needed to support vanilla decorators."* |
| 2024-12-15 | cjnoname | *"Any news on this?"* |
| 2025-04-16 | DMCTowns | *"TypeGraphQL is another library that uses parameter decorators… forcing me to downgrade my library to use the experimentalDecorators implementation"* |
| 2025-04-17 | PodaruDragos | *"the decorators proposal itself which is stage 3 for quite some time is mostly done on v8's side but they don't want to be the first to adopt it. If that isn't a priority this will most likely never happen."* |
| 2025-10-23 | bryanerayner | *"We currently maintain a large Angular codebase with many custom experimental decorators. We would like to migrate to the stage 3 decorator syntax, but are blocked by Angular being held on legacy decorators."* |
| 2025-11-27 | alexgwolff | *"any update?"* |
| 2026-03-09 | martinsotirov | *"Please make this happen."* |

**No TC39 delegate — including the champion — has replied in the thread.** **[High]**

**There is also documented committee opposition, which matters more than the silence.** The long-running [tc39/proposal-decorators#47](https://github.com/tc39/proposal-decorators/issues/47) (open since 2018) is where the question was argued out. Committee participants pushed back on the motivating use case itself:

- bakkot: *"I am (at present) very firmly against parameter decorators… 'There exists a library which would use this feature' is not, in itself, sufficient reason"*
- pzuraq (the Decorators champion): *"DI is fairly divisive in terms of motivation."*

**[Medium]** on these quotes, which were gathered by a delegated search rather than read directly by the author of this document.

This changes the character of the assessment. Parameter decorators are not merely *waiting in a queue* — the strongest motivating use case (dependency injection) is contested within the committee, and the primary constituency asking for the feature is precisely the group whose motivation is being questioned. Combine that with the structural blocker — a Stage-1 extension cannot advance past a parent proposal that is itself stalled at 2.7 with no engine willing to ship first — and the realistic outlook is worse than "dormant".

Ron Buckton's other decorator extension, [Function and Object Literal Element Decorators](https://github.com/tc39/proposal-function-and-object-literal-element-decorators), is also Stage 1, last presented 2024-02 — marginally more recent, same pattern.

**Assessment.** Planning for parameter decorators to be standardized is planning on an event with no schedule, no committee activity in three years, and a hard upstream dependency that is itself stalled. **Do not build adorn's roadmap around it.** But equally: do not assume the legacy escape hatch closes before the replacement lands, because closing it first would break a large fraction of the TypeScript server ecosystem with nothing to migrate to. **[Medium]**

---

## 3. Decorator metadata (Question 3)

### 3.1 What it is and when TypeScript shipped it

The [Decorator Metadata proposal](https://github.com/tc39/proposal-decorator-metadata) adds a `metadata` property to every decorator's context object and exposes the accumulated object on the class via `Symbol.metadata`. Child-class metadata objects use the parent's as their prototype, so metadata inherits.

**TypeScript 5.2 shipped it** ([TS 5.2 release notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-2.html), implementation by Oleksandr Tarasiuk, [PR #54657](https://github.com/microsoft/TypeScript/pull/54657)):

> "Whenever decorator functions are used, they now have access to a new `metadata` property on their context object… After all decorators on or in a class get run, that object can be accessed on the class via `Symbol.metadata`."

Requirements, per the same notes: a `Symbol.metadata` polyfill (`Symbol.metadata ??= Symbol("Symbol.metadata")` suffices for most cases), `target` of `es2022` or below, and `lib` including `"esnext"` or `"esnext.decorators"`. **[High]**

Stage caveat: as noted in [§1.2](#12-a-correction-to-the-briefs-terminology-the-proposal-is-currently-stage-27-not-stage-3), the tracker currently lists this proposal at **Stage 2.7**, last presented **2023-05**. It is standards-track but not final. **[High]**

**Empirically verified working on TypeScript 7.0.2** as part of the prototype in [§4.2](#42-option-b--method-level-contract-under-standard-decorators-the-primary-alternative) — `context.metadata` was writable inside a method decorator and readable afterwards via `Task[Symbol.metadata]`.

### 3.2 Can it replace `reflect-metadata` for adorn?

**Partly — and the part it replaces is the part adorn actually needs.** **[High]**

Split `reflect-metadata`'s two roles:

| Role | Can `context.metadata` replace it? | Notes |
|---|---|---|
| **Arbitrary key/value storage keyed to a class or member** — "which parameters of which methods carry which contracts" | **Yes, cleanly.** | This is adorn's `ContractRegistry` ([`implementation-plan-t0-t1.md` §2](./implementation-plan-t0-t1.md)) and it is exactly the proposal's intended use. Better than `reflect-metadata`: no global polyfill dependency, inheritance for free, and privacy available by using the metadata object as a `WeakMap` key. |
| **Compiler-emitted design-time types** (`design:paramtypes`) | **No.** | Nothing in the standard model emits type information. That is [microsoft/TypeScript#57533](https://github.com/microsoft/TypeScript/issues/57533), open and unmilestoned. |

**Conclusion for adorn.** If adorn moves to a method-level `@Contract({...})` form, the spec is supplied *explicitly by the author*, so it needs storage, not type reflection — and `context.metadata` covers storage completely. `reflect-metadata` can be dropped as a dependency in that path. If adorn stays legacy and wants P1.5's advisory type checks, it needs `reflect-metadata` and `design:paramtypes`, with the accompanying caveat already noted in the implementation plan: loading `reflect-metadata` switches `__decorate` onto its `Reflect.decorate` branch, so the wrapper-installation logic must be tested both with and without it loaded.

**A caution worth stating.** In legacy mode there is a real risk of `context.metadata` and `reflect-metadata` being conflated. They are unrelated mechanisms: `context.metadata` exists **only** in standard mode, and `Reflect.getMetadata` exists **only** where `reflect-metadata` is loaded. A dual-adapter design must keep them in separate adapters, both writing to the same decorator-agnostic registry.

---

## 4. Modern equivalents and workarounds (Question 4)

Seven candidate approaches, evaluated against a fixed benchmark: reproducing

```ts
test(@StringMinLength(10) message: string,
     @GreaterThanEqual(100) @LessThanEqual(1000) someNumber: number) { … }
```

with equivalent runtime behaviour and equivalent error-message quality.

### 4.1 Option A — stay on `experimentalDecorators`

**What breaks, and when.** On present evidence, in the compiler: **nothing, indefinitely.** See [§1.3](#13-is-experimentaldecorators-still-supported-is-it-deprecated-is-removal-planned). Verified working on TypeScript 7.0.2 GA.

The genuine costs are not compiler removal. They are:

1. **Consumer lock-out.** A consumer whose project uses standard decorators (because Angular 20+, or a library that requires them, or a team style rule) **cannot** use adorn's parameter syntax at all — TS1206, no workaround short of splitting compilation units. This is the concrete, present-tense cost, and it is already biting other libraries ([§1.4](#14-can-legacy-and-standard-decorators-coexist-in-one-compilation)).
2. **Babel users get silent breakage** (see the toolchain table below) — arguably worse than lock-out, because it fails quietly.
3. **Reputational drag.** "Requires a legacy flag" is a real adoption objection in 2026, regardless of technical merit.
4. **No evolution.** Legacy mode receives no feature work. `context.metadata`, `addInitializer`, and auto-accessors are unavailable.

**Toolchain reality for legacy parameter decorators** — three genuinely distinct capabilities, and "parameter decorators work" never implies "`design:paramtypes` works":

| Tool | Legacy decorators | Legacy **parameter** decorators | `emitDecoratorMetadata` |
|---|---|---|---|
| **tsc** (incl. TS 7 Go port) | Yes | Yes | **Yes** (reference impl.) |
| **SWC** | Yes | **Yes** (`_ts_param`) | **Yes** (`decoratorMetadata`) |
| **Oxc** (Vite 8 / Rolldown) | Yes | **Yes** | **Partial** |
| **esbuild** | Yes | **Yes** (`__decorateParam`) | **No — permanently** |
| **Babel** | Class/method/property only | **No — silently dropped** | No (third-party plugin only) |
| **Bun** | Yes | Yes | **Yes** (since 1.0.3) |
| **Deno** | Yes (schema-deprecated) | Yes | Yes |

Notes on the sharp edges:

- **esbuild** ships a dedicated `__decorateParam` helper, so parameter decorators work. *Verified empirically* on esbuild 0.28.1: the decorator fired correctly. But `emitDecoratorMetadata` is **silently ignored**, by explicit and permanent design — Evan Wallace, [esbuild#257](https://github.com/evanw/esbuild/issues/257): *"The `emitDecoratorMetadata` flag is intentionally not supported. It relies on running the TypeScript type checker… I will not be integrating the TypeScript compiler into esbuild."* Note esbuild's own changelog acknowledges that experimental decorators "can do certain things that are not possible with JavaScript decorators (such as decorating function parameters)".
- **Babel is the trap.** `@babel/plugin-proposal-decorators` `version: "legacy"` implements the *2015 stage-1* proposal, which never had parameter decorators. It does not error — it **drops the decorator and elides the now-unused import**. By contrast `version: "2023-11"` fails loudly with *"Decorators cannot be used to decorate parameters."* Mitigation is the third-party `babel-plugin-transform-typescript-metadata` ordered before the decorators plugin. **If adorn stays legacy, its documentation must call out Babel explicitly**, because the failure mode is contracts silently not running — precisely the "silent no-op" hazard already listed as risk #1 in the implementation plan.
- **Vite** changed underneath the common wisdom: **Vite 8 uses Oxc via Rolldown, not esbuild**, and Oxc *does* implement `emitDecoratorMetadata`, described in [Vite's docs](https://vite.dev/guide/features) as *"only partially supported. Full support requires type inference by the TypeScript compiler, which is not supported."* For Vite ≤7 the workaround is `unplugin-swc`.
- **Deno's status is commonly misreported.** Deno [1.40](https://deno.com/blog/v1.40) flipped the *default* to standard decorators but explicitly kept legacy: *"If you rely on the legacy 'experimental TypeScript decorators', you can still use them."* [PR #25735](https://github.com/denoland/deno/pull/25735) marked the options `deprecated: true` in the **config schema only** — a lint/editor annotation, not a removal. Both options remain on `main`. **[High]**
- **ts-node is effectively dormant** (last release v10.9.2, 2023-12-08) though not formally deprecated; `tsx` (esbuild-based) and Bun are the live alternatives.

### 4.2 Option B — method-level `@Contract({...})` under standard decorators (the primary alternative)

A single method decorator carries the whole per-parameter spec. Standard method decorators receive `(value, context)` and *"can optionally return a new method to replace it"* ([proposal README](https://github.com/tc39/proposal-decorators/blob/master/README.md)) — which is precisely the interception adorn needs, and it arrives through a **supported return value** rather than by imperatively reassigning `target[propertyKey]`.

**This was built and run, not merely designed.** Verified on TypeScript 7.0.2 in standard mode (`experimentalDecorators` off, `lib: ["es2022","esnext.decorators","dom"]`):

```ts
function Contract(spec: Record<number, Check[]>, names?: string[]) {
  return function <A extends any[], R>(
    original: (...args: A) => R,
    ctx: ClassMethodDecoratorContext
  ) {
    (ctx.metadata as any)[ctx.name] = spec;          // standard decorator metadata
    return function (this: any, ...args: A): R {     // returned replacement method
      for (const k of Object.keys(spec)) {
        const i = Number(k);
        const pname = names?.[i] ?? `arg${i}`;
        for (const c of spec[i])
          c(args[i], `${this?.constructor?.name}.${String(ctx.name)} parameter '${pname}'`);
      }
      return original.apply(this, args);
    };
  };
}

class Task {
  @Contract({ 0: [minLen(10)], 1: [gte(100)] }, ["message", "someNumber"])
  test(message: string, someNumber: number) { return `${message}:${someNumber}`; }
}
```

Output:

```
a long enough message:500
CAUGHT: Task.test parameter 'message': expected length >= 10, got "short"
CAUGHT: Task.test parameter 'someNumber': expected >= 100, got 5
metadata: ["test"]
```

**Error-message quality is preserved** — the diagnostic still names the class, method, parameter, constraint, and offending value, which [`contract-driven-development.md` §2.5](./contract-driven-development.md) identifies as one of adorn's genuine strengths against prior art. **[High]**

**What is gained:**

- Runs under standard decorators — no compiler flag, no consumer lock-out, works everywhere including Babel (which handles standard method decorators correctly).
- **Deletes the entire fragile subsystem.** No method rewriting by assignment, no `__decorate` descriptor race, and therefore **no `Object.defineProperty` monkey-patch** — which also removes the cross-feature bug in [`implementation-plan-t0-t1.md` §1.1](./implementation-plan-t0-t1.md), where an `@Enforce` field decorator can silently no-op because the patch swallows its `defineProperty` call.
- One decorator per method rather than N per method, so the "first decorator wraps, subsequent ones append" coordination dance disappears.
- `context.metadata` gives inheritance-aware storage for free.
- **Parameter names can be supplied explicitly**, which is *strictly more robust* than `toString()` parsing and survives minification ([§5](#5-the-parameter-name-problem)).

**What is lost — and this is the real cost:**

- **Locality.** The constraint no longer sits next to the parameter it constrains. On a six-parameter method, `{ 4: [gte(0)] }` requires counting. This is the entire ergonomic thesis of the library.
- **A positional correspondence the compiler cannot check.** `{ 0: [minLen(10)] }` on a method whose first parameter is a `number` is a type error TypeScript will not catch. Reordering parameters silently reassigns constraints. Mitigations exist — none complete:
  - *Name-keyed spec* (`{ message: [minLen(10)] }`) reads better and survives reordering, but the keys still cannot be tied to the signature by the type system, and it depends on names being recoverable or declared.
  - *Positional tuple* (`@Contract([[minLen(10)], [gte(100)]])`) can be made **partially type-safe** with a variadic-tuple type mapping each slot's checks to the corresponding parameter type — so `minLen` on a `number` slot would be a compile error. This is a genuine advantage over the current design, in which nothing type-checks the pairing at all. Worth prototyping; the type-safety claim is **not yet verified [Low]**, though the shape itself is proven practical — the `@freshgum/typedi` fork adopted exactly this form (`@Service([LOG_FUNCTION])`) when it dropped constructor parameter decorators ([§6.8](#68-the-convergent-answer-among-standard-decorator-native-libraries)).
  - *Duplicated names array* (as in the prototype above) is a maintenance hazard: a rename in the signature silently desynchronizes the messages.
- **Verbosity** on methods with many constrained parameters.
- **Breaking change** for every existing user of the parameter syntax.

### 4.3 Option C — standard method decorators plus `addInitializer` and `context.metadata`

A variant of B, worth separating because the brief asks for it. `addInitializer` on a method decorator registers a callback that runs *"during class construction, before any class fields are initialized"*, with `this` bound to the instance.

**Assessment: useful, but not for parameter contracts.** The wrapping in Option B is done by *returning a replacement function*, which is simpler, has no per-instance cost, and installs once on the prototype. `addInitializer` earns its place elsewhere in adorn's roadmap:

- **Per-instance installation** — arrow-function class properties as decoration targets, currently deferred to Tier 2 in the implementation plan, need per-instance work and this is the mechanism.
- **Per-instance state** — `Memoize`'s cache is currently prototype-level and therefore shared across all instances (a known bug, [`implementation-plan-t0-t1.md` §11](./implementation-plan-t0-t1.md)). `addInitializer` gives each instance its own cache naturally.
- **Class invariants** — registering a check to run at construction, which the DbC gap analysis lists as missing.

So: adopt `addInitializer` for those, but do not use it to implement parameter contracts. **[Medium]**

### 4.4 Option D — compile-time transformer (ts-patch / typia-style, or a Babel/SWC plugin)

**The idea.** A custom TypeScript transformer sees the real AST — parameter names, real types, and decorator positions — and synthesizes contract code. This is the only approach that could recover the *original* per-parameter syntax under standard decorators while also solving the parameter-name problem, and it could derive checks from declared TypeScript types rather than hand-written predicates ([typia](https://typia.io/docs/)-style).

**The cost is severe, and it just got worse.**

1. **It is not stock `tsc`.** Transformers require [ts-patch](https://github.com/nonara/ts-patch) (ttypescript is deprecated and caps out below TS 5.0). Consumers must adopt a patched compiler.
2. **Bundlers bypass it.** Vite, Next.js, and webpack run their own TypeScript pipelines; each needs a separate plugin integration.
3. **TypeScript 7 is an extinction-level event for this category.** The compiler is now Go. A TypeScript-language transformer plugin cannot load into a Go binary. typia's response was to **rewrite its transformer in Go** and ship it behind a bespoke `ttsc`/`ttsx` toolchain, with `@ttsc/unplugin` for bundlers; stock `tsc`, `ts-node`, and `tsx` cannot apply it ([typia: TypeScript-Go setup](https://typia.io/docs/setup/tsgo/)). ts-patch's own README is non-committal: *"The TypeScript team has also announced a future Go-based compiler line. ts-patch will evaluate that implementation as a separate compatibility track."* **[High]**
4. **TypeScript has no first-party transformer plugin API.** [microsoft/TypeScript#54276](https://github.com/microsoft/TypeScript/issues/54276) remains a proposal.

**Verdict.** For a project of adorn's size — a single-commit prototype with no test suite and no CI — this is disproportionate. Rewriting a transformer in Go to keep a decorator ergonomic is not a proportionate response. It is the *technically strongest* answer to both the syntax and the parameter-name problem, and it should be recorded as a Tier 3 possibility, but adopting it now would make the toolchain the product. **[High]**

### 4.5 Option E — Proxy-based interception

Wrap instances (or methods) in a `Proxy` whose `apply` trap validates arguments — the mechanism [`decorator-contracts`](https://github.com/final-hill/decorator-contracts) uses for invariants.

**The disqualifying limitation:** the `apply` trap receives `(target, thisArg, argumentsList)` — **an array of values, with no parameter names** ([MDN: handler.apply()](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy/Proxy/apply)). A Proxy is an *interception* mechanism, not a *declaration* mechanism. It answers "how do I run a check on every call", which adorn already solves; it does not answer "how does the author declare which parameter gets which constraint", which is the actual question. It still needs a decorator or explicit spec to know what to check. **[High]**

Where Proxies do earn their place: **class invariants** — re-checking whole-object consistency before and after every method and accessor, which is the `decorator-contracts` use case and a genuine gap in adorn ([`contract-driven-development.md` §3](./contract-driven-development.md)). Also a per-instance runtime cost on every property access, which argues for gating it behind the trust-model configuration.

### 4.6 Option F — non-decorator higher-order function API

```ts
const test = contract(
  { message: minLen(10), someNumber: between(100, 1000) },
  (message: string, someNumber: number) => { … }
);
```

Fully standard, zero compiler flags, works in plain JavaScript, and **fully type-safe** — a mapped type can require the spec keys to match the function's parameters with correct types, which no decorator approach achieves. This is the Racket/`io-ts` combinator idiom.

The cost is that it stops being a decorator library. It does not compose with class methods naturally (`this` binding, prototype placement, inheritance), and it abandons the annotation ergonomics that are adorn's reason to exist. Worth having as a **supplementary** export for free functions — which decorators cannot target at all under either model, since function decorators are themselves a separate Stage-1 proposal. Not a replacement for the class-method story. **[High]**

### 4.7 Option G — ship both adapters

Publish `adorn/legacy` and `adorn/modern` over one shared, decorator-agnostic contract engine. Consumers pick by their `tsconfig`.

This is not a distinct mechanism but a *packaging* strategy over A and B, and the implementation plan's layering rule ([§2](./implementation-plan-t0-t1.md): predicates, registry, result handling, configuration, and message formatting never import a decorator type) already makes it cheap. Cost: two adapters to test, two documentation paths, and a real risk of behavioural drift between them. Mitigation: a shared conformance test suite run against both adapters.

**This has now been done in production by a comparable library.** MikroORM v7.0.0 (2026-03-11) split its decorators into a dedicated package with `/legacy` and `/es` entry points over a shared engine ([§6.5](#65-mikroorm--shipped-exactly-the-dual-adapter-design-recommended-here)). It is worth copying not only the structure but the *framing*: MikroORM documents the standard-mode path as a flavour with an explicit, named capability loss rather than as an equivalent. Understating the difference is what turns a dual-track library into a support burden.

### 4.8 Comparison

Scored 1–5, higher is better. Scores are judgements, not measurements.

| Approach | Ergonomics (keeps per-param feel) | Robustness (mechanism fragility) | Toolchain cost | Future-proofing | Overall |
|---|---|---|---|---|---|
| **A. Stay legacy** | **5** — exact current syntax | **2** — method rewriting, `defineProperty` patch, `toString()` names, Babel silently drops | **4** — one flag; broad support; Babel and esbuild-metadata caveats | **2** — no removal announced, but non-standard, consumer lock-out, no evolution | **3.25** |
| **B. Method-level `@Contract`** | **3** — declarative, but loses locality; unchecked index/name↔param link | **4** — supported replacement-return, no patch, explicit names | **5** — stock tsc, no flags, works everywhere | **4** — standards-track, though itself Stage 2.7 and unshipped in engines | **4.0** |
| **C. B + `addInitializer`** | 3 (same as B) | **4** | **5** | **4** | **4.0** — adopt for per-instance state and invariants, not for parameter contracts |
| **D. Compile-time transformer** | **5** — could restore exact syntax *and* real types | **5** — compiler-supplied names and types | **1** — ts-patch/ttsc, per-bundler plugins, **Go rewrite required for TS 7** | **2** — deep lock-in to a non-first-party API with no stability guarantee | **3.25** — strongest capability, disproportionate cost |
| **E. Proxy** | **1** — no declaration mechanism, no names | **3** — standard, but per-call/access cost | **5** | **5** | **3.5** — wrong tool for parameters; **right tool for invariants** |
| **F. HOF `contract(spec, fn)`** | **2** — not annotation-shaped; but **fully type-safe** | **5** | **5** | **5** | **4.25** — best engineering, worst fit to adorn's premise |
| **G. Both adapters** | **5** / 3 (consumer's choice) | **3** — inherits A's fragility in one path | **3** — two adapters, two test matrices, drift risk | **5** — hedged either way | **4.0** — **shipped by MikroORM v7 (2026-03)**, see [§6.5](#65-mikroorm--shipped-exactly-the-dual-adapter-design-recommended-here) |

**Reading the table.** No option dominates. A wins on ergonomics and loses on robustness; B wins on robustness and toolchain and loses on ergonomics; F wins on engineering and loses on identity; D wins on capability and loses on cost. The scores deliberately do **not** penalise A for "imminent removal", because the evidence does not support imminent removal — they penalise it for consumer lock-out and stagnation, which are present-tense and real.

---

## 5. The parameter-name problem

adorn recovers parameter names by regex-parsing `Function.prototype.toString()` (`src/Core/common.ts:13-17`). [`implementation-plan-t0-t1.md` §1.4](./implementation-plan-t0-t1.md) already establishes there is no runtime alternative in JavaScript, and that `emitDecoratorMetadata` supplies types, not names. This document adds the empirical damage assessment and the cross-approach comparison.

**Empirically demonstrated failure** (esbuild 0.28.1, `--minify`):

```
=== unminified ===   param names: ["message","someNumber"]
=== esbuild --minify === param names: ["s","t"]
```

Error messages degrade from `Task.test(message, someNumber) parameter 'someNumber'` to `Task.test(s, t) parameter 't'` — in production, which is exactly where diagnostics matter most. **[High]**

This is a known-hazardous pattern with a famous precedent. TC39's own [function-implementation-hiding proposal](https://github.com/tc39/proposal-function-implementation-hiding) cites it as motivating evidence:

> "AngularJS's reliance on `f.toString()` to inspect the parameter names of a function. It would then use these as part of its dependency injection framework. This made what was previously a non-breaking change — modifying the name of a parameter — into a breaking one."

and notes it "makes it impossible to use otherwise-semantics-preserving minification tools in combination with this mode of AngularJS."

**How each approach fares:**

| Approach | Parameter names | Assessment |
|---|---|---|
| **A. Stay legacy** | `toString()` parsing only | **Unchanged.** Broken under minification, and by destructuring, defaults containing parens, and parenless arrows. |
| **B. Method-level `@Contract`** | **Author-declared**, or name-keyed spec | **Strictly better.** Survives minification. Cost: duplication that can desynchronize on rename. |
| **D. Transformer** | Compiler-supplied | **Best possible.** No duplication, no fragility. |
| **E. Proxy** | None | **Worse.** `apply` gives values only. |
| **F. HOF** | Spec keys are the names | **Best possible**, and type-checkable against the signature. |
| **Standardized param decorators** *(hypothetical)* | `context.name` | **Best possible** — the proposal supplies it directly. Not available. |

**Note the inversion.** The mechanism adorn would move to in order to *lose* per-parameter syntax is the same mechanism that would *fix* its worst robustness bug. Options B, D, and F all improve names; only A leaves them broken.

Whatever path is chosen, the implementation plan's guidance stands: harden the parser, degrade gracefully to `argN`, allow explicit override, and **document the minification limit honestly** rather than over-promising.

---

## 6. How comparable libraries handled this

The precedent splits along **one clean line: did the library need parameter decorators or `design:type`?**

| Needed neither → **migrated** | Needed either → **stayed legacy, indefinitely** |
|---|---|
| decorator-contracts (v0.25.0, 2023-08) | NestJS, InversifyJS, TypeORM, TypeDI, tsyringe, routing-controllers, TypeGraphQL, class-transformer |
| MikroORM (v7.0.0, 2026-03) — as a *second flavour*, not a replacement | |

**Three years after TypeScript 5.0, no library that depends on parameter decorators has migrated.** One major framework (Angular) redesigned its API to stop needing them — and even that migration is incomplete. **[High]**

### 6.1 Angular — migrated, by replacing parameter decorators with a function

The most instructive case, because Angular *did* the migration and the record shows exactly what it cost.

Angular commit [`aad05eb`](https://github.com/angular/angular/commit/aad05ebeb44afad29fd989019638590344ba61eb) (PR [#49492](https://github.com/angular/angular/pull/49492)), *"feat(core): support usage of non-experimental decorators with TypeScript"*, states:

> "Angular's class decorators (Component, Directive, Pipe, Injectable, NgModule) are already compatible with standard decorators… **Angular constructor dependency injection that requires parameter decorators is not supported. The standard decorator specification does not support parameter decorators.** The `inject` function must be used for all cases that previously required a parameter decorator. This includes such decorators as `Inject`, `Optional`, `Self`, `SkipSelf`, `Host`, and `Attribute`."

Angular ships a [migration schematic](https://angular.dev/reference/migrations/inject-function) that rewrites `constructor(private service: MyService) {}` into `private service = inject(MyService);`, and its docs say `inject` *"offers more accurate types and better compatibility with standard decorators, compared to constructor-based injection."* **[High]**

**The lesson for adorn is direct and uncomfortable.** Angular did not find a clever way to keep parameter decorators. It **changed the API** so parameter decorators were no longer needed, and shipped automated tooling to move users. The equivalent move for adorn is Option B or F — accept a different authoring shape.

**But the migration is materially incomplete, which is itself the most useful part of the precedent.** **[High]**

- The v16 change was **types-only** — Angular's own decorators were always compiled by `ngtsc`, so this removed a *requirement*, not a dependency.
- **`ng new` still generates `experimentalDecorators: true` as of Angular v22 (July 2026).** The PR to remove it from the CLI schematic ([angular-cli#31984](https://github.com/angular/angular-cli/pull/31984)) was **closed unmerged as stale on 2026-05-27**.
- `@Inject`, `@Optional`, `@Self`, `@SkipSelf`, and `@Host` are **not deprecated**. The issue proposing exactly that ([angular#50439](https://github.com/angular/angular/issues/50439)) was closed 2023-07-05 by pkozlowski-opensource: *"This is a larger question of moving away from param decorators that would [need] detailed design, RFC etc. - we track it in our backlog."* No RFC was ever published.
- Angular's **JIT compiler deliberately does not support standard decorators.** Compiler lead alxhub ([angular#58251](https://github.com/angular/angular/issues/58251), 2024-10-17): *"JavaScript standard decorators don't include parameter decorators, which Angular uses for dependency injection. As a result, we can't really fully support them."*

So even the ecosystem's flagship migration is, three years on, a *recommended alternative* plus a codemod — not a removal. **[High]**

Two further qualifications. First, Angular had an escape adorn does not: DI can be expressed as a *value-producing call* (`inject(Token)`) in a field initializer, because DI produces a value. A precondition on an *incoming argument* has no such expression site — you cannot write `const message = check(minLen(10))` and have it refer to the caller's argument. Second, Angular's public reasoning asserts that `experimentalDecorators` "will be removed"; as established in [§1.3](#13-is-experimentaldecorators-still-supported-is-it-deprecated-is-removal-planned) that is a framework's forward-looking statement, not a TypeScript commitment. **[Medium]**

### 6.2 NestJS — declined explicitly, and restated as recently as February 2026

NestJS is the most-cited case and its maintainers have been unusually explicit. From [nestjs/nest#11414](https://github.com/nestjs/nest/issues/11414), kamilmysliwiec, 2023-04-04: *"I don't think we'll support JS decorators till the metadata support & parameter decorators are implemented."*

The current statement is in the [v12.0.0 roadmap (#16391)](https://github.com/nestjs/nest/issues/16391), February 2026:

> "Depends on: 1. whether TS team adds design paramtype metadata support to stage 3 decorators (currently unsupported) 2. method parameter decorators proposal is moved to stage 3 (currently unsupported). For now, TS decorators are simply better than stage 3 for Nest users (there's no feature parity between the two). Moving to stage 3 would be extremely painful for every framework user at the moment."

> "Migration is not impossible, just extremely harmful to the ecosystem… The same goes for Stage 3 decorators - migrating now would be premature and irresponsible."

The v12 roadmap contains **no decorator migration** at all. Notably, the metadata dependency now constrains NestJS's *tooling* choices — it cannot use `node:test` or plain esbuild, because neither emits design metadata, and runs SWC/Oxc specifically for it. **[Medium]** (quotes gathered by delegated search; the tsconfig requirement is confirmed from the `nest new` starter template and `@nestjs/core` peer dependencies rather than the docs site, which is a client-rendered SPA and could not be fetched.)

### 6.3 InversifyJS — declined and closed; the clearest statement of the problem

Inversify **8.0.0 shipped 2026-03-16** and its release and planning posts **do not mention standard decorators at all** — v8 was about naming consistency, type safety, and ESM. The migration issue ([inversify#1507](https://github.com/inversify/InversifyJS/issues/1507)) was closed 2024-04-18. Current docs still require both flags.

Maintainer notaphplover's explanation is the crispest articulation of the whole ecosystem's bind:

> "Inversify requires **parameter** decorators which are not standardized… Stage 3 decorators would allow us to express `@inject(TYPES.Weapon) public katana: Weapon` [as a property] But they do not allow us to express `constructor(@inject(TYPES.Weapon) public katana: Weapon)` Because the second example demands parameter decorators."

> "If [the parameter decorators extension] is ever included in the standard, we will be able to go for it, but until that I would prefer to keep the issue closed."

Inversify does offer decorator-free escape hatches — `decorate()` (programmatic decorator application) and `toResolvedValue()` (dependencies as an explicit array of service identifiers) — but these are binding-side APIs, not a migration; the library still requires both flags. The actual standard-decorators answer was a **fork**: `@mscharley/dot`, which supports both models and notes that *"`emitDecoratorMetadata` is not required, and is not used if enabled."* **[Medium]**

### 6.4 TypeORM — intent stated in 2023, never executed; and a very recent restatement

[typeorm#9862](https://github.com/typeorm/typeorm/issues/9862), pleerock, 2023-03-16: *"Yes, we will support new standard. Contributions are welcomed… However we need to avoid breaking changes."* Auto-closed as stale 2025-09-18. On the `design:type` question specifically, the only stated plan was *"users will be able to specify the type explicitly in the column options"* — a user-facing breaking change dressed as a config option.

**The most recent data point in this entire document** comes from TypeORM collaborator `alumni` on **2026-07-08** — eleven days before this research — correcting a claim that TypeScript 6 deprecates the flag:

> "This is not true, the experimental decorators are not deprecated and are not going anywhere anytime soon… We will consider it the future, but to be able to implement them we will need to do some refactoring and split TypeORM into packages… the first priority would be driver and platform support. If you don't want to use decorators, you can define entities using entity schemas."

This independently corroborates [§1.3](#13-is-experimentaldecorators-still-supported-is-it-deprecated-is-removal-planned) from a maintainer with strong incentive to know. **[Medium]**

### 6.5 MikroORM — **shipped exactly the dual-adapter design recommended here**

This is the single most directly applicable precedent, and it is recent. **MikroORM v7.0.0 (2026-03-11)** moved all decorators into a dedicated `@mikro-orm/decorators` package offering **two entry points — `/legacy` and `/es`.** Maintainer B4nan:

> "All decorators have been moved to a dedicated `@mikro-orm/decorators` package and are now offered in two flavors - legacy (TypeScript experimental) and ES spec… If you're using NestJS or another framework that requires `experimentalDecorators: true`, the legacy import will keep working just fine. **Note that ES decorators don't support metadata reflection, so you'll need to provide scalar property types explicitly.**"

How MikroORM replaced `design:type` under the ES path — three options, all instructive for adorn:

1. **Explicit `type:` options.** The new default metadata provider does no reflection and *throws*, asking for `type` or `entity`. Explicitness over inference.
2. **`TsMorphMetadataProvider`** — reads types from source via the TypeScript compiler API. A transformer-adjacent approach (cf. [§4.4](#44-option-d--compile-time-transformer-ts-patch--typia-style-or-a-babelswc-plugin)), still supported.
3. **`defineEntity`** — a decorator-free builder helper, now what the entity generator emits *by default* (cf. [§4.6](#46-option-f--non-decorator-higher-order-function-api)).

`context.metadata` is used only as a per-class options store, **not** as a `design:type` substitute — exactly the split described in [§3.2](#32-can-it-replace-reflect-metadata-for-adorn). MikroORM lost nothing to missing parameter decorators; it only ever used class and property decorators. **[Medium]**

**This validates Option G.** A mature ORM concluded that shipping both adapters over one engine was the right answer, and shipped it. Note the honesty of its framing: the ES path is a *flavour*, not a replacement, and it comes with a documented capability loss.

### 6.6 `decorator-contracts` — migrated cleanly, and validates Option B's shape

[`final-hill/decorator-contracts`](https://github.com/final-hill/decorator-contracts) is the nearest neighbour in intent (see [`contract-driven-development.md` §1.6](./contract-driven-development.md)): `@invariant`, `@requires`/`@demands`, `@ensures`, `@rescue`, behavioural subtyping, `Proxy`-based enforcement, and a production-toggleable checked mode.

**It migrated to standard decorators in v0.25.0 (2023-08-27)** — among the earliest real migrations in the ecosystem — tracked in [issue #250](https://github.com/final-hill/decorator-contracts/issues/250). Its tsconfig has **neither** legacy flag, and its source uses genuine standard-decorator machinery: `export const demands = (predicate) => (_feature, ctx) => …` with `ctx.addInitializer`, `ctx.metadata`, and `Symbol.metadata`. Current version v1.0.0 (2025-05-24). **[Medium]**

**The mechanism is precisely Option B.** Argument-level contracts are expressed through a *method* decorator that receives the arguments:

```ts
@demands((_self, x: number) => x >= 0)
```

It never needed parameter decorators, which is exactly why it faced no migration crisis. This is direct prior art that **the method-level form is a workable idiom for contracts, not a degraded consolation prize** — the closest library to adorn in intent chose that shape voluntarily and migrated without drama.

One caution from its README, relevant to [§4.5](#45-option-e--proxy-based-interception): because it uses `Proxy`, native `#private` fields and the `accessor` keyword are **not supported**. Proxy-based enforcement carries real language-feature costs.

### 6.7 The rest — a field of stalled and abandoned projects

| Library | Status |
|---|---|
| **TypeGraphQL** | [#1411](https://github.com/MichalLytek/type-graphql/issues/1411) frozen by the owner pending the proposal. MichalLytek, 2025-04-15: *"all the TS decorators ecosystem is blocked on missing parameters decorators 😞"* |
| **tsyringe** | [#225](https://github.com/microsoft/tsyringe/issues/225) open since 2023-03-16. Got TS 5 *type* compatibility in v4.8.0, no migration. Thread's own conclusion: *"the new decorator spec does not support parameter injection at all and probably won't for a long time."* Standard-decorator successor: `di-wise`. |
| **TypeDI** | Effectively dead — latest release **0.10.0, 2021-01-15**. [#1178 "Stage 3 decorator support"](https://github.com/typestack/typedi/issues/1178) open since 2023-08-26 with **zero comments**. |
| **routing-controllers** | Custodial maintenance only; README demands both flags. **No issue, discussion, or roadmap entry mentioning standard decorators was found at all.** Worst-positioned (needs both parameter decorators *and* `emitDecoratorMetadata`). |
| **class-validator** | Still legacy, but the blocker is **only cosmetic** — property decorators exist in the standard with a different signature. Maintainer braaar, [#1929](https://github.com/typestack/class-validator/issues/1929): *"Does that affect this project at all? Our decorators are used for class properties only."* He has also said he is *"not investing much time in this project."* |
| **class-transformer** | **Frozen** — latest release 0.5.1, 2021-11-22, pinned to `typescript: ^4.9.5`. `@Type()` reads `design:type`, which has no standard equivalent. [#1510](https://github.com/typestack/class-transformer/issues/1510) closed "not planned" without explanation. |

**[Medium]** across this table; "abandoned"/"dead" are inferred from release cadence and unanswered maintenance issues, not from formal notices.

### 6.8 The convergent answer among standard-decorator-native libraries

Every DI library actually *built* on standard decorators replaced parameter decorators with one of two shapes:

1. **An `inject()` function** called in the constructor body or as a default parameter value — Angular's pattern. `di-wise` advertises *"Built on ECMAScript Stage 3 Decorators… No need for `reflect-metadata`… No TypeScript legacy `experimentalDecorators` required"*, with `constructor(spell = inject(Spell))`.
2. **A class-level positional array.** The community TypeDI fork `@freshgum/typedi` abandoned constructor parameter decorators for `@Service([LOG_FUNCTION])` — **the same positional-tuple shape proposed as Option B's type-safe variant** in [§4.2](#42-option-b--method-level-contract-under-standard-decorators-the-primary-alternative).

Both are API redesigns, not ports. Neither preserves the per-parameter annotation. **[Medium]**

**Verification note for §§6.2–6.8.** These stances were gathered by a delegated research pass. The inline citations are primary (GitHub issues, release posts, commits), but the individual quotes were not each re-fetched by this document's author. Before any of them is used as a *decision input* rather than as corroborating context, re-check it against the source. The **direction** of the evidence — nobody with parameter decorators has migrated — is **[High]** confidence; individual quotes and version numbers are **[Medium]**.

---

## 7. Recommendation

### 7.1 The recommendation

**Adopt a dual-track design, with the method-level form promoted to first-class status. Concretely:**

1. **Keep the per-parameter syntax on `experimentalDecorators`.** Do not deprecate it, do not apologise for it, and do not plan a migration away from it. The evidence does not support the "strategic risk" framing: the flag survived the 6.0 deprecation sweep, is absent from every 7.0 removal list, was deliberately ported to the Go compiler with `__param` intact, and demonstrably works on TypeScript 7.0.2 GA. This is adorn's differentiator and there is no standards-track replacement on any schedule.

2. **Build the method-level `@Contract({...})` form now, as a co-equal API — not a fallback.** It is verified working under standard decorators on current TypeScript. It unlocks the consumers that Option A locks out, and it is the *only* path that reaches users who cannot flip the flag. **`decorator-contracts` — the library closest to adorn in intent — chose exactly this shape and migrated on it in 2023** ([§6.6](#66-decorator-contracts--migrated-cleanly-and-validates-option-bs-shape)), which is strong evidence it is a legitimate idiom rather than a downgrade.

3. **Make the contract engine the product and the decorators a thin skin over it.** This is already the implementation plan's [§2 layering rule](./implementation-plan-t0-t1.md) and it should be treated as inviolable: `Core/`, `Contracts/`, message formatting, and configuration never import a decorator type. Only `Adapters/legacy/` and `Adapters/stage3/` touch `target`/`propertyKey`/`descriptor`/`context`. Enforce it with a lint rule or an import-boundary test, not by convention — the implementation plan's own risk #7 identifies silent violation of this layering as what would make a future migration expensive.

4. **Run one conformance suite against both adapters.** Same predicates, same violation messages, same configuration semantics. Drift between adapters is the main failure mode of Option G.

   > **This is not a novel design — it shipped in a mature library four months ago.** MikroORM v7.0.0 (2026-03-11) moved its decorators into a dedicated package with `/legacy` and `/es` entry points over one engine ([§6.5](#65-mikroorm--shipped-exactly-the-dual-adapter-design-recommended-here)). Copy its framing too: the standard-mode path is documented as a *flavour with a stated capability loss*, not as a drop-in equivalent. Being honest that the two adapters are not at parity is what keeps the dual-track design from becoming a support burden.

5. **In the standard-mode adapter, use `context.metadata` for the registry and drop `reflect-metadata`.** In the legacy adapter, keep `reflect-metadata` only if P1.5's advisory type checks are actually built, and test the wrapper both with and without it loaded.

6. **Document the toolchain caveats prominently**, especially the two silent failures: **Babel drops legacy parameter decorators without error**, and **esbuild ignores `emitDecoratorMetadata` permanently**. A contract that silently does not run is worse than a crash.

### 7.2 Answering the brief's specific questions

**"Is relying on experimental/non-standard config an acceptable price?"** **Yes, for this feature, on current evidence.** It is a single boolean in `tsconfig.json`, supported by the reference compiler and every major transpiler except Babel, and actively maintained through a full compiler rewrite. Judged against the actual alternative — deleting the feature — the price is low. The honest caveat is that this is a bet on continued TypeScript support, and the bet has no contractual backing beyond "no removal announced" plus revealed preference.

**"Is extra base machinery an acceptable price?"** **Only the machinery that is justified independently.** The decorator-agnostic core, the registry, and the adapter split are all worth building regardless of how the decorator question resolves — they are how the library becomes testable. A Go-rewritten compile-time transformer is not; that would make the toolchain the product.

**"Does a viable path require abandoning the per-parameter syntax?"** **No — and this is the key finding, so it should be stated precisely.**

- Keeping the per-parameter syntax requires `experimentalDecorators`, which is available, healthy, and broadly supported today. **[High]**
- Serving standard-decorator consumers requires abandoning it **for those consumers**. **[High]**
- Serving *both* requires two adapters, which the planned architecture already accommodates cheaply.

So the per-parameter syntax need not be abandoned. What must be abandoned is the assumption that it can be adorn's **only** authoring form.

### 7.3 The main tradeoff, stated plainly

**adorn's headline feature is permanently non-standard, and no amount of engineering changes that.** The choice is between:

- keeping a distinctive, ergonomic feature that requires a compiler flag and locks out standard-decorator consumers; or
- adopting a portable, more robust, less distinctive authoring form.

The recommendation refuses the choice and pays for both — roughly one extra adapter plus a shared conformance suite. That is the right call **only because** the core work (decorator-agnostic engine, registry, hardened parameter names, real tests) is required under every scenario. If that core is not built, the dual-track plan collapses into two divergent implementations of a prototype, which would be worse than either branch alone.

A secondary tradeoff deserves naming: **the method-level form is not merely a compatibility shim — it is arguably the better engineering.** It deletes the method-rewriting subsystem, the `Object.defineProperty` patch, and the `toString()` name parsing; it admits partial type-checking of the constraint↔parameter pairing; and it matches what `decorator-contracts`, `icontract`, and every other mature contract library actually does. The per-parameter syntax is the more beautiful API. The method-level one is the more defensible implementation. Shipping both means adorn does not have to decide which of those matters more — the user does.

### 7.4 What would change this recommendation

| If this happened | Then |
|---|---|
| TypeScript formally deprecates `experimentalDecorators` (a real deprecation diagnostic, or an entry on a removal list) | Escalate immediately. Option B becomes the primary path; the legacy adapter enters maintenance. This is the single most important thing to monitor. |
| The parameter-decorators proposal reaches Stage 2+ with committee activity | Re-plan. The proposal's design (`context.name`, value-wrapping return) is *better* than legacy and would let adorn delete its most fragile code. Watch [tc39/proposal-class-method-parameter-decorators](https://github.com/tc39/proposal-class-method-parameter-decorators) and the parent proposal's stage. |
| A browser ships standard decorators natively | The "both are transpiled dialects" argument in §1.2 weakens; standard mode gains real weight. |
| [microsoft/TypeScript#57533](https://github.com/microsoft/TypeScript/issues/57533) is accepted (design-time types in standard metadata) | The last capability gap in Option B closes; P1.5's type checks become available in standard mode. **Currently unlikely** — Ryan Cavanaugh has said it is *"very unlikely"* and that the team is *"increasingly moving away from any type-based emit in all forms"* ([§1.5](#15-what-emitdecoratormetadata-does-and-whether-there-is-a-standard-counterpart)). Plan as if this will not happen. |
| NestJS or InversifyJS ships standard-decorator support | The strongest possible signal that the gaps closed. Both have publicly conditioned migration on exactly the two blockers in this document; either shipping would mean a blocker moved. Cheap to monitor, high information value. |
| adorn acquires users who need minification-safe messages | Raise the priority of the explicit-names path (B) or reconsider the transformer (D). |

**Recommended review cadence:** re-check the first two rows every six months. Nothing in the current evidence justifies more frequent attention.

---

## 8. Confidence summary

| Claim | Confidence | Basis |
|---|---|---|
| Standard decorators do not support parameter decorators | **High** | TS 5.0 notes + proposal FAQ + empirical TS1206 |
| `experimentalDecorators` works in TypeScript 7.0.2 with parameter decorators and metadata | **High** | Empirical, this machine, 2026-07-19 |
| `experimentalDecorators` is not formally deprecated and no removal is announced | **High** | Absent from TS 6.0 deprecation list and TS 7.0 removals; ported to Go compiler |
| `experimentalDecorators` will still exist in N years | **Low** | Inherently speculative; no commitment beyond "foreseeable future" (TS 5.0) |
| Legacy and standard decorators cannot mix in one compilation | **High** | Per-compilation flag; corroborated by a real-world report |
| No standard counterpart to `emitDecoratorMetadata` | **High** | TS 5.0 notes + open unmilestoned #57533 + empirical TS5052 |
| TypeScript is unlikely to ever add type-based metadata to standard decorators | **Medium** | Ryan Cavanaugh on #57533 (2025-03-28); quote gathered by delegated search |
| Parameter-decorators proposal is Stage 1 and dormant since 2023-03 | **High** | TC39 tracker + repo metadata + unanswered issue thread |
| Committee members actively oppose parameter decorators | **Medium** | tc39/proposal-decorators#47 quotes; gathered by delegated search, not read directly |
| Decorators and Decorator Metadata currently listed at Stage 2.7 | **High** | TC39 proposals tracker (current) |
| The 2.7 demotion occurred ~May 2026 and relates to test262 coverage | **Medium** | One conference write-up; TC39 notes not read directly; the proposal README body still reads as Stage 3 |
| Babel silently drops legacy parameter decorators | **High** | Delegated empirical test; consistent with Babel's documented "legacy" = 2015 proposal |
| esbuild permanently refuses `emitDecoratorMetadata` | **High** | Maintainer statement, esbuild#257 |
| Method-level `@Contract` works under standard decorators with `context.metadata` | **High** | Empirical prototype, TS 7.0.2 |
| Parameter names are lost under minification | **High** | Empirical, esbuild `--minify` |
| Angular migrated by replacing parameter decorators with `inject()` | **High** | Angular commit `aad05eb` / PR #49492 |
| Angular's migration is incomplete (`ng new` still emits the flag; param decorators not deprecated) | **Medium** | angular-cli#31984 closed stale; angular#50439, #58251; gathered by delegated search |
| No library dependent on parameter decorators has migrated in 3 years | **High** | Consistent across NestJS, Inversify, TypeORM, TypeDI, tsyringe, routing-controllers, TypeGraphQL |
| `decorator-contracts` migrated to standard decorators using method-level argument contracts | **Medium** | v0.25.0 release notes + issue #250 + source; gathered by delegated search |
| MikroORM v7 ships dual `/legacy` and `/es` decorator entry points | **Medium** | v7.0.0 release material; gathered by delegated search |
| Individual libraries' current `tsconfig` requirements and version numbers | **Medium** | Inferred from issue threads, release posts, and a third-party survey; not each re-verified against current docs |
| Type-safe positional tuple spec (`@Contract([[…],[…]])`) is achievable | **Low** | Reasoned from variadic tuple types; **not prototyped**. Note `@freshgum/typedi` ships this shape, which is weak corroboration that it is at least practical |

---

## References

Accessed 2026-07-19. Empirical results produced locally against `typescript@7.0.2` and `esbuild@0.28.1`.

**TypeScript — official**
- TypeScript 5.0 release notes (decorators; "does not allow decorating parameters"). https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-0.html
- TypeScript 5.2 release notes (Decorator Metadata). https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-2.html
- TSConfig: `experimentalDecorators`. https://www.typescriptlang.org/tsconfig/experimentalDecorators.html
- TSConfig: `emitDecoratorMetadata`. https://www.typescriptlang.org/tsconfig/emitDecoratorMetadata.html
- Announcing TypeScript 7.0 RC (2026-06-18). https://devblogs.microsoft.com/typescript/announcing-typescript-7-0-rc/
- Announcing TypeScript 7.0 (2026-07-08). https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
- Progress on TypeScript 7 — December 2025. https://devblogs.microsoft.com/typescript/progress-on-typescript-7-december-2025/
- microsoft/TypeScript#54500 — 6.0 Deprecation List. https://github.com/microsoft/TypeScript/issues/54500
- microsoft/TypeScript#57533 — Expose design-time type information in TC39 decorator metadata (open). https://github.com/microsoft/TypeScript/issues/57533
- microsoft/TypeScript#54276 — A minimal custom transformer plugin proposal. https://github.com/microsoft/TypeScript/issues/54276
- microsoft/TypeScript#54657 — Decorator metadata implementation. https://github.com/microsoft/TypeScript/pull/54657
- microsoft/typescript-go#2343 — `--experimentalDecorators` and `--emitDecoratorMetadata` (merged 2025-12-12). https://github.com/microsoft/typescript-go/pull/2343
- microsoft/typescript-go — Discussion #741, "Future of decorators" (no maintainer replies). https://github.com/microsoft/typescript-go/discussions/741

**TC39**
- tc39/proposals — proposals tracker (Decorators and Decorator Metadata under Stage 2.7). https://github.com/tc39/proposals/blob/main/README.md
- tc39/proposals — Stage 1 proposals list. https://github.com/tc39/proposals/blob/main/stage-1-proposals.md
- tc39/proposal-decorators — README (Stage 2.7; "does not include parameter decorators"). https://github.com/tc39/proposal-decorators
- tc39/proposal-decorators — EXTENSIONS.md (parameter decorators as a future extension; wrapping semantics). https://github.com/tc39/proposal-decorators/blob/master/EXTENSIONS.md
- tc39/proposal-decorator-metadata. https://github.com/tc39/proposal-decorator-metadata
- tc39/proposal-class-method-parameter-decorators (Stage 1, Ron Buckton, last presented 2023-03). https://github.com/tc39/proposal-class-method-parameter-decorators
- tc39/proposal-class-method-parameter-decorators#3 — "Towards stage 2". https://github.com/tc39/proposal-class-method-parameter-decorators/issues/3
- tc39/proposal-decorators#47 — parameter decorators discussion; committee pushback. https://github.com/tc39/proposal-decorators/issues/47
- tc39/proposal-function-and-object-literal-element-decorators (Stage 1). https://github.com/tc39/proposal-function-and-object-literal-element-decorators
- tc39/proposal-function-implementation-hiding (AngularJS `toString()` precedent). https://github.com/tc39/proposal-function-implementation-hiding
- The TC39 Process (Stage 2.7 definition). https://tc39.es/process-document/
- Igalia — Summary of the February 2025 TC39 plenary (browser implementation status). https://blogs.igalia.com/compilers/2025/03/27/summary-of-the-february-2025-tc39-plenary/
- The New Stack — Inside ECMAScript: JavaScript Standard Gets an Extra Stage. https://thenewstack.io/inside-ecmascript-javascript-standard-gets-an-extra-stage/
- susisu — TSKaigi 2026 write-up (Stage 2.7 demotion; library tracking-issue survey). https://susisu.hatenablog.com/entry/2026/05/30/164040

**Toolchain**
- esbuild#257 — `emitDecoratorMetadata` intentionally unsupported. https://github.com/evanw/esbuild/issues/257
- esbuild — Content types / TypeScript. https://esbuild.github.io/content-types/
- esbuild — CHANGELOG-2024 (standard decorators in 0.21.0). https://github.com/evanw/esbuild/blob/main/CHANGELOG-2024.md
- SWC — compilation configuration (`legacyDecorator`, `decoratorMetadata`, `decoratorVersion`). https://swc.rs/docs/configuration/compilation
- Babel — `@babel/plugin-proposal-decorators`. https://babeljs.io/docs/babel-plugin-proposal-decorators
- Babel — `@babel/plugin-transform-typescript` (metadata not supported officially). https://babeljs.io/docs/babel-plugin-transform-typescript
- Vite — Features (`emitDecoratorMetadata` partially supported). https://vite.dev/guide/features
- Oxc — TypeScript transformer. https://oxc.rs/docs/guide/usage/transformer/typescript.html
- Deno 1.40 release notes (default flipped to standard decorators; legacy retained). https://deno.com/blog/v1.40
- denoland/deno#25735 — decorator options marked deprecated in config schema. https://github.com/denoland/deno/pull/25735
- denoland/deno#28266 — `experimentalDecorators`/`emitDecoratorMetadata` reported as deprecated. https://github.com/denoland/deno/issues/28266
- ts-patch. https://github.com/nonara/ts-patch
- typia — docs. https://typia.io/docs/ · TypeScript-Go setup. https://typia.io/docs/setup/tsgo/

**Libraries and precedent**
- Angular — commit `aad05eb`, "support usage of non-experimental decorators with TypeScript" (PR #49492). https://github.com/angular/angular/commit/aad05ebeb44afad29fd989019638590344ba61eb
- Angular — Migration to the `inject` function. https://angular.dev/reference/migrations/inject-function
- Angular — angular/angular#56146, support for `experimentalDecorators: false`. https://github.com/angular/angular/issues/56146
- Angular — angular/angular#50439, proposal to deprecate parameter decorators (closed). https://github.com/angular/angular/issues/50439
- Angular — angular/angular#58251, JIT and standard decorators. https://github.com/angular/angular/issues/58251
- Angular CLI — angular-cli#31984, remove `experimentalDecorators` from schematic (closed stale). https://github.com/angular/angular-cli/pull/31984
- NestJS — nestjs/nest#11414, support for standard decorators. https://github.com/nestjs/nest/issues/11414
- NestJS — nestjs/nest#16391, v12.0.0 roadmap. https://github.com/nestjs/nest/issues/16391
- NestJS — SWC recipe. https://docs.nestjs.com/recipes/swc
- InversifyJS — inversify/InversifyJS#1507, standard decorators (closed). https://github.com/inversify/InversifyJS/issues/1507
- InversifyJS — Announcing InversifyJS 8.0.0. https://inversify.io/blog/announcing-inversify-8-0-0/
- TypeORM#9862 — support for the new decorator standard. https://github.com/typeorm/typeorm/issues/9862
- TypeORM#10869 — use the full version of decorators introduced in TS 5.0. https://github.com/typeorm/typeorm/issues/10869
- final-hill/decorator-contracts. https://github.com/final-hill/decorator-contracts · migration issue #250. https://github.com/final-hill/decorator-contracts/issues/250
- MikroORM — v7 decorators package (`/legacy` and `/es` flavours). https://github.com/mikro-orm/mikro-orm
- microsoft/tsyringe#225 — standard decorator support. https://github.com/microsoft/tsyringe/issues/225
- typestack/typedi#1178 — Stage 3 decorator support (open, no comments). https://github.com/typestack/typedi/issues/1178
- typestack/class-validator#1929 — standard decorators. https://github.com/typestack/class-validator/issues/1929
- typestack/class-transformer#1510 — standard decorator signature clash (closed). https://github.com/typestack/class-transformer/issues/1510
- MichalLytek/type-graphql#1411 — blocked on parameter decorators. https://github.com/MichalLytek/type-graphql/issues/1411
- reflect-metadata (npm). https://www.npmjs.com/package/reflect-metadata

**MDN**
- `Proxy` handler `apply()`. https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy/Proxy/apply

**Related documents in this repository**
- [`docs/contract-driven-development.md`](./contract-driven-development.md) — prior art and DbC paradigm survey.
- [`docs/implementation-plan-t0-t1.md`](./implementation-plan-t0-t1.md) — Tier 0/1 plan; §8 is the decision gate this document resolves.
