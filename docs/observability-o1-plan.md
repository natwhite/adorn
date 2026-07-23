# adorn — Observability O1 Implementation Plan

*Concrete build plan for phase O1 — structured logging and contract-violation telemetry, on a neutral, pluggable observation layer. Produced 2026-07-22.*

> **Status: implementation plan.** This turns the ratified design in `observability-plan.md` into a sequence of concrete file changes, signatures, and seams. It does **not** re-argue the design — the "why OTLP is a category error", "why the sink is around-shaped", "why deny-by-default", and "why a separate `@adorn/otel`" arguments are settled there and in the proposed DEC-OBS entries, and are cited, not re-derived. It changes no code; it is one document.

> **Scope boundary.** O1 is everything that emits structured telemetry **with zero third-party dependency**. It ends exactly where OpenTelemetry begins. `@adorn/otel` (the `startActiveSpan` adapter), the metrics counter, and the OTel-Logs bridge are O2–O4 and are named here only where O1 must leave a seam for them.

---

## 0. What O0 already gave us, and what O1 stands on

O1 was blocked on one thing: a safe-by-default value-emission surface. **DEC-030 landed it.** Before writing a line of O1 we already have, in shipped code:

| Asset | File | What O1 reuses it for |
|---|---|---|
| `shouldDiscloseValue(sensitive)` — the pure disclosure decision, `disclosure === 'all' && !sensitive`, never reads the registry | `src/Core/redaction.ts` | The observation path emits a value **only** through this same gate, so telemetry is safe-by-default identically to `@Log` and violation messages. No new redaction logic. |
| `REDACTED` constant, `setValueDisclosure`/`getValueDisclosure` | `src/Core/redaction.ts` | The single placeholder and the global debug switch. |
| `@Sensitive` + the registry **sensitivity band** (`getParameterSensitivity`, `getEffectiveFieldSensitivity`, `getEffectiveClassSensitivity`) | `src/Sensitive/Sensitive.ts`, `src/Core/ContractRegistry.ts` | The veto. A `@Sensitive` parameter/return/class stays redacted in telemetry, for free, via the reads `@Log` already uses. |
| The redacted `Descriptor.formatMessage` (`ViolationContext.disclose`, absent-means-redact) | `src/Core/Descriptor.ts` | Confirms the "never carry the rendered violation message into structured attributes" rule is already the house style. |

**Consequence for O1:** the hard part of "emit values safely" is done. O1's value-emission surface is a thin composition over `shouldDiscloseValue`, plus one new *per-parameter* opt-in (`@Telemetry.value()`) that DEC-030's global switch deliberately did not provide.

The other load-bearing fact O1 stands on: **the around-behaviour seam already has the exact shape a span wants.**

```ts
// src/Core/MethodDecoratorFactory.ts — already shipped
export type MethodBehavior = (context: InvocationContext, proceed: () => any) => any;
```

`@Time` and `@Log` already ride this. `enforcementBehavior` (in `ContractInstaller.ts`) rides it. An OTel `tracer.startActiveSpan(name, opts, fn)` **is** a `(context, proceed) => result` around-function. The seam is not something O1 builds; it is something O1 discovers is already correct.

---

## 1. The `Observation` model — `src/Core/Observation.ts` (new)

A new file in `Core/`, **decorator-agnostic (DEC-012) and with zero third-party imports (DEC-OBS-1)**. It sits beside `Descriptor.ts` and `redaction.ts` in the same import-nothing-outside-`Core/` tier, so a projection and an adapter may both read it.

Two shapes, deliberately separate, mirroring the split `@Time` already discovered (`TimingRecord` is a point event; the *scope* is ambient):

```ts
// src/Core/Observation.ts — no import may reference @opentelemetry, rxjs, or a decorator type.

import type {ConstraintKind, ConstraintParams} from './Descriptor';

/** A telemetry attribute value. Deliberately narrow and low-cardinality-friendly. */
export type AttributeValue = string | number | boolean;
export interface Attributes { readonly [key: string]: AttributeValue | undefined; }

/** How much a developer asked to see. Two values only — DEC-OBS-5, not the DEC-008 trust ladder. */
export type ObservationDetail = 'always' | 'detail';

/**
 * Everything structurally derivable about ONE instrumented method, fixed for the life of the
 * wrapper. Built once at install time (§4), never per call. `code.function.name`-shaped by
 * construction (§2.5 of the design): `name` is already `Owner.member`.
 */
export interface Observation {
    readonly owner: string;          // 'Accounts'
    readonly member: string;         // 'transfer'
    readonly name: string;           // 'Accounts.transfer' — semconv code.function.name
    readonly isStatic: boolean;
    readonly detail: ObservationDetail;
    /** Per-parameter structural facts. Never a value here — values live on the per-call event. */
    readonly parameters: ReadonlyArray<ObservedParameter>;
}

/** A parameter's structural facts. Name may be absent (minification, DEC-OBS-4) — then only index. */
export interface ObservedParameter {
    readonly index: number;
    readonly name?: string;          // omitted rather than 'arg0' when unrecoverable (DEC-OBS-4)
    readonly type?: string;          // design:paramtypes name, when the toolchain emitted it
    /** The resolved emit decision for this parameter, computed at install time from the bands. */
    readonly disclosure: ParameterDisclosure;   // 'deny' | 'value' | {redact: string}
}

export type ParameterDisclosure = 'deny' | 'value' | {readonly redact: string};

/** A point-in-time event. The three O1 kinds; O3 adds nothing to this union, it reads it. */
export type ObservationEvent =
    | {readonly kind: 'completed'; readonly observation: Observation;
       readonly durationMs: number; readonly outcome: 'returned' | 'threw'; readonly settled: boolean}
    | {readonly kind: 'violation'; readonly observation: Observation;
       readonly violation: ViolationFacts}
    | {readonly kind: 'message'; readonly observation: Observation;
       readonly level: LogLevel; readonly message?: string; readonly attributes: Attributes};

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * The structured, VALUE-FREE facts of a contract violation (§5, and DEC-OBS-2). Assembled from
 * constraint identity + params + describe() + parameter identity + trust. It carries NO received
 * value and NO rendered message string — that is the whole point (the rendered message can embed
 * the value under disclosure; these attributes must be safe unconditionally).
 */
export interface ViolationFacts {
    readonly constraint: string;         // 'minLength'  → error.type: adorn.min_length
    readonly kind: ConstraintKind;       // 'string' | 'number' | 'generic'
    readonly params: ConstraintParams;   // {min: 10}  — low-cardinality, from the descriptor
    readonly expectation: string;        // describe() — 'a string of at least 10 characters'
    readonly parameterName?: string;
    readonly parameterIndex: number;
    readonly parameterType?: string;
    readonly trust: 'guard' | 'assert';  // ViolationSite.trust — the free guard-vs-assert dimension
}
```

Notes that make this concrete rather than aspirational:

- **`ViolationFacts.trust` is the unforced synergy** the design flags (§5.2): DEC-008 already made the developer say `guard` vs `assert` for an unrelated reason, and it drops into the violation event as a low-cardinality dimension distinguishing "external input rejected as designed" from "internal invariant broken" — for free.
- **`params` reuses the descriptor's own `ConstraintParams`** (`Descriptor.ts`), which is already JSON-serialisable and deep-frozen. No re-modelling.
- **`ObservedParameter.disclosure` is resolved once at install time** from the sensitivity band + the new telemetry band + the global switch (§7), so the per-call path never re-resolves policy.

---

## 2. The around-shaped sink — signature, no-op, adapter, composition

Same file. This is the load-bearing detail (DEC-OBS-1): the sink is **around-shaped, not fire-and-forget**, because a span must be the *active* context while the body runs or nested work is orphaned into flat, unparented spans.

```ts
export interface ObservationSink {
    /**
     * AROUND-shaped. THE reason this is not `(event) => void`. The adapter implements it as
     * `tracer.startActiveSpan(o.name, {...}, () => proceed())`, so the span is the active context
     * for the duration of the call and nested decorated methods / auto-instrumented I/O nest under
     * it. A record-only sink implements this as just `proceed()` and uses `record` alone.
     */
    scope?<T>(observation: Observation, proceed: () => T): T;

    /** Fire-and-forget point events: completions, violations, messages. */
    record?(event: ObservationEvent): void;
}

/**
 * The default. `scope` is exactly `proceed()` (no wrapping, no allocation), `record` is absent.
 * A single shared frozen reference so the hot-path test is one `===` compare (§4).
 */
export const NOOP_SINK: ObservationSink = Object.freeze({});

let sink: ObservationSink = NOOP_SINK;

/** Route every observation somewhere — an @adorn/otel adapter, a JSON logger, a test spy. */
export function setObservationSink(next: ObservationSink | null): void {
    sink = next || NOOP_SINK;
}
export function getObservationSink(): ObservationSink { return sink; }
```

**Both members optional, on purpose.** A sink that only wants records omits `scope`; a sink that only wants span-nesting omits `record`. `NOOP_SINK` omits both, so "no sink installed" and "sink installed but doesn't care about this signal" are the same cheap branch.

**How the adapter (O2, `@adorn/otel`) implements it — sketched only to prove the seam is right:**

```ts
// @adorn/otel — NOT built in O1; shown to prove scope is sufficient and to fix the seam.
const otelSink: ObservationSink = {
    scope(observation, proceed) {
        return tracer.startActiveSpan(observation.name, {attributes: codeAttrs(observation)}, span =>
            // settle() is adorn's shared classifier (§5 of this plan) — imported, never reimplemented,
            // so the span ends on true settle and its duration can never disagree with @Time's.
            settle(proceed(), (outcome, settled) => {
                if (outcome === 'threw') span.setStatus({code: ERROR});
                span.end();
            }));
    },
    record(event) {
        if (event.kind === 'violation') {
            // recordException TODAY; a log-based event when the JS Logs API stabilises — a change
            // entirely inside this package (§2.4 of the design, DEC-OBS-6). adorn does not move.
            span?.recordException?.({name: `adorn.${event.violation.constraint}`});
        }
        // 'completed' → histogram (O3); 'message' → log record.
    },
};
```

**Composition with the existing seam — the seam is already the shape.** The O1 observation behaviour (§4) is a `MethodBehavior`. Inside it, the call to the method is `sink.scope(observation, proceed)` where `proceed` is the factory's own `proceed` thunk. `MethodBehavior`'s `(context, proceed) => result` and `scope`'s `(observation, proceed) => result` are the **same around shape**; there is no impedance mismatch and no adaptation layer. That is why `MethodDecoratorFactory` is the correct and only hook.

---

## 3. Layering and the file manifest

```
src/Core/Observation.ts          ← model + sink slot. Zero third-party imports. Decorator-agnostic.   (NEW)
src/Core/settle.ts               ← the sync/thenable/observable settling classifier, extracted from
                                    Time.ts so @Time, @Observe, and the O2 adapter share ONE copy.    (NEW)
src/Core/ObservationBehavior.ts  ← the MethodBehavior. Adapter-side (knows InvocationContext).        (NEW)
src/Telemetry/Telemetry.ts       ← @Telemetry.value/redact/result — the per-parameter emit surface.   (NEW)
src/Core/ContractRegistry.ts     ← + a telemetry-disclosure band, twin of the sensitivity band.       (edit)
src/Core/Configuration.ts        ← + setObservationVerbosity (the 'detail' gate).                      (edit)
src/Core/ContractInstaller.ts    ← violation observations emitted from enforcementBehavior's catch.    (edit)
src/Core/ParameterDecoratorFactory.ts ← throw a structured ViolationError carrying ViolationFacts.     (edit)
src/MethodDecorators/Time.ts     ← rebased onto settle.ts; setTimingSink preserved as a narrow view.   (edit)
src/MethodDecorators/Log.ts      ← rebased to emit {kind:'message'} events; console default retained.  (edit)
src/MethodDecorators/Observe.ts  ← the unified sugar decorator (span + duration + message).            (NEW)
src/Projections/telemetry.ts     ← the privacy-review "what leaves the process" table. Core/+Contracts/.(NEW)
index.ts                         ← new exports.                                                        (edit)
@adorn/otel  (separate package)  ← O2, out of O1 scope. Peer on @opentelemetry/api.
```

`Observation.ts` and `settle.ts` import nothing outside `Core/`, so DEC-012 holds for `telemetry.ts` (it reads `Observation`, the registry, and `Descriptor` only — never an adapter). `ObservationBehavior.ts` is adapter-side (it reads `InvocationContext`), exactly as `enforcementBehavior` and `Time.ts` already are.

---

## 4. `ObservationBehavior` — the one `MethodBehavior`

`src/Core/ObservationBehavior.ts`. This is the machinery `@Observe`, `@Log`, and `@Time` all become sugar over. Two properties are **requirements, not optimisations** (design §8 risk 1):

**(a) The uninstalled path is one reference comparison.**

```ts
export function observeBehavior(config: ObserveConfig): MethodBehavior {
    let observation: Observation | undefined;   // built once, cached in this closure (like Log's signature)
    return function (context, proceed) {
        const s = getObservationSink();
        if (s === NOOP_SINK && config.consoleFallback === undefined) return proceed();  // ← the fast path
        if (!observation) observation = buildObservation(context, config);              // lazy, once
        // ... scope + settle + record, all assembled lazily below
    };
}
```

No `Observation` is built, no attribute assembled, no string formatted, unless a sink is installed (or the decorator carries a visible console fallback — see the default-story in §7). `@Contract()`-only methods with no `@Observe`/`@Log`/`@Time` install **no** observation behaviour at all, so they pay nothing here ever; their only observation path is the violation side-channel (§5), which is itself gated on `s === NOOP_SINK` and only reachable when a check actually fails.

**(b) The `Observation` is built at install time, not per call.** `buildObservation` reads `context.target`/`context.propertyKey`/`context.original` once and resolves owner, member, name, isStatic, parameter names/types (via the same `DecoratorFactory.getParamNames` + `design:paramtypes` reads `@Log` already uses), and each parameter's resolved `disclosure`. This is exactly what `enforcementBehavior` already does for `ViolationSite` and `Log.resolveSignature` does for `LogSignature`, and it is cached in the per-decorator closure identically.

**The scope + settle body:**

```ts
        const run = () => proceed();
        const scoped = s.scope ? () => s.scope!(observation!, run) : run;
        const started = now();
        return settle(scoped(), (outcome, durationMs, settled) => {
            s.record?.({kind: 'completed', observation: observation!, durationMs, outcome, settled});
            // @Log sugar additionally emits {kind:'message'} here; @Time reads durationMs.
        });
```

`settle` is the shared classifier (§5 below). The completion record fires when the work *settles*, not when it *returns* — the async correctness `@Time` already solves, now shared.

---

## 5. Rebasing `@Log` and `@Time` — what actually changes

**Recommendation: unify the machinery, keep the decorators. Honest about what is low-risk versus what actually moves.** (DEC-OBS-3.)

### `@Time` — modest, mechanical, and mostly a *move*

`@Time`'s settling classifier (`isThenable` / `isObservableLike` / `timeThenable` / `timeObservable` / `loadObservable`) is the hard, already-correct part. **What changes:**

1. **Extract, don't rewrite.** The classifier moves verbatim from `Time.ts` into `src/Core/settle.ts`, exported as `settle(result, onSettle)`. The rxjs guarded-lazy-`require` and the `settled: false` honest-refusal behaviour move with it unchanged (SMELL-16 is neither worsened nor fixed by the move). `@Time` now imports `settle` instead of owning it. **This is the single highest-value unification and it does not depend on the OTel story at all**: it guarantees `@Time`, `@Observe`, and O2 spans compute *one* duration from *one* classifier, so they can never disagree — the drift DEC-006 exists to abolish, kept out of telemetry.
2. **`TimingRecord` becomes a view of `{kind:'completed'}`.** `owner`, `member`, `label`, `durationMs`, `kind`, `outcome`, `settled` all survive with no semantic loss. `@Time`'s reporter emits a `completed` event to the observation sink when one is installed.
3. **`setTimingSink` is preserved verbatim as a documented narrow view.** When no observation sink is installed, `@Time` still routes to its own `DEFAULT_SINK` (console) exactly as today. Breaking `setTimingSink` would be a break for no benefit; it stays. `TimedResultKind`/`TimingRecord`/`TimingSink` remain exported.

What does **not** change: the decorator name, its options, its console output shape when used standalone, its Observable behaviour. The `Time.rxjs-absent.test.ts` and `Time.test.ts` suites should pass unchanged except where they assert on the *internal* location of the classifier.

### `@Log` — already structured and redacted; the change is routing, not safety

`@Log` was already fixed by DEC-030: it emits structure (names + types + `[REDACTED]`) not values, via `shouldDiscloseValue`. So O1's `@Log` change is **not** a safety change and **not** a second breaking change — the breaking change already happened. **What actually changes:**

1. **It emits a `{kind:'message'}` `ObservationEvent`** (with structured `attributes`: `code.function.name`, per-parameter `{name, index, type, present}`, `outcome`) to the observation sink when one is installed — so an aggregator can group/filter/alert, which the current `Call: name(args) => result` string cannot.
2. **The console string is retained as the no-sink fallback.** Standalone `@Log` with no observation sink installed keeps writing its line to `console.log`, so nothing regresses for a developer using `@Log` as a debug aid. This is the same "visible out of the box" role `@Time`'s `DEFAULT_SINK` plays.
3. **`renderArguments`/`renderReturn`/`safeStringify`/`LogSignature` are reused as-is** for the console fallback and to compute the structured `present`/`type` facts. The `shouldDiscloseValue` calls are unchanged, so the `@Sensitive` veto and `setValueDisclosure` interplay carry over for free.

**What stays separate (deliberately):** the *decorators*. `@Log()`, `@Time()`, and the new `@Observe()` are good names for distinct intentions and are **not** collapsed into `@Observe({log:true,time:true})`. Sugar at the top; one `observeBehavior` at the bottom.

**The genuine unification win, stated plainly:** `@Contract` + `@Log` + `@Time` on one method today installs **three** wrappers — three `arguments` copies, three `InvocationContext` literals, three `proceed` closures per call. A method carrying `@Observe()` (which does span + duration + message) plus `@Contract()` installs **two**. This is the strongest cost argument and it is independent of OTel. It is, however, the most invasive change, so it is sequenced **last** in O1 (§9) and is not required for the violation-telemetry deliverable.

---

## 6. Violation observations — the strongest demonstration, routed concretely

This is the part to build first and put in the README (design §5.2): a hand-written `if (x.length < 10) throw new Error('too short')` yields an ungroupable string; a reified constraint hands the pipeline `{constraint:'minLength', params:{min:10}, kind:'string', trust:'guard', ...}` — a low-cardinality, groupable dimension **for free**, because DEC-010 already forced constraints to be reified identity + params.

### The concrete routing problem, and its resolution

There is exactly one choke point where a contract violation is caught at the method boundary:

```ts
// src/Core/ContractInstaller.ts — enforcementBehavior, already shipped
return function (context, proceed) {
    if (!shouldEnforce(trust)) return proceed();
    try { enforce(context); }
    catch (violation) { applyViolationPolicy(violation, site); }   // ← here
    return proceed();
};
```

But at this point `violation` is an **opaque `Error` whose only structured content is a rendered message string** — the constraint identity, params, kind, and parameter index were all in scope back in `descriptorCheck` (`ParameterDecoratorFactory.ts`) and were dissolved into `Error.message`. Emitting structured telemetry from here would mean *re-parsing a string*, which is exactly the anti-pattern the whole project rejects.

**Resolution — carry the facts, not the string.** Two small, surgical edits:

1. **`descriptorCheck` throws a structured `ViolationError`** (a new `Error` subclass in `Core/`) that keeps its message **byte-for-byte unchanged** (so every existing violation-message test and the DEC-030 redaction behaviour are untouched) but additionally carries a frozen `facts: ViolationFacts`, assembled from data already in scope there: `constraint.constraint`, `constraint.kind`, `constraint.params`, `constraint.describe()`, `paramNames[index]`, `index`, the reflected type. **No value, no message string** in `facts` — deny-by-default holds at the source.
2. **`enforcementBehavior` emits the observation as a non-authoritative side-channel**, adding `site.trust` (which lives here, not at the check), and then delegates control flow to `applyViolationPolicy` exactly as today:

```ts
    catch (violation) {
        const sink = getObservationSink();
        if (sink !== NOOP_SINK && violation instanceof ViolationError) {
            sink.record?.({kind: 'violation', observation: siteObservation,
                           violation: {...violation.facts, trust: site.trust}});
        }
        applyViolationPolicy(violation, site);   // control flow UNCHANGED
    }
```

### The four properties this must have (and gets)

- **It is a side-channel, never a control-flow input.** The observation is emitted *before and independent of* `applyViolationPolicy`. A telemetry sink is **not** a `ViolationHandler` — conflating "observe this" with "suppress this" (a handler that returns suppresses) would be a serious bug (design §5.2). Observation cannot influence enforcement.
- **It fires under `'warn'` too.** `'warn'` suppresses-and-proceeds, and a suppressed violation is *more* urgent to observe, not less — `'warn'` exists precisely to measure what a staged contract *would* reject over live traffic. The emit happens regardless of policy.
- **Zero cost until a violation actually fires** *and* a sink is installed — the emit is inside the `catch`, which is already the exceptional path, gated on `sink !== NOOP_SINK`.
- **One violation per call, matching enforcement.** `enforce` throws on the first failing check, so one call yields at most one violation event — the same constraint enforcement reports. Consistent, not lossy.

### Honest limit: hand-written closures

A `CreateSimpleDecorator` closure throws an arbitrary error with no reified identity (SMELL-14 — it is invisible to every projection). Its violation, if `instanceof ViolationError` is false, degrades to a **low-fidelity event**: `owner.member` + `trust` + `error.type: _OTHER` (the semconv fallback), with no `constraint` dimension. This is stated, not hidden: the groupable-dimension win is a property of *reified* constraints, and the closure form opted out of reification. It is the same trade already documented for docs and fuzzing.

---

## 7. The `@Telemetry` declaration surface, and its interplay with DEC-030

DEC-030 gave a **global** debug switch (`setValueDisclosure('all')`) and a **veto** (`@Sensitive`). It deliberately did *not* give a **per-parameter production opt-in** — the thing that lets `amount` emit its value in production telemetry while `memo` never does. That is O1's `@Telemetry`, and it is the surface the design says must be settled *before* anything emits values (DEC-010 lesson: settle the shape first).

### The decorator (mirrors `@Sensitive`'s shape exactly)

`src/Telemetry/Telemetry.ts` — a namespace of legacy decorators resolving target from argument shape, storing into a new **telemetry-disclosure band** in the registry (twin of the sensitivity band: own-scoped, index-keyed hence minification-safe, decorator-agnostic per DEC-012, record-only — installs nothing):

```ts
@Contract()
class Accounts {
    transfer(
        @Telemetry.value()          @GreaterThan(0)    amount: number,    // value emitted
        @Telemetry.redact('hash')                      accountId: string, // surrogate emitted
                                    @StringMinLength(1) memo: string,      // never emitted (default)
    ) {}
    @Telemetry.result() getBalance(id: string): number { /* ... */ }      // return opt-in (closes Q-23)
}
```

- `@Telemetry.value(name?)` — opt one parameter in. `name?` is the DEC-OBS-4 explicit-name escape hatch for minified builds (`@Telemetry.value('accountId')`).
- `@Telemetry.redact(strategy)` — emit a derived surrogate. **Strategies are descriptors (identity + params, transform derived), not closures — DEC-010 applied unchanged**, so `redact('hash')` cannot document itself as hashing and actually truncate. The strategy table (`hash`, `length`, `first(n)`, `last(n)`, `domain`, `type`) is a small `defineConstraint`-style table; O1 ships `value()`, `type`, and `length` first (cheapest, no crypto), with `hash`/`first`/`last`/`domain` as a fast-follow inside O1 once the descriptor shape is pinned.
- `@Telemetry.result()` — the return-value opt-in. It also fills the DEC-030 gap (Q-23: a return could not be `@Sensitive`) on the *disclosure* side.

### The disclosure resolver — the exact interplay, spelled out

This is what an adversarial reviewer will probe, so it is explicit. Value emission on the telemetry path is resolved **once at install time** per parameter, by composing three inputs into `ObservedParameter.disclosure`:

```
sensitive  = @Sensitive on param OR class (getEffective*Sensitivity)   // the veto
declared   = the @Telemetry band for this param  ('value' | {redact} | absent)
global     = getValueDisclosure()                 // 'none' | 'all', DEC-030 debug switch

disclosure =
    sensitive                       ? 'deny'          // veto wins, always (DEC-025/DEC-PII-1)
  : declared === 'value'            ? 'value'         // per-parameter production opt-in
  : declared is {redact}            ? {redact}        // surrogate
  : global === 'all'               ? 'value'          // global debug disclosure (local only)
  : 'deny'                                            // THE DEFAULT — nothing said → nothing leaves
```

Read off the guarantees:

- **Deny is the default and fails safe.** A newly added parameter with no annotation emits **no value** — silent *exclusion*, never silent inclusion (the DEC-016 inversion the design insists on).
- **`@Sensitive` can only ever remove disclosure**, never grant it — its DEC-030 role, unchanged.
- **`setValueDisclosure('all')` stays a local-debug switch**; it does not reach `@Sensitive` parameters and it is not how production telemetry emits values (that is `@Telemetry.value()`, per-parameter and reviewable).
- **The per-call path never re-resolves policy** — it reads the pre-resolved `disclosure` and, for `'value'`, still passes through `shouldDiscloseValue`-style rendering; for `{redact}` it applies the derived strategy transform; for `'deny'` it emits the structural facts only (`{name, index, type, present}` — never `length` unless a strategy asked for it, since a length is a fingerprint).

### The sixth projection (near-free, high-value)

Because disclosure is a **declaration in the registry**, `src/Projections/telemetry.ts` can emit a **privacy-review table of every parameter/return in the codebase whose value leaves the process, and in what form** — reading the telemetry band + sensitivity band + `getContractsForClass`, exactly as `docs.ts`/`schema.ts` read the constraint band. No logging library can produce this, because none knows what the parameters are. It also makes the *absence* of a `@Telemetry.value()` reviewable, which a grep for `logger.info` never is.

**Honest caveat inherited from DEC-007 (design §8 risk 9):** the table reflects only imported modules. A privacy-review artifact that silently omits an unimported module is the "looks complete, is not" failure DEC-016 rejects, so the table must render its own denominator (what it scanned) and never present a clean sheet as a clean bill of health — the same shipping condition the sensitive-flow detector already meets (DEC-028 point 3).

---

## 8. Configurability and flexibility — a first-class section

The governing principle: **the default is the safe, quiet one for anything with a privacy or cost consequence; flexibility is added where a real decision genuinely varies per site or per host, and refused where it would either fight a better mechanism the host already owns or manufacture a foot-gun.** Knobs are counted as cost, not celebrated.

### What a developer *can* configure

| Knob | Surface | Default | Why it exists |
|---|---|---|---|
| **The sink** | `setObservationSink(sink \| null)` | `NOOP_SINK` (silent) | The one big lever. A plain JSON logger, `@adorn/otel`, a test spy, a custom backend — all are just an `ObservationSink`. This is the entire "not bound to one vendor" story (DEC-OBS-1). |
| **Which signals emit** | choice of decorator: `@Observe` (span+duration), `@Time` (duration), `@Log` (message); violations are automatic | — | A developer picks signals by picking decorators. Violation telemetry needs no decorator — it is a projection of `@Contract()`/`@Validate()` already present. |
| **Per-method vs global** | per-method `@Observe`/`@Log`/`@Time`; there is no global "instrument everything" | per-method | Spans/logs are opt-in per method (OTel's own guidance: verbose spans behind a disabled-by-default option). A class-wide `@Observe()` is allowed but its members default to `detail`. |
| **Verbosity** | `setObservationVerbosity('normal' \| 'detailed')`; annotations carry `detail: 'always' \| 'detail'` | `'normal'` (emit only `'always'`) | Two values, not the DEC-008 trust ladder (DEC-OBS-5). `always` = a boundary worth production emission; `detail` = emitted only when the host turns detail on. |
| **Per-parameter value emission** | `@Telemetry.value()` / `@Telemetry.redact(strategy)` / `@Telemetry.result()` | deny | The per-parameter production opt-in (§7). Reviewable, minification-safe via explicit name. |
| **Global value disclosure** | `setValueDisclosure('none' \| 'all')` (DEC-030, existing) | `'none'` | Local-debug blanket disclosure; `@Sensitive` still vetoes. |
| **Sensitivity veto** | `@Sensitive` (existing) | — | Removes disclosure on a site even under `'all'` or `@Telemetry.value()`. |
| **`@Time` sink alias** | `setTimingSink` (existing, preserved) | console `DEFAULT_SINK` | Back-compat narrow view of the observation sink. |

### What is deliberately *not* configurable, and why

- **Sampling / rate / retention / export / batching.** Belongs to the SDK, which has context adorn does not (live trace context, parent sampling decision, rate budgets). An authoring-time verbosity ladder finer than two values would *fight* the sampler and punch unexplainable holes in traces (design §5.4). adorn refuses to reinvent a worse version of a control the host already has — the same stance `Time.ts` takes on aggregation.
- **"Emit values by default" as a convenience flag.** Deny-by-default is not flippable by one switch. The only ways to emit a value are the per-parameter opt-in or the local-debug global switch, and `@Sensitive` overrides both. A single "log everything" flag is exactly the silent-inclusion foot-gun DEC-016 forbids.
- **Span kind / domain meaning heuristics.** Not derivable from a signature (design §4.3); guessing would fabricate. A future explicit `@Observe({kind})` is an *additive* option, not a default.
- **The no-op default of the sink.** The *automatic* signal (violations) is silent until a sink is installed — non-negotiable, because it is the zero-cost guarantee (§4a) and the "adorn takes no dependency and does nothing until asked" guarantee (§9).

### The balance argument (the thing the reviewer is really testing)

The plan resists "maximise knobs." It ships **one** powerful, composable primitive (the sink) plus a **small** set of per-site declarations (`@Observe`, `@Telemetry.*`, `detail`) whose defaults are all the quiet/safe end. Everything a *runtime telemetry system* legitimately varies — rate, retention, sampling, backend — is delegated to that system through the one sink, not re-implemented as adorn config. Everything a *developer* legitimately varies per site — is this a boundary worth a span, may this value leave the process — is a per-site declaration with a safe default and locality of intent at the parameter it governs. The two axes are kept apart on purpose: conflating them is how observability libraries grow forty knobs and still can't answer "which of my contracts fails most in production." The one place the design accepts real ergonomic cost — explicit parameter names for minified builds (DEC-OBS-4) — is accepted because the alternative (plausible-but-wrong attribute names in production) is the "looks complete, is not" failure the project rejects everywhere else.

---

## 9. The dependency answer — held, and why GAP-6 cannot recur

**adorn core takes zero new dependencies. Not a dependency, not a peer, not an optional peer, not a lazy `require`.** (DEC-OBS-1, restating and holding DEC-019.)

- `src/Core/Observation.ts` is **interfaces, a frozen empty object (`NOOP_SINK`), and three functions.** TypeScript interfaces erase at compile time. There is **no module specifier anywhere in core that names `@opentelemetry/*`** — not in an import, not in a string literal, not inside a guarded function. So there is nothing for a bundler to resolve, nothing to install, and nothing that can fail to resolve.
- This is strictly stronger than "optional peer dependency." **GAP-6 was: an eager import (`Memoize` → `rxjs`) on the `index.ts` path broke `require('adorn')` for everyone, and a manifest change alone did not fix it because the *specifier* was still there.** SMELL-16 sharpened it: even a *lazy guarded `require('rxjs')` with a string literal* is statically resolvable by a bundler, so it converts "wasteful pull-in" into "unresolved-module diagnostic." The O1 core has **no specifier at all** — the one category with a zero failure rate. GAP-6 cannot recur because its precondition (a third-party specifier on the load path) is never created.
- **CI already guards this direction.** GAP-4's pipeline was inverted when GAP-6 landed: it now asserts rxjs is **absent** from the consumer tree, so a transitive reintroduction fails CI. The same check trivially extends to assert `@opentelemetry/*` never enters core's tree.

**`@adorn/otel` (O2, separate package):**

| Field | Value |
|---|---|
| `peerDependencies` | `"@opentelemetry/api": "^1.9.0"` — the convention verified in `@opentelemetry/instrumentation-http` |
| `devDependencies` | the same, so its own suite resolves |
| `dependencies` | `adorn` (for the `settle` helper and the `Observation`/`ObservationSink` types) |
| **not** | `optionalDependencies` — npm installs those by default (DEC-019), defeating the purpose |

**Why peer and not dependency, specifically:** the OTel global-singleton version check degrades an incompatible second copy of `@opentelemetry/api` to a **silent no-op** — telemetry that simply does not appear, no error. A peer deduplicates against the application's copy; an ordinary dependency can nest a second one. This is the difference between working and silently-not-working and it is not discoverable by testing the adapter in isolation.

A consumer who wants adorn's structured records **without any OTel** installs nothing extra and passes their own `ObservationSink`. A consumer who wants none of it pays zero — no package, no load time, no bundler specifier, and (for `@Contract()`-only code) not even the per-call reference compare, since no observation behaviour is installed.

---

## 10. Sequencing — what lands first, what is independently shippable, what waits

The scheduling fact that matters: **nothing in O1 touches OpenTelemetry.** Every OTel decision — the moving `recordException` API, the alpha Logs API, the dependency risk — is confined to O2+. O1 is unblocked in full.

**O1a — the observation model + sink (foundation; blocked on nothing).**
`Core/Observation.ts` (model, `ObservationSink`, `NOOP_SINK`, `setObservationSink`), `Core/settle.ts` (extract the classifier from `Time.ts`). No behaviour change yet; `@Time` rebased onto `settle.ts` as the first consumer (proves the extraction, preserves `setTimingSink`). **Independently shippable.** Deliverable: the neutral layer exists and `@Time` uses it, with zero third-party dependency and zero output change.

**O1b — violation observations (the headline; depends on O1a).**
`ViolationError` carrying `ViolationFacts` (edit `ParameterDecoratorFactory.descriptorCheck`), side-channel emit in `ContractInstaller.enforcementBehavior`. `ObservationBehavior.ts` is *not* required for this — violations route straight from the enforcement choke point. **Independently shippable and is the strongest single demonstration of the source-of-truth thesis.** Deliverable: any `@Contract()`/`@Validate()` method, with an observation sink installed, emits structured `{constraint, params, kind, parameterName/index/type, trust, expectation}` on every violation, value-free, independent of `setViolationPolicy`, firing under `'warn'`.

**O1c — the `@Telemetry` band + resolver + `@Observe` + rebased `@Log` (depends on O1a).**
The telemetry-disclosure registry band, `Telemetry.value/redact/result`, the install-time disclosure resolver (§7), `ObservationBehavior.ts`, `@Observe`, `@Log` rebased to emit `{kind:'message'}` (console fallback retained). Ship `value()`/`type`/`length` strategies first; `hash`/`first`/`last`/`domain` as a fast-follow once the strategy-descriptor shape is pinned. **The `@Telemetry` band must land before any value-emitting path** (DEC-010 lesson — settle the shape before authoring on it), which is why the resolver and band precede `@Observe` even though they are in the same sub-phase.

**O1d — the privacy-review projection (depends on O1c's band).**
`Projections/telemetry.ts` — the "what leaves the process" table, with its own scanned-denominator (design §8 risk 9). Pure registry read, `Core/`+`Contracts/` only (DEC-012). **Independently shippable** once the band exists.

**Default sink for out-of-the-box visibility** rides with O1c: a small JSON-to-`console` `ObservationSink` a consumer can opt into (not installed by default — the automatic violation signal stays quiet until a sink is chosen; only the explicitly-applied `@Log`/`@Time` decorators keep their own visible console fallback).

**Deliberately after O1:** `@adorn/otel` (O2), the `adorn.contract.violations` counter (O3 — it reads the O1b event, adds nothing to the model), the OTel-Logs bridge (O4 — blocked upstream on the alpha JS Logs API). The full three-wrappers-to-two unification of `@Contract`+`@Log`+`@Time` is the most invasive change and is the *last* item of O1c, not a prerequisite for the O1b deliverable.

---

## 11. Honest hard parts (not hand-waved)

1. **Async/Observable results through a span scope — the central difficulty.** A span must be the active context while the body runs *and* must end when the work *settles*, not when it *returns*. `scope`'s job is the active-context nesting (it wraps the synchronous portion of `proceed`, which is when nested sync calls and the promise's creation happen; OTel then propagates context across `await` boundaries via the SDK's `AsyncLocalStorage`). The span's *end* and *status* need the settle signal, which lives in adorn's classifier — so **the O2 adapter ends the span using adorn's exported `settle`, never its own reimplementation.** This is the concrete mechanism that prevents the "flat, early-ended spans" failure the design flags as the most likely way a first implementation gets it wrong. It is why `settle.ts` is extracted in O1a even though O1 itself ships no spans: the seam has to exist before the adapter can be correct.
2. **Context propagation is the SDK's job, and adorn must not touch it.** adorn opens an active scope; propagating it across process/async boundaries is `AsyncLocalStorage` in the SDK. Deliberately not scheduled (design §6). A design that tried to own propagation would be reinventing the SDK.
3. **The no-op path is cheap, not free — and this is the *adapter's* cost, not core's.** When `@adorn/otel` is installed but no SDK is registered, `startActiveSpan` still allocates a `NonRecordingSpan`, a context object, and a `context.with` call per span (verified from `NoopTracer` source; unquantified — no published benchmark). adorn *core* has no such cost (its no-op is `NOOP_SINK`, one `===`). This must be documented so nobody attributes the adapter's per-call allocation to adorn.
4. **adorn's own wrapper cost is real and pre-existing.** Each wrapper already costs an `arguments` copy, a context literal, and a `proceed` closure. The single-comparison fast path (§4a) and install-time `Observation` construction (§4b) are **requirements** — get them wrong and observation becomes a reason not to use adorn. This should be **benchmarked, not asserted**; the design measured nothing and neither does this plan.
5. **Minification degrades parameter-name telemetry** (SMELL-1 / DEC-OBS-4) — the most serious honest weakness. Names become `s`, `e`, `t` in exactly the production build where telemetry matters. `@Telemetry.value('name')` and `ObservedParameter` emitting *index* (never `arg0`) when a name is unrecoverable are the mitigations, but they are opt-in, so the default minified experience is degraded-but-plausible telemetry. This limits how strongly "structured logging for free" can be claimed and must be qualified publicly, not footnoted.
6. **`design:paramtypes` is absent under esbuild/Babel and erases to `Object` for interfaces/unions/generics** (DEC-004). The `type` attribute is present for simple primitives and missing precisely for the rich domain types most worth knowing. Telemetry renders absence, never a guess — the rule `docs.ts` already follows.

---

## 12. Acceptance criteria for O1

- `require('adorn')` still succeeds with only `tslib` present; CI asserts no `@opentelemetry/*` in core's tree (GAP-4 extension).
- With `NOOP_SINK` (default): a `@Contract()`-only method installs no observation behaviour and pays zero observation cost; a violation path does one `===` and no allocation.
- With an installed test-spy sink: every contract violation yields exactly one value-free `{kind:'violation'}` event carrying `{constraint, kind, params, expectation, parameterName?, parameterIndex, parameterType?, trust}`; it fires under `'throw'`, `'warn'`, and a suppressing handler alike; it never influences control flow.
- No structured violation event, and no `{kind:'message'}` event, ever contains a received value or the rendered violation-message string unless a per-parameter `@Telemetry.value()`/`@Telemetry.redact()` (or `setValueDisclosure('all')`) permits it, and never for a `@Sensitive` site.
- `@Time`'s `setTimingSink` and console output are byte-for-byte unchanged when used standalone; `@Time`, `@Observe`, and (later) O2 spans compute duration from the one `settle` classifier.
- `Projections/telemetry.ts` renders every value-emitting parameter/return with its form, plus the set of modules it scanned; a clean table never masquerades as a clean bill of health.

---

## Adversarial Review — Configurability & Flexibility

*Appended 2026-07-22. Critique only — no code, tracker, or plan text above this line was changed. Reviews the configurability/flexibility axis against the ratified design (`observability-plan.md`), DEC-030/025/008/016, and the actual signatures in `src/Core/redaction.ts`, `src/MethodDecorators/Time.ts`, `src/MethodDecorators/Log.ts`, `src/Core/MethodDecoratorFactory.ts`.*

### Verdict

**The configurability model is unsound in one specific, fixable-but-load-bearing way, and the fix must land before O1c is built.** The plan's philosophy — one powerful around-shaped sink, a few safe-defaulted per-site declarations, everything runtime delegated to the sink — is the right shape. But the sink and the event union it delegates to **have no channel for per-call runtime data**: not an argument value, not the return value, not the thrown error. `scope(observation, proceed)` receives only install-time facts; `settle`'s callback (extracted verbatim from `Time.ts`) carries neither value nor error; the `completed` and `violation` events carry no values; and the *only* slot that can hold a value — `message.attributes`, typed `AttributeValue = string | number | boolean` and documented "Deliberately narrow and low-cardinality-friendly" — is exactly the wrong container for the high-cardinality payloads `@Telemetry.value()` exists to emit.

The consequence is stark and specific: **O1c builds an entire permission system for value emission — a new registry band, a three-input resolver, `@Telemetry.value/redact/result`, a sixth projection — with no transport for the value it permits.** The disclosure resolver in §7 resolves `ObservedParameter.disclosure` to `'value'`, the per-call path "still passes through `shouldDiscloseValue`-style rendering" (§7), and the rendered value then has nowhere in the model to go except a message attribute the model's own type comment argues against. This is not "too few knobs." It is a primitive too thin to delegate to.

**Single most important change:** pin the per-call data channel *before* building — `settle` must pass the settled value / thrown error, `scope` must receive the `InvocationContext` (or at least `args`), and `completed`/`violation` need a per-parameter attribute slot — because the `ObservationEvent` union and `ObservationSink` are a semver-frozen public surface the moment an adapter binds to them (Q-6), and §11.1 extracts `settle` in **O1a** *specifically* "so the seam exists before the adapter can be correct." Extracting the wrong-arity seam bakes the defect into the foundation phase.

It is more **under-configurable than over**, and the under-configurability lives in the one primitive the whole design rests on.

---

### FATAL (change before building)

#### F1 — The event model has no home for a disclosed value. *(single most damaging)*

Trace the value-emission path end to end against the actual shapes in §1–§2:

- A span is created by `scope?<T>(observation: Observation, proceed: () => T): T`. `Observation` is "Built once at install time (§4), never per call" and its comment states plainly: *"Never a value here — values live on the per-call event."* So the span can carry no value.
- The per-call completion is `{kind:'completed'; observation; durationMs; outcome; settled}` — **no attribute field, no value.**
- The violation event is `{kind:'violation'; observation; violation: ViolationFacts}`, and `ViolationFacts` is value-free "that is the whole point" (§1).
- That leaves exactly one carrier: `{kind:'message'; ...; attributes: Attributes}`. And `Attributes` is `{[key]: AttributeValue | undefined}` where `AttributeValue = string | number | boolean` is annotated *"Deliberately narrow and low-cardinality-friendly."*

So the only slot capable of holding a disclosed `amount` or `accountId` is the one the plan documents as the place low-cardinality attributes go — and `@Telemetry.value()` values are high-cardinality *by nature* (that is why you want them). There is no well-typed, intent-consistent home for the output of the §7 resolver. The `@Telemetry` surface, the disclosure band, and the resolver are all **permission without transport**.

**Steel-man:** the intended path is `@Observe`/`@Log` emit a `{kind:'message'}` event while `scope`'s span is the active OTel context, and the adapter's `record` copies `message.attributes` onto `trace.getActiveSpan()`. Then a value *can* reach a span. — This does not hold. It is stated nowhere; the §2 adapter sketch's `record` handles only `'violation'` and never touches message attributes; it depends on the message and the scope temporally overlapping; and it still routes every value through the low-cardinality-typed `Attributes` map. Worse, §5 retains the value-bearing `console.log` string *only as the no-sink fallback* — so installing the very JSON-console sink §10 ships to make values "visible out of the box" **replaces** the value-bearing string with value-free structured facts. Under the plan as written it is genuinely ambiguous whether an installed sink ever sees a `@Telemetry.value()` value, and both disambiguations are bad (values only in the no-sink string → no real sink ever gets them; or values in `message.attributes` → the low-cardinality map now carries PII). The plan must pick one and type for it.

**Fix:** add a per-parameter value/attribute slot to `completed` (and permit it on `violation` for the emitting parameter), or pass `InvocationContext` into `scope`. This is a change to the frozen union — hence fatal-before-building, not friction.

#### F2 — The around-sink starves the adapter of per-call runtime data (value and error).

`scope(observation, proceed)` and `settle` are the entire span seam, and both are blind to what actually happened in the call:

- `proceed: () => T` is a zero-arg thunk closing over `context.args` internally, so **`scope` never sees the arguments.** An adapter cannot attach an argument value at span creation even in principle.
- `settle` is extracted "verbatim" from `Time.ts` (§5), whose callback is `Report = (durationMs, kind, outcome, settled) => void` — **no return value, no thrown error.** `timeThenable`/`timeObservable` re-throw the error but never hand it to `report`. The plan's own two call sites confirm the shape: §2 uses `(outcome, settled) => …`, §4 uses `(outcome, durationMs, settled) => …`. Neither carries value or error. (That the same `settle` is called with two different callback arities in one document is itself evidence the seam is not actually pinned.)
- `completed` reports `outcome:'threw'` but no error object.

Concrete walls an adapter author hits, none of which "delegate to the sink" can rescue because the sink is the thing being starved:

1. **Ordinary method exceptions lose all detail.** The §2 sketch does `if (outcome === 'threw') span.setStatus({code: ERROR})` — and that is *all* it can do, because it never receives the error. `span.recordException(actualError)` — bread-and-butter OTel — is impossible for every non-contract throw. Traces get a red span with no exception type and no stack.
2. **No span attribute can be derived from a return value** (`http.response.status_code` from the returned response, row-count from a query result). `settle` discards the value.
3. **No argument value on a span, no span Link from argument content, no dynamic span name** — all need per-call data `scope` is not given. `Observation.name` is fixed `Owner.member` at install.

The "delegate everything to the sink" thesis is sound *only if the sink is handed enough to act on*. As specified it is handed install-time metadata and a boolean outcome. **Fix before building:** `settle(result, onSettle)` must pass the settled value or thrown error to `onSettle`, and `scope` must receive `InvocationContext`. Because §11.1 makes `settle`'s extraction the O1a deliverable "so the seam has to exist before the adapter can be correct," getting its arity right is a **precondition of O1a**, not an O2 concern.

#### F3 — O1 ships no way to declare span kind; every span is `INTERNAL`.

§8 correctly lists "Span kind" as not derivable and defers `@Observe({kind})` as "an *additive* option, not a default." But the effect for O1 is that a developer instrumenting an outbound HTTP client or an inbound handler **cannot mark the boundary at all** — the adapter has nothing on `Observation` to read a kind from, so it defaults to `INTERNAL` for everything. Span kind is the single authoring decision OTel most expects an instrumentation author to make (`SERVER`/`CLIENT`/`PRODUCER`/`CONSUMER` drive service-graph edges), the design's own prior-art (`@WithSpan(kind=…)`, §2.7) carries it, and it is *not* one of the delegate-to-the-SDK concerns (the SDK cannot infer it either). Deferring it makes O1's tracing story INTERNAL-only. This is one line on `Observation` plus one option on `@Observe`; shipping the tracing seam without it is under-building the primitive, not restraint. Ranked below F1/F2 only because it is purely additive and breaks nothing later.

---

### FRICTION (note, not blocking)

#### Fr1 — The explicit-name escape hatch (DEC-OBS-4) is coupled to value disclosure, and absent for the headline deliverable.

The minification mitigation the plan calls "the most serious honest weakness" is `@Telemetry.value('accountId')` — but that annotation *also discloses the value*. There is no standalone "name this parameter for telemetry" declaration. So:

- To fix a **name** under minification you must make a **value-disclosure** decision. A developer who wants correct names but redacted values has to reach for `@Telemetry.redact(...)`-with-a-name (if redact even accepts a name — the plan only documents the hatch on `.value`).
- The **automatic violation telemetry** — O1b, the headline, emitted from `enforcementBehavior` with no annotation — has *no* name hatch at all. `ViolationFacts.parameterName` degrades to `s`/`e`/`t` or absent in exactly the minified production build where the violation-rate metric is the point, and the developer has no opt-out because there is no decorator on that path to carry one.

The mitigation is narrower than the weakness §11.5 admits. Point 7's "under-stated" lands: the honesty about minification is real, but the answer covers only the opt-in value surface, not the automatic projection that is the strongest demonstration.

#### Fr2 — `@Sensitive` silently nullifies an explicit `@Telemetry.value()`, with no diagnostic and no override — the most paternalistic corner.

Per `Log.ts`, a class-level `@Sensitive` sets `classSensitive`, which makes `paramSensitive[i]` true for *every* parameter. Feed that through the §7 resolver — `sensitive ? 'deny'` wins first — and `@Telemetry.value()` on any parameter of a `@Sensitive` class resolves to `'deny'`. The developer's explicit, source-visible, reviewed opt-in emits **nothing**, silently. There is no `@Telemetry.value({force:true})`, no per-parameter un-sensitise, and the §7 privacy projection reports what *leaves* the process, not what was *vetoed despite an opt-in* — so the nullification is invisible in the one artifact that could surface it.

This fails *safe* (no value leaks), so it is friction, not fatal. But it is the sharpest point of tension with the user's stated "provide functionality and trust developers rather than protect them from themselves" philosophy: a knob (override the veto) is withheld entirely for the developer's own good, and an explicit declaration is overridden without a word. For PII this is defensible under DEC-025; the objection is the *silence*. At minimum the resolver should be able to tell the projection "opted-in but vetoed," so a reviewer sees the collision instead of an empty cell.

#### Fr3 — `ObservationDetail` / `setObservationVerbosity` is the one knob included on principle, not demand.

The plan "counts knobs as cost." This one earns scrutiny by its own rule. It adds a **third** emission gate on top of "is a sink installed?" and "is a decorator present?": now also "does this site's `detail` clear the host verbosity?" Its justification is upstream guidance (verbose spans behind a disabled-by-default option), which is sound — but O1 ships no consumer that needs the second level, and the design cannot point to one beyond a hypothetical class-wide `@Observe()`. It is defensible and low-rot, but it is the knob most likely to sit unused, and in a plan whose thesis is knob-minimalism it deserves the same "wait for real demand" the plan applies to per-constraint trust (DEC-008) and span kind. Flagging, not opposing.

#### Fr4 — Two attacks the reviewer was asked to press that the plan actually survives.

Reported honestly, because a failed attack is signal:

- **"Cliff between quiet defaults and writing a whole adapter" (mandate 1) largely fails.** §10 ships a JSON-to-`console` `ObservationSink` a consumer opts into with one call, and `setValueDisclosure('all')` (DEC-030) turns values on process-wide for local debugging. So "trace these three methods to the console, with argument values, in dev only" is reachable *without authoring an adapter*: `@Observe()` on the three methods, `if (process.env.NODE_ENV !== 'production') setObservationSink(consoleSink)`, `setValueDisclosure('all')` in the same guard. The in-between exists. (The residual wall is F1's: whether that console sink actually *renders* the disclosed values depends on the unresolved message-attribute question — so the scenario works for structure and duration today and for values only once F1 is decided.)
- **"An adapter that needs to end a span differently" (mandate 4) fails.** Span-ending is *not* imposed by adorn — the adapter owns the `onSettle` callback inside its own `scope` and calls `span.end()` itself (§2). An adapter that wants to end on a different signal writes a different callback. `settle` classifies *when work settles*; it does not dictate *what the adapter does at settle*. This one is genuinely flexible.

---

### Where it sits: paternalistic vs trusting, over vs under

**Under-configurable, decisively — and concentrated in the primitive, not the periphery.** The delegated axes (sampling, retention, export, batching) are correctly refused; that is delegation, not paternalism, and the argument in §8 holds. The paternalism that does exist is narrow: value disclosure is deny-by-default (right, per DEC-030) but the `@Sensitive` veto is un-overridable and un-surfaced (Fr2), and — the real story — the value *transport* is simply missing (F1/F2), so the model reads as "values hard to turn on" when it is actually "values have nowhere to go." That distinction matters for the fix: this is not a philosophy that over-protects developers, it is a model that was built permission-first and forgot the payload. Against the user's "trust developers" stance the plan is *almost* aligned; it withholds exactly one thing developers will reach for on day one — a value or an error on a span — and withholds it by omission rather than by policy. Fix F1 and F2 and the model becomes as trusting as the philosophy asks, without loosening a single safe default.
```

