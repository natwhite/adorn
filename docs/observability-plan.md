# adorn — Observability Plan

*Research and design for incorporating OpenTelemetry-compatible observability into adorn. Produced 2026-07-19.*

> **Status: proposal.** Nothing here is implemented and nothing here is ratified. The decision entries in §7 are written in `DECISIONS.md` style but live in this file deliberately — they are proposals, and `DECISIONS.md` is being edited concurrently.
>
> **How to read the claims.** Everything in §2 is *verified* against a primary source and linked. Everything in §3 onward is *my recommendation* and is labelled as such. Where I could not confirm something, §9 says so plainly rather than letting it pass as fact.

---

## 1. The thesis, and where it breaks

The user's framing:

> *"I would like logging to be one of the early features as well since adding in logging after the fact and maintaining it is highly tedious (much like docs / schemas / tests)."*

The argument transfers, and it transfers for exactly the reason DEC-006 gives. Retrofitted logging rots the same way retrofitted documentation rots: it is a second statement of what the code means, maintained separately from the code, and it begins disagreeing immediately. A `logger.info(\`creating order for ${userId}\`)` is a sentence about the method that nothing checks against the method. Rename the parameter and the log line still says `userId`. Add a parameter and the log line silently omits it. This is the same drift DEC-006 exists to abolish, in a fifth dialect.

**But the analogy is not clean, and the place it breaks is load-bearing.** It should be stated before any design is built on it.

Validation, documentation, testing and fuzzing are all **pure projections**: they read the declaration that already exists and need nothing added. `describe()` plus `params` plus a parameter name is sufficient to emit a doc line, a JSON Schema fragment, or an arbitrary. Nobody has to write anything new.

Observability is **not uniformly a pure projection**. It splits in two, and the halves behave differently:

| | Derivable from what is already declared? |
|---|---|
| **Contract-violation telemetry** — which constraint failed, on which parameter, of which declared type, at which method, under which trust level | **Yes, entirely.** This is a true fifth projection. It costs the developer nothing and is available the moment a violation fires. |
| **Span and log telemetry** — is this method a service boundary worth a span in production? is this argument's *value* safe to emit? what does this parameter *mean* in the domain? | **No.** These are genuinely new declarations. The registry knows a parameter is named `email` and is a `String`; it does not and cannot know whether emitting its value is a GDPR incident. |

So the honest claim is narrower and more defensible than "observability is the fifth projection":

> **Contract-violation telemetry is a true projection of the existing declaration and should be built first. Span and log telemetry is a new cross-cutting concern that *reuses* the registry and *adds* a small declarative surface of its own.**

The narrower claim is still strong, and §5.2 argues that the violation half is the single most convincing demonstration adorn has of DEC-006 — better than the documentation projection, because it produces something hand-written code structurally cannot produce at all.

The overclaim to avoid: "decorate your code, get observability for free." That is the same shape as "decorate your code, get a fuzz suite," which Q-3 already forced the project to retract. Do not make it twice.

---

## 2. Findings

### 2.1 OpenTelemetry vs OTLP — four things that get conflated

These are four distinct artifacts and the design depends on keeping them apart.

1. **The OpenTelemetry API** (`@opentelemetry/api`) — a set of interfaces and *non-operational* implementations. This is what instrumented code calls. Verified: the package README states "The methods in this package perform no operations by default. This means they can be safely called by a library or end-user application whether there is an SDK registered or not." ([api README](https://github.com/open-telemetry/opentelemetry-js/blob/main/api/README.md))

2. **The OpenTelemetry SDK** (`@opentelemetry/sdk-node`, `sdk-trace-base`, …) — the operational implementation. Registers itself against the API and turns the API's no-ops into real telemetry. Applications install this; libraries do not.

3. **Semantic conventions** (`@opentelemetry/semantic-conventions`) — a naming standard for attributes, span names, and metric names. Not code that does anything; a vocabulary so that two independently written instrumentations describe the same thing the same way.

4. **OTLP** — the *wire protocol*, and only that. Per the spec, it "describes the encoding, transport, and delivery mechanism of telemetry data between telemetry sources, intermediate nodes such as collectors and telemetry backends." Three transports: OTLP/gRPC (port 4317), OTLP/HTTP+binary-protobuf and OTLP/HTTP+JSON (both 4318); gzip or none for compression. ([OTLP spec](https://opentelemetry.io/docs/specs/otlp/))

**Consequence for adorn:** OTLP is irrelevant to this design. adorn will never speak OTLP; an SDK in the consumer's application does. Anyone framing this work as "add OTLP support" has already made a category error. The only question adorn faces is its relationship to (1), and secondarily its adherence to (3).

### 2.2 The API/SDK split, and what it means for a *library* — the critical question

This is the most consequential finding and it is well-documented upstream.

**Verified guidance for libraries.** The official instrumentation-for-libraries page states, unambiguously: *"Libraries should only use the OpenTelemetry API."* And: *"Unless your application imports the OpenTelemetry SDK, your instrumentation does nothing and does not impact application performance."* It further advises: *"Use the earliest stable OpenTelemetry API (1.0.\*) and avoid updating it unless you have to use new features."* ([Libraries guidance](https://opentelemetry.io/docs/concepts/instrumentation/libraries/))

The same page also gives guidance directly relevant to §5.4: *"If they have to be spans (to carry and propagate unique trace context), put them behind a configuration option and disable them by default."* Verbose instrumentation is expected to be opt-in.

**Verified package facts.** `@opentelemetry/api` at version **1.9.1** has **zero runtime dependencies**, `engines.node >= 8.0.0`, and an unpacked size of **1,001,329 bytes across 588 files**. ([npm registry metadata](https://registry.npmjs.org/@opentelemetry/api/latest))

**Verified declaration convention.** Official instrumentation packages declare the API as a **peer**, not a dependency. `@opentelemetry/instrumentation-http` lists `"@opentelemetry/api": "^1.3.0"` under `peerDependencies`, with `@opentelemetry/core`, `@opentelemetry/instrumentation` and `@opentelemetry/semantic-conventions` as ordinary dependencies. ([npm registry metadata](https://registry.npmjs.org/@opentelemetry/instrumentation-http/latest))

**Verified — and this is the part the marketing copy elides.** "Does nothing and does not impact application performance" is not literally true. Reading the `NoopTracer` source: `startSpan` allocates and returns a `NonRecordingSpan`; `startActiveSpan` allocates that span, builds a **new context object** via `setSpan`, and executes the callback inside `contextApi.with(...)`. ([NoopTracer source](https://raw.githubusercontent.com/open-telemetry/opentelemetry-js/main/api/src/trace/NoopTracer.ts)) The no-op path is *cheap*. It is not *free*, and it allocates per call.

**Verified hazard — the global singleton.** The API README explains that it "takes advantage of a variable on the `global` object to store the global API. When an API method in the API package is called, it checks if this `global` API exists and proxies calls to it if and only if it is a compatible API version." If a package depends on an **incompatible** API version, "the package will receive a no-op implementation of the API." ([api README](https://github.com/open-telemetry/opentelemetry-js/blob/main/api/README.md))

That failure is silent. Two incompatible copies of `@opentelemetry/api` in one `node_modules` tree produce telemetry that simply does not appear, with no error. This is a direct argument for declaring the API as a **peer** dependency — peers deduplicate against the application's copy — rather than as an ordinary dependency, which can nest a second copy.

### 2.3 The three signals in JavaScript — what is actually stable

Verified from the OpenTelemetry JS documentation ([JS docs](https://opentelemetry.io/docs/languages/js/)):

| Signal | JS status |
|---|---|
| **Traces** | **Stable** |
| **Metrics** | **Stable** |
| **Logs** | **Development** |

Browser instrumentation is separately called out as "experimental and mostly unspecified."

**The Logs situation is worse than "development" suggests, and it matters.** `@opentelemetry/api-logs` is at **0.219.0** and its own npm description says it "provides everything needed to interact with the unstable OpenTelemetry Logs Bridge API," that the API "is considered alpha software with no guarantee of stability or long-term support," and that when it stabilises it will move into `@opentelemetry/api` and this package will be **deprecated**. ([npm](https://www.npmjs.com/package/@opentelemetry/api-logs))

Most importantly for adorn:

> *"The API is not intended to be called by application developers directly. It is provided for logging library authors to build log appenders, which use this API to bridge between existing logging libraries and the OpenTelemetry log data model."*

That is an interesting position for adorn. adorn is arguably *exactly* the intended consumer — it would be bridging its own structured records into the OTel log data model, which is the log-appender role. But the package is 0.x and self-described as alpha, so the correct action today is to design for it and not depend on it. See DEC-OBS-6.

### 2.4 The span-events deprecation — live, and it changes the design

**This is the most timely finding and it is recent enough to be easy to miss.**

OpenTelemetry is deprecating the Span Events API. Per the official blog post ([Deprecating Span Events API](https://opentelemetry.io/blog/2026/deprecating-span-events/), March 2026, tracking [OTEP 4430](https://github.com/open-telemetry/opentelemetry-specification/blob/main/oteps/4430-span-event-api-deprecation-plan.md)):

> *"The tracing specification will deprecate APIs such as `Span.AddEvent` and `Span.RecordException` in favor of emitting log-based events."*

The stated motivation is removing the duplication between span events and log-based events. Guidance to instrumentation authors is explicitly transitional: maintain backward compatibility in current stable versions, *"consider adding an opt-in mechanism in current major versions … to emit log-based events alongside existing span events,"* and migrate in the next major. The post is careful to say *"Deprecation is about providing a single recommended way to emit events in new code, not about removing visibility into events on spans"* — no removal date is given.

**Why this is decisive for adorn.** The single most natural OTel call for "a contract was violated" is `span.recordException(violation)`. That call is being deprecated *right now*, its replacement (log-based events) sits on a JS Logs API that is *alpha* (§2.3), and the migration is explicitly scheduled for instrumentations' next majors. Any design that hardcodes an OTel call into adorn's core buys adorn a migration it does not control, on a timeline it cannot influence, for a call it will have to support both ways during the transition.

A design that emits a neutral violation record and lets a thin adapter choose the call form absorbs this entirely — the adapter ships a major, adorn does not move. §4.1 is built on this.

### 2.5 Semantic conventions relevant to adorn

**Code attributes** ([registry](https://opentelemetry.io/docs/specs/semconv/registry/attributes/code/)) — all **Stable**, and recently renamed, which is a trap for anyone working from older examples:

| Current | Type | Was |
|---|---|---|
| `code.function.name` | string | `code.function` **and** `code.namespace` (merged; now requires the fully-qualified name) |
| `code.file.path` | string | `code.filepath` |
| `code.line.number` | int | `code.lineno` |
| `code.column.number` | int | `code.column` |
| `code.stacktrace` | string | — |

Note specifically that **`code.namespace` is deprecated and folded into `code.function.name`**. adorn's natural `Owner.method` string is therefore *already* the correct shape for the current convention — `code.function.name: "Task.test"` — and should not be split across two attributes as older guides show.

**Error attributes** ([registry](https://opentelemetry.io/docs/specs/semconv/registry/attributes/error/)):

- `error.type` — **Stable**. "Describes the class of error." Guidance: *"predictable, and SHOULD have low cardinality"* within a single instrumentation library. `_OTHER` is the defined fallback.
- `error.message` — **Deprecated**. Use domain-specific error-message attributes instead. Explicitly discouraged on metrics and spans for cardinality reasons.

**Exception attributes** ([spans](https://opentelemetry.io/docs/specs/semconv/exceptions/exceptions-spans/) — note this document is itself marked deprecated in favour of the logs form, consistent with §2.4): `exception.type` (Stable), `exception.message` (Stable, and flagged **"May contain sensitive information"**), `exception.stacktrace` (Stable), `exception.escaped` (Deprecated).

**Attribute requirement levels** ([spec](https://opentelemetry.io/docs/specs/semconv/general/attribute-requirement-level/)) — this is the standard adorn's PII design should be built to satisfy:

- **Required** / **Conditionally Required** / **Recommended** — progressively weaker obligations.
- **Opt-In** — *"Instrumentations SHOULD populate the attribute if and only if the user configures the instrumentation to do so."* Opt-In is the prescribed level for attributes with performance cost, **security/privacy risk**, or high cardinality.

Argument values are unambiguously Opt-In material under this rubric. §5.3 builds on it.

**There is no semantic convention for validation or contract violations.** I checked the registry and found none. Any `adorn.*` attributes are therefore adorn's own namespace, which is the correct thing to do (semconv reserves unprefixed names) but means adorn is defining a vocabulary, not adopting one. That is a small ongoing maintenance obligation and is listed in §8.

### 2.6 Sensitive data — the official position

Verified ([Handling sensitive data](https://opentelemetry.io/docs/security/handling-sensitive-data/)):

> *"OpenTelemetry collects telemetry data, but it can't determine what data is sensitive in your specific context on its own. As the implementer, you are responsible for … ensuring compliance with applicable privacy laws and regulations [and] protecting sensitive information in your telemetry data."*

And the foundational recommendation:

> *"The best way to prevent the collection of sensitive data is not to collect data that might be sensitive."*

Post-collection mechanisms exist in the Collector — attribute processor, filter processor, redaction processor (allowlist-based), transform processor — but these are remediation at the far end of the pipeline, after the data has left the process.

The convention-authoring guide adds that attributes which may contain PII should be documented with a warning and *should be Opt-In rather than Required* ([how to write conventions](https://opentelemetry.io/docs/specs/semconv/how-to-write-conventions/)).

**Read against adorn:** the responsibility is explicitly the instrumentation author's, the recommended control is *not collecting*, and the collector-side redaction processors are a backstop that only helps consumers who run a collector they control. A library that emits argument values by default and points at the redaction processor has not solved the problem; it has exported it.

### 2.7 Prior art — how comparable libraries do this

**OpenTelemetry Java's `@WithSpan` / `@SpanAttribute`** ([docs](https://opentelemetry.io/docs/zero-code/java/agent/annotations/)) is the closest precedent to what adorn would build, and the closest to adorn's shape:

- `@WithSpan` on a method creates a span named `<className>.<methodName>` by default, kind `INTERNAL` by default, inheriting the current context (`inheritContext`, default `true`), and — notably — for methods returning futures/reactive types the span does not end until the async operation completes. **That is precisely the "settling" problem `@Time` already solves** in `src/MethodDecorators/Time.ts`, arrived at independently. Good sign for the design.
- `@SpanAttribute` is a **separate, per-parameter, opt-in** annotation that captures a parameter's value as a span attribute. Attribute name is explicit or derived from the parameter name — and derivation requires compiling with `-parameters`, i.e. the name is not always available.

Two things adorn should take from this. First, **the split is right**: creating a span and capturing an argument value are separate decisions with separate annotations, and value capture is opt-in per parameter. Second, **the name-availability caveat is the same one adorn has**: Java needs `-parameters`; adorn recovers names by parsing `Function.prototype.toString` and loses them under minification (SMELL-1). Java's answer is to let you state the name explicitly. adorn should do the same (§8, and DEC-OBS-4).

**`nestjs-otel`** ([repo](https://github.com/pragmaticivan/nestjs-otel)) provides `@Span`/`@Traceable` method decorators plus metric decorators (`@OtelCounter`, `@OtelHistogram`, …). Reading its `Span` decorator source: it acquires a tracer via `trace.getTracer(OTEL_TRACER_NAME)`, uses `tracer.startActiveSpan(...)`, records errors with `span.recordException(error)` and sets `SpanStatusCode.ERROR`, re-throws, and handles promises via `.then`/`.catch`/`.finally` so the span ends on settle. ([source](https://raw.githubusercontent.com/pragmaticivan/nestjs-otel/main/src/tracing/decorators/span.ts))

**What it gets right:** it does **not** record argument values. Arguments are read only to compute dynamic span options; they never become attributes. That is the safe default, arrived at by a mainstream library, and it corroborates §5.3.

**What it gets wrong from adorn's standpoint:** it is bound directly to `@opentelemetry/api` at the decorator, so the decorator and the backend are one thing — you cannot use `@Span` with anything else, and it inherits the `recordException` deprecation (§2.4) directly. It is also framework-coupled (NestJS DI), which adorn is not and should not become. Other entries in the space (`@helveg/opentelemetry-nestjs`, `@cherie-xf/nestjs-microservice-otel`) share the same structure.

**The gap nobody in this space fills:** every decorator-based tracing package I found instruments *methods*. None of them knows anything about the method's *contract*, because no such data exists in those ecosystems. The violation telemetry in §5.2 has no prior art in JavaScript that I could find, which is either a genuine opening or a sign nobody wants it. I lean toward the former (see §5.2) but flag it as unproven in §8.

### 2.8 Cost and overhead

**When an SDK is registered:** real cost — span allocation, attribute serialisation, context propagation via `AsyncLocalStorage`, batching and export. Published OTel JS benchmarks give order-of-magnitude figures for SDK-side work: `create spans (10 attributes)` at ~719,000 ops/sec, `BatchSpanProcessor process span` at ~662,000 ops/sec, `transform 1 span` at ~943,000 ops/sec. ([benchmark data](https://open-telemetry.github.io/opentelemetry-js/benchmarks/data.js), via [Benchmarks](https://opentelemetry.io/docs/languages/js/benchmarks/)) Roughly a microsecond per span of SDK-side work — negligible for an I/O-bound service method, potentially dominant for a hot in-memory method called in a loop.

**When no SDK is registered:** cheap but not free (§2.2) — `NonRecordingSpan` allocation plus a context object plus a `context.with` call per `startActiveSpan`.

**I could not find a published benchmark of the no-op path specifically.** The maintainers' own words in the relevant discussion are that if no SDK is present "it's a noop (with hopefully minimal overhead)" — *hopefully*, with no measurement offered. ([discussion #4414](https://github.com/open-telemetry/opentelemetry-js/discussions/4414)) I am recording this as unquantified rather than asserting a number. See §9.

**Sampling changes the picture, but less than people expect, and in a specific way.** Head-based sampling decides at span *creation*; a sampled-out span is still created as a non-recording span, so the allocation and the context work still happen — what is saved is attribute recording and export. Tail-based sampling saves nothing at the process; the span is fully created and exported, and the decision happens downstream in a collector. So sampling is a control on *pipeline cost and storage bill*, and only partially a control on *in-process cost*. A design that says "overhead is fine, we sample" has answered the wrong question if the concern is per-call latency in a hot method.

**adorn-specific overhead that is not OTel's.** adorn's wrapper already costs, per call: an `arguments` copy into a fresh array, an `InvocationContext` object literal, and a closure allocation for `proceed`. `@Contract` + `@Log` + `@Time` on one method today installs **three** wrappers and pays that three times. That is a real, existing, measurable cost and it is an argument for unification (§5.5) independent of OTel.

---

## 3. Constraints this design must respect

Restated from the codebase so the proposal can be checked against them:

1. **DEC-012** — projections may depend on `Core/` and `Contracts/` only, never on a decorator adapter.
2. **DEC-019 / GAP-6 / SMELL-16** — the rxjs scar. A manifest change is not sufficient; an eager import on the `index.ts` path makes the package fail to load for consumers who never use the feature. And a *lazy guarded `require` with a string-literal specifier is still statically resolvable by a bundler*, so it does not solve the problem either — it converts "wasteful pull-in" into "unresolved-module diagnostic." This is documented as unverified-against-a-real-bundler in SMELL-16 but the reasoning is sound and the design must not rely on that pattern.
3. **DEC-010** — anything that is data must be identity + params with behaviour *derived*, never attached, so description and behaviour cannot drift.
4. **The sink pattern** — `setTimingSink`, `setContractDiagnosticsSink`, `setConfigurationSink`, `setViolationPolicy`. Established, consistent, and the right shape.
5. **The around-behaviour seam** — `MethodBehavior = (context, proceed) => result` in `MethodDecoratorFactory.ts`. One shape, deliberately not a before/after/onError triple.
6. **Q-6** — registry introspection is semver-relevant the moment a projection binds to it. An observability model that projections and adapters bind to is a public API surface and inherits this.
7. **No RxJS.** Nothing here is designed around Observables. `@Time`'s duck-typed Observable branch is dormant interop and stays as-is.

---

## 4. Design proposal — the central recommendation

### 4.1 adorn emits *observations*; a separate package translates them to OTel

**Recommendation.** adorn's core defines a neutral observation model and an around-shaped sink. It never imports `@opentelemetry/api`. A separately published `@adorn/otel` package implements the sink in terms of the OTel API.

**The arguments for, in order of strength:**

1. **The OTel surface adorn would bind to is moving right now.** `Span.recordException` is being deprecated in favour of log-based events (§2.4), the JS Logs API those events need is alpha (§2.3), and the official guidance to instrumentation authors during the transition is to support *both*, opt-in. If that dual-emission and eventual migration lives in adorn's core, adorn owns a migration on someone else's timeline. If it lives in an adapter, the adapter ships a major and adorn does not move. This is not a hypothetical future-proofing argument; the deprecation is live and dated.

2. **DEC-019 is unambiguous about what a hard third-party import costs.** adorn just removed a dependency because eagerly importing it broke `require('adorn')` for everyone. A separate package makes the specifier appear only in a package that declares it — the one shape that has no bundler-resolution seam at all (§3.2).

3. **DEC-012's spirit, if not its letter.** DEC-012 forbids projections depending on a *decorator adapter*. An OTel import is not that. But the rule exists so that "four artifacts from one declaration" does not silently become "four artifacts, if you use this one toolchain." Wiring adorn's only observability path to one vendor's API reproduces that failure with a different vendor. A neutral model keeps adorn usable with a plain logger, a custom sink, a test spy, or a backend that is not OTel.

4. **It matches what `@Time` already decided.** `Time.ts`'s own header argues this position: *"There is no aggregation, no percentile tracking, no sampling, no span hierarchy … Those belong to whatever telemetry system a host already runs, which is exactly why the sink is pluggable."* The observability layer should generalise that decision, not contradict it.

**The trade-off, stated honestly — this is the main cost and it is not small.**

A span is not a record. It is an *ambient scope* that must be **active while the method body runs**, so that anything the body does — an HTTP call that OTel auto-instruments, a database query, a nested decorated method — nests underneath it in the trace. You cannot reconstruct that from a fire-and-forget event stream emitted after the fact. `tracer.startActiveSpan(name, opts, fn)` must literally wrap the call.

A naive "emit a record to a sink" indirection would therefore produce **flat, unparented spans** and destroy the single most valuable property of tracing. That is a real way this design could fail, and it is how I would expect a first implementation to get it wrong.

**The resolution — the sink is around-shaped, not fire-and-forget.** This is the load-bearing detail of the whole proposal:

```ts
// src/Core/Observation.ts  — no third-party imports, ever

/** Everything derivable about one instrumented call. Built lazily; see §8 risk 1. */
export interface Observation {
    readonly owner: string;              // 'Task'
    readonly member: string;             // 'test'
    /** `Owner.member` — already the correct shape for semconv `code.function.name` (§2.5). */
    readonly name: string;
    readonly isStatic: boolean;
    /** Per-parameter facts. Values appear only where explicitly permitted — §5.3. */
    readonly parameters: ReadonlyArray<ObservedParameter>;
    readonly detail: ObservationDetail;  // 'always' | 'detail' — §5.4
}

/** A point-in-time record: a violation, a completed measurement, a log line. */
export type ObservationEvent =
    | {kind: 'violation'; observation: Observation; violation: ViolationFacts}
    | {kind: 'completed'; observation: Observation; durationMs: number; outcome: 'returned' | 'threw'; settled: boolean}
    | {kind: 'message'; observation: Observation; level: LogLevel; message: string; attributes: Attributes};

export interface ObservationSink {
    /**
     * Around-shaped. THE reason this is not `(event) => void`: a span must be the *active*
     * context for the duration of the call, so that work the method does nests underneath it.
     * The OTel adapter implements this as `tracer.startActiveSpan(o.name, {...}, () => proceed())`.
     * A sink that only wants records implements this as `proceed` and uses `record` alone.
     */
    scope?<T>(observation: Observation, proceed: () => T): T;

    /** Fire-and-forget. Violations, completions, messages. */
    record?(event: ObservationEvent): void;
}
```

`scope` preserves full tracing fidelity — the adapter gets to wrap `proceed()` and therefore owns the active context — while `record` handles everything that is genuinely a point event. adorn's around-behaviour composes with an around-shaped sink exactly, with no impedance mismatch. This is why the `MethodDecoratorFactory` seam is the right place: it is *already* the shape `startActiveSpan` wants.

**What `@adorn/otel` then is:** roughly a hundred lines. `scope` becomes `startActiveSpan` with attributes derived from the observation. `record` for a `violation` becomes `span.recordException` today and a log-based event when the JS Logs API stabilises — **a change entirely inside the adapter**. `record` for a `completed` becomes a histogram observation. That is the whole package.

**Alternative considered and rejected: adorn depends on `@opentelemetry/api` directly.** It is simpler, it is what `nestjs-otel` does, and the API is genuinely zero-dependency and no-op-by-default. Rejected on (1) and (2) above: it puts a moving upstream API and a 1MB/588-file install on adorn's critical path, in a project whose single most recent scar is precisely that.

**Alternative considered and rejected: a lazy guarded `require('@opentelemetry/api')` inside adorn.** This is what `@Time` does for rxjs, and SMELL-16 documents why it is not good enough — the string literal is statically resolvable, so a bundled consumer gets an unresolved-module diagnostic for a dependency they never asked for. Repeating the pattern would reproduce GAP-6 with a different package name.

### 4.2 Where it hooks in — the around seam

`MethodDecoratorFactory.MethodBehavior` is the correct and only seam. `@Time` already proves an observability-shaped behaviour installs cleanly through it. The observation behaviour is, in outline:

```ts
function observeBehavior(observation: Observation): MethodBehavior {
    return function (context, proceed) {
        const sink = getObservationSink();
        if (sink === NOOP_SINK) return proceed();          // one reference compare — §8 risk 1
        // ... scope + timing + record, all built lazily
    };
}
```

Two properties this must have, and they are requirements not optimisations:

- **The uninstrumented path is one reference comparison.** No object built, no attributes assembled, no string formatted, unless a sink is actually installed.
- **The `Observation` is built at install time where it can be, not per call.** `owner`, `member`, `name`, `isStatic`, parameter names and declared types are all fixed for the life of the wrapper. `ContractInstaller` already does exactly this for `ViolationSite` and cites the same reason. Only per-call facts (duration, outcome, permitted values) are assembled per call.

### 4.3 What the registry already knows, and what it does not

**Derivable today, with no new developer input:**

| Fact | Source |
|---|---|
| class name, method name, static-vs-instance | `getContractsForClass` → `ClassMethodContract.isStatic`; owner resolution as in `ContractInstaller.ownerNameOf` |
| parameter **names** | `ParameterContract.name`, populated by `ParameterDecoratorFactory.captureSignature` (BUG-14's fix) |
| parameter **declared types** | `ParameterContract.type` from `design:paramtypes` |
| parameter **index** and arity | `ParameterContract.index` |
| constraint **identity** and **params** | `ConstraintDescriptor.constraint` / `.params` |
| constraint **prose** | `ConstraintDescriptor.describe()` |
| **trust** level | `ViolationSite.trust` |
| whether enforcement is installed | `MethodContract.installed` |
| field contracts, incl. inherited | `getFieldContractsForClass` / `getEffectiveFieldContract` |

**Not derivable, and honestly requiring declaration:**

| Fact | Why the registry cannot know it |
|---|---|
| Span **kind** (`INTERNAL` / `SERVER` / `CLIENT`) | A method's architectural role is not a property of its signature. |
| Whether a parameter's **value** may be emitted | `string` is `string`. This is the PII question and it is unanswerable from types. §5.3. |
| Domain **meaning** (`user.id` vs `order.id`) | Semantic, not structural. |
| Whether a method deserves a **production span** | Cost/benefit judgement about a call's frequency and importance. §5.4. |

**Two caveats on the "derivable" column that must not be glossed over:**

- Parameter names come from parsing `Function.prototype.toString` (SMELL-1) and **degrade under minification** — `sku` becomes `s`. Telemetry keyed on parameter name therefore degrades exactly where telemetry matters most: the production build. This is the most serious honest weakness in the whole proposal; §8 risk 3 develops it and DEC-OBS-4 proposes the mitigation (an explicit-name escape hatch, which is what Java's `@SpanAttribute` does for the same reason).
- Declared types come from `design:paramtypes`, which erases to `Object` for interfaces, unions and generics, and is **absent entirely** under esbuild/Babel (DEC-004). The registry already documents `type` as "advisory only." Telemetry must render the absence, never a fabrication — the same rule `docs.ts` already follows.

### 4.4 Layering

```
src/Core/Observation.ts        ← model + sink slot. Zero third-party imports. Decorator-agnostic.
src/Core/ObservationBehavior.ts← the MethodBehavior. Adapter-side (knows InvocationContext).
src/Projections/telemetry.ts   ← derives Observations from the registry. Core/ + Contracts/ only.
src/MethodDecorators/Log.ts    ← sugar over the behaviour.
src/MethodDecorators/Time.ts   ← sugar over the behaviour.
@adorn/otel  (separate pkg)    ← ObservationSink implemented on @opentelemetry/api (peer).
```

`Observation.ts` sits in `Core/` and imports nothing outside it, so DEC-012 holds for the projection. `telemetry.ts` reads the registry and descriptors only — the same test `docs.ts` states: swap the legacy adapter for a standard-decorator one and not a line changes.

---

## 5. The design questions, worked through

### 5.1 Structured logging derived from declarations

**What is derivable.** A log record for a call to `Task.test(message: string, count: number)` can be assembled with no developer input beyond `@Log()`:

```jsonc
{
  "code.function.name": "Task.test",          // §2.5 — Owner.member is the current convention
  "adorn.parameters": [
    {"name": "message", "index": 0, "type": "String", "present": true},
    {"name": "count",   "index": 1, "type": "Number", "present": true}
  ],
  "adorn.outcome": "returned",
  "adorn.duration_ms": 12.4
}
```

Note what is *not* there: the values. Presence, position, name and declared type are structural facts about the call. The values are the payload, and the payload is where the risk is (§5.3).

This is already strictly better than today's `@Log`, which emits `Call: test("hunter2",42) => undefined` — a string that no aggregator can group, filter or alert on, and which contains every argument value unconditionally.

**What still needs declaring.** The *meaning* of a log line. adorn can say "`Task.test` was called and returned in 12.4ms." It cannot say "an order was placed." If a developer wants the latter, they must write it — `@Log({message: 'order placed'})` — and that is correct: it is genuinely new information, and pretending otherwise is the overclaim §1 warns about.

**The honest boundary.** adorn can make *call-level* logging free and structured. It cannot make *domain-event* logging free. Those are different things and the documentation should not blur them. Call-level logging is nonetheless the tedious, drift-prone, copy-pasted half — which is exactly the half the user's argument is about.

### 5.2 Contract violations as telemetry — the strongest case

**This is the part I would build first and the part I would put in the README.**

When `@StringMinLength(10)` rejects an argument, adorn holds, as *data*, with zero developer effort:

```jsonc
{
  "code.function.name":         "Task.test",
  "error.type":                 "adorn.min_length",   // low cardinality — §2.5
  "adorn.contract.constraint":  "minLength",
  "adorn.contract.params":      {"min": 10},
  "adorn.contract.kind":        "string",
  "adorn.contract.parameter":   "message",
  "adorn.contract.parameter.index": 0,
  "adorn.contract.parameter.type":  "String",
  "adorn.contract.trust":       "guard",
  "adorn.contract.expectation": "a string of at least 10 characters"   // describe()
}
```

Conspicuously absent: the offending value. Deliberately, and by default. §5.3.

**Why this is a better demonstration of DEC-006 than the documentation projection.**

The documentation projection proves adorn can render a declaration it already has. Impressive, but a reader can reasonably say "I could have written that markdown by hand." The violation projection produces something **hand-written validation structurally cannot produce at all**:

```ts
if (message.length < 10) throw new Error('message too short');
```

That produces a *string*. Nothing can group by it. You cannot ask "which of my contracts fails most often in production?" — you can only grep for a message that will be reworded in three months. There is no `constraint` dimension, because there is no constraint object; the identity `minLength` and the bound `10` were dissolved into instructions the moment the developer wrote the `if`.

Because DEC-010 forces constraints to be reified identity + params, adorn hands the telemetry pipeline a **low-cardinality, groupable, stable dimension for free** — which is exactly what `error.type` asks for (§2.5: "predictable, and SHOULD have low cardinality"). That is a capability, not a convenience.

**And it closes a loop the other four projections do not.** Documentation, tests and fuzzing are all *static* — they describe the declaration. Violation telemetry is the only projection that **reports back from production about whether the declaration matches reality**:

- A `minLength: 10` constraint firing 4,000 times a day is not a bug in the callers. It is a **wrong contract**, and adorn is the only thing in the codebase positioned to notice.
- A `guard` firing at a boundary is external input being rejected as designed — expected, and worth a rate.
- An `assert` firing is an internal invariant broken — that is an incident, and the `trust` dimension distinguishes the two automatically because DEC-008 already made the developer say which it was.

That last point is a genuine, unforced synergy between two decisions made for unrelated reasons. It is also the "far horizon" item from `vision.md` — *"contracts that adapt, informed by what actually happens at runtime"* — reachable much earlier than that document assumed, because the data is already there.

**The metric this implies** (Phase O3): a counter `adorn.contract.violations` with dimensions `{constraint, parameter, code.function.name, trust}`. All four are low-cardinality by construction. No values, ever, on a metric — metric cardinality is where unbounded attributes become an outage.

**Interaction with `setViolationPolicy` (DEC-008).** The existing `ViolationPolicy` already accepts a handler, and the docstring already says "route to telemetry." A telemetry sink must **not** be implemented as a violation policy handler, because the policy has *control-flow* semantics: a handler that returns suppresses the violation and the method proceeds. Conflating "observe this" with "suppress this" would be a serious bug. Observation must be a separate, non-authoritative side-channel that fires regardless of policy and cannot influence it. **This holds under `'warn'` too** — a suppressed-and-proceeded violation is still a violation and must still be observed, arguably more urgently, since `'warn'` exists precisely for staging a contract over live traffic and the whole point is to measure what it *would* have rejected.

### 5.3 PII and redaction — first-class

**Position: adorn must never emit an argument value unless a developer has explicitly declared that value emittable, per parameter.** This is not a default that can be flipped by a convenience flag, and a design that logs values by default is not acceptable.

**Why deny-by-default and not redact-by-default.**

- **A denylist fails open, and fails silently.** Add a parameter to a method and its value is emitted until someone remembers to annotate it. adorn has already ruled, in DEC-016, that a silent omission from an artifact is worse than a loud failure because nothing throws to reveal it. This is the same failure *inverted*: silent **inclusion**. Nothing throws there either — you find out from a compliance audit or a breach.
- **Types carry no signal.** `string` is `string`. `design:paramtypes` cannot distinguish `email` from `sku`, and erases to `Object` for exactly the rich domain types most likely to be sensitive.
- **Name heuristics are a trap and should not be the primary mechanism.** A regex catching `/password|token|secret|key/i` catches `password` and misses `dob`, `ssnLast4`, `motherMaidenName`, `answer`, `note`, `body`, `payload`. A filter that works most of the time is worse than none, because it manufactures confidence. If shipped at all, a heuristic may only ever act as a *second denial layer* — able to suppress a value the developer permitted, never to promote one they did not.
- **It is what the standard asks for.** OTel's Opt-In requirement level is defined as *"SHOULD populate the attribute if and only if the user configures the instrumentation to do so"* and is prescribed specifically for privacy-risky attributes (§2.5). Deny-by-default is literal conformance, not caution.
- **It is what the mainstream library does.** `nestjs-otel`'s span decorator never records argument values (§2.7).

**The three-tier declarative surface.**

```ts
@Contract()
class Accounts {
    transfer(
        @Telemetry.value()                 @GreaterThan(0)  amount: number,   // emitted
        @Telemetry.redact('hash')                           accountId: string,// surrogate
                                           @StringMinLength(1) memo: string,  // never emitted
    ) {}
}
```

1. **Say nothing → the value never leaves the process.** Only structural facts: presence, `typeof`, and — where cheap and safe — length or size. `{"name": "memo", "present": true, "type": "String", "length": 42}` is often enough to debug and carries no payload. Even `length` should be off for anything not declared safe, since a length can be a fingerprint.
2. **`@Telemetry.value()` → the value is emitted.** Explicit, per parameter, and *visible in the source next to the parameter it governs* — locality of intent, exactly as `vision.md` demands.
3. **`@Telemetry.redact(strategy)` → a derived surrogate is emitted.** `hash` (stable pseudonym for correlation), `length`, `first(n)` / `last(n)`, `domain` for emails, `type` for "something was here."

**Redaction strategies must be descriptors, not closures — DEC-010 applied unchanged.** A strategy is identity + params with the transform *derived*. This is not stylistic consistency; it buys the same anti-drift property for a case where drift is a security bug rather than a documentation bug. `redact('hash')` that documents itself as hashing and actually truncates is a `Q-4`-shaped failure with a much worse blast radius. Derivation makes it unexpressible.

**The artifact this produces, which is the genuinely novel part.** Because redaction is a declaration in the registry, the documentation projection can emit a table of **every parameter in the codebase whose value leaves the process, and in what form**:

| Class.method | Parameter | Type | Telemetry |
|---|---|---|---|
| `Accounts.transfer` | `amount` | Number | **value emitted** |
| `Accounts.transfer` | `accountId` | String | redacted (`hash`) |
| `Accounts.transfer` | `memo` | String | not emitted |

No logging library can produce that, because no logging library knows what the parameters are. This is a privacy-review artifact generated from the code that actually runs, and it is a sixth projection falling out of the same registry. It is also the strongest possible answer to "how do I know we're not leaking?" — and it makes the *absence* of a `@Telemetry.value()` reviewable, which a code search for `logger.info` never is.

**Honest limits, stated rather than buried:**

- **Hashing is pseudonymisation, not anonymisation.** A hash of an email is stable and re-identifiable; under GDPR it is still personal data. The API must say so at the call site and the docs must say so loudly. `redact('hash')` reduces exposure; it does not discharge a compliance obligation.
- **Return values are the same problem and get the same rule.** `@Log`'s output today includes `safeStringify(result)`. Returns are frequently richer in PII than arguments — a `getUser` returns the whole user. Deny-by-default applies identically, with a `@Telemetry.result()` opt-in.
- **Violation *messages* already embed values today.** `Descriptor.formatMessage` produces `... but received 'hunter2' instead`, and if a violation is routed to telemetry with its message attached, the value leaks through the back door regardless of parameter annotations. The structured violation attributes in §5.2 must therefore be assembled from `constraint` + `params` + `describe()` and **must not include `error.message` or the rendered message string**. `error.message` is deprecated in semconv anyway (§2.5), which makes this a free choice — but it must be a deliberate one, or the whole deny-by-default design is defeated by one convenient field.
- **`@Log()`'s current behaviour is a live exposure, not a hypothetical.** It stringifies every argument to `console.log` unconditionally. That is fine for a demo decorator and unacceptable for the front door of an observability story. Fixing it is a **breaking change** to `@Log` and should be taken deliberately and early, before anyone depends on the current behaviour. See DEC-OBS-3.
- **Constraint `params` can themselves carry business data.** `@OneOf(['gold', 'platinum', 'internal_vip'])` puts a tier list into every violation attribute set. Low risk, real, and worth a documented note rather than a mechanism.

### 5.4 Verbosity and environment — is DEC-008 a real parallel?

**Partly. The structural analogy holds; the semantics invert; and cloning the vocabulary would be actively harmful.**

**Where it genuinely holds.** Both are per-site declarations of *why this thing exists*, resolved at install time, which determine whether it survives production. Both reject a single global boolean for the same reason: the sites are not fungible, so one switch must either keep everything (useless) or strip everything (harmful). That reasoning transfers intact.

**Where it breaks — three ways, and the third is decisive.**

1. **Different axis.** DEC-008's axis is *safety*. Stripping a `guard` removes the check between hostile input and the code behind it; stripping an `assert` costs a debugging aid. Observability's axis is *cost and noise*. Emitting too much is a bill and a haystack; emitting too little is a blind spot. Getting DEC-008 wrong is a vulnerability. Getting verbosity wrong is an invoice.

2. **The safe default inverts.** DEC-008 defaults to `guard` — survives production — because erring toward *more enforcement* is erring safely. Observability must default toward *less*: no values, no span unless asked, because erring toward more emission is a data-leak vector and a cost. **Two models whose defaults point in opposite directions must not share a word.** A developer who has internalised "adorn defaults to the safe, loud thing" would carry precisely the wrong intuition across.

3. **OTel already owns this problem, better, at runtime.** Verbosity in tracing is **sampling** — a runtime, context-propagated, head-or-tail decision made by the SDK with information adorn does not have (current trace context, parent sampling decision, live rate budgets). An authoring-time verbosity ladder baked into adorn would *fight* the sampler: adorn drops a span the sampler would have kept, and the trace has a hole nobody can explain. Reinventing this is the "worse version of one the user already has" that `Time.ts` explicitly refuses to build.

**Recommendation: do not clone the trust model. Ship one two-valued axis and stop.**

```ts
type ObservationDetail = 'always' | 'detail';
```

- `always` — a boundary worth observing in production. The default for `@Observe`/`@Log` on a method someone deliberately annotated.
- `detail` — observed only when the consumer turns detail on. For methods annotated broadly (a class-wide `@Observe()`) where per-method spans would be noise.

Two levels, because two is what the *authoring* decision can honestly distinguish; everything finer is a runtime question and belongs to the sampler. This also matches the upstream guidance verbatim: *"If they have to be spans … put them behind a configuration option and disable them by default"* (§2.2).

`NODE_ENV` handling should reuse `Configuration.getEnforcementMode()` — read per call, not cached at module load — so the two subsystems agree about what "production" means rather than each deciding separately.

### 5.5 Relationship to `@Log` and `@Time`

**Recommendation: both become thin sugar over one observation behaviour, and `@Time`'s sink API is preserved as a documented alias.**

Reasons, in order:

1. **`@Time` is already the design.** Its header argues, in its own words, for exactly the layering proposed here: produce the measurement, hand it to a pluggable sink, let the host's telemetry system decide. `TimingRecord` generalises to `ObservationEvent{kind:'completed'}` with essentially no semantic loss — `owner`, `member`, `label`, `durationMs`, `outcome`, `settled` all survive. `setTimingSink` should keep working and be documented as a narrow view of the observation sink. Breaking it would be a break for no benefit.

2. **`@Time`'s settling logic is the hard part and it is already solved.** Classifying sync / thenable / observable and stopping the clock when the work *finishes* rather than when it *returns* is exactly what a span needs — OTel Java's `@WithSpan` solves the identical problem for futures and reactive types (§2.7). This logic must be shared, not reimplemented, or `@Time` and spans will report different durations for the same call, which is the drift DEC-006 exists to prevent showing up in telemetry.

3. **One wrapper instead of three — a real, measurable cost argument.** `@Contract` + `@Log` + `@Time` on one method today installs three wrappers: three `arguments` copies, three `InvocationContext` literals, three `proceed` closures per call. A single behaviour that does span + duration + record is one. This is the strongest argument for unification and it does not depend on the OTel story at all.

4. **`@Log` must change regardless.** Unstructured `console.log` with unconditional value stringification is not a foundation. Rebasing it is not gold-plating; it is fixing a live PII exposure (§5.3) while the API has no dependents.

**What stays separate.** The *decorators* stay separate — `@Log()` and `@Time()` are good names for common intentions and should not be collapsed into one `@Observe({log: true, time: true})` monstrosity. What unifies is the machinery underneath. Sugar at the top, one behaviour at the bottom.

### 5.6 Dependency weight — the non-negotiable answer

Stated precisely, because the question was asked precisely.

**adorn core: zero new dependencies. Not a dependency, not a peer, not an optional peer, not a lazy `require`.**

`src/Core/Observation.ts` contains an interface, a sink slot, and a no-op default. TypeScript interfaces erase at compile time. There is no specifier for a bundler to resolve, nothing to install, nothing that can fail to resolve, and no repeat of GAP-6 available. This is stronger than "optional peer dependency" — it is *no dependency at all*, which is the only category with a zero failure rate.

**What a consumer who wants none of this pays:**

| | Cost |
|---|---|
| Install size | **Zero.** No new package, no new transitive tree. |
| Load time | **Zero.** `Observation.ts` has no imports outside `Core/`. |
| Bundler | **Zero.** No specifier appears anywhere for static analysis to resolve or warn about. |
| Runtime, undecorated methods | **Zero.** Nothing installs. |
| Runtime, `@Contract()` only | **Zero** in the steady state; one reference comparison on the violation path *only when a violation actually fires*. |
| Runtime, `@Log`/`@Time`/`@Observe` applied but no sink installed | **One reference comparison per call** (`sink === NOOP_SINK`), then straight to `proceed()`. No object allocated, no attributes assembled, no string formatted. |
| Types | Types only; erased. |

**`@adorn/otel`: a separately published package.**

| | |
|---|---|
| `peerDependencies` | `"@opentelemetry/api": "^1.9.0"` — matching the convention verified in official instrumentation packages (§2.2) |
| `devDependencies` | the same, so its own suite resolves |
| `dependencies` | `adorn` (or a peer on it, decided when it is built) |
| Explicitly **not** | `optionalDependencies` — DEC-019 already established npm installs those by default, defeating the purpose |

**Why peer and not dependency, specifically:** the global-singleton version check (§2.2). An incompatible second copy of `@opentelemetry/api` in the tree degrades to a **silent no-op** — telemetry that simply does not appear, with no error. A peer dependency deduplicates against the application's copy; an ordinary dependency can nest a second one. This is the difference between working and silently-not-working, and it is not discoverable by testing in isolation.

**Cost when someone installs `@adorn/otel` but registers no SDK:** the ~1MB / 588-file `@opentelemetry/api` install (with zero transitive dependencies), plus the per-call no-op cost of §2.2 — a `NonRecordingSpan` allocation, a context object, and a `context.with` call. Cheap, real, and *not* the "no impact" the upstream docs claim. A consumer who wants adorn's structured records without any OTel installs nothing and uses their own sink.

---

## 6. Phased plan

The scheduling argument that matters: **the phase the user wants early is the phase that is least blocked.** Nothing in O0 or O1 touches OpenTelemetry at all. The OTel questions — which are the ones with moving upstream APIs and dependency risk — are entirely confined to O2 and later.

### Phase O0 — the observation model *(early; blocked on nothing)*

- `src/Core/Observation.ts`: `Observation`, `ObservationEvent`, `ObservationSink` (with the around-shaped `scope`), `setObservationSink`, no-op default.
- `src/Core/ObservationBehavior.ts`: the `MethodBehavior`, with lazy assembly and the single-comparison fast path.
- The **redaction declaration surface** — `@Telemetry.value()`, `@Telemetry.redact(strategy)` — with strategies as `defineConstraint`-style descriptors, and registry storage alongside `ParameterContract`.

**Why the redaction surface belongs in the *first* phase and not later.** This is the DEC-010 lesson applied: settle the shape before authoring on top of it. If `@Log` ships emitting values and redaction arrives afterwards, the fix is a breaking change *and* a security advisory for every version in between. DEC-006's own scheduling note says writing fifteen constraints as closures and retrofitting is "precisely the rework to avoid." Same argument, higher stakes.

### Phase O1 — structured logging and violation telemetry *(early; this is the user's ask; blocked on nothing)*

- `@Log()` rebased: structured `ObservationEvent`, **no values unless declared**, routed to the sink. Breaking change, taken deliberately (DEC-OBS-3).
- `@Time()` rebased onto the same behaviour; `setTimingSink` preserved as a documented alias.
- **Violation observations** — every contract violation emits a structured event with constraint identity, params, parameter name, declared type, trust, and `code.function.name`. As a side-channel, independent of `setViolationPolicy`, firing under `'warn'` too (§5.2).
- A default sink writing structured JSON to `console`, so it does something visible out of the box — the same role `@Time`'s `DEFAULT_SINK` plays today.

**Deliverable at the end of O1: adorn produces structured, aggregatable telemetry with no third-party dependency whatsoever.** That is the whole of the user's "logging early," and it does not require a single OTel decision.

### Phase O2 — `@adorn/otel` *(not blocked, but should follow O0/O1)*

- Separate package. `scope` → `startActiveSpan`. Attributes per §2.5 (`code.function.name`, `error.type`, `adorn.contract.*`).
- Violations → `span.recordException` **today**, with the migration to log-based events (§2.4) confined to this package.
- Semantic-convention mapping and `schema_url`.

**Gated, not blocked.** The technical work is possible now. It should wait only until the observation model has survived real use, because the moment an adapter binds to it the model is a public API surface and inherits Q-6's semver problem.

### Phase O3 — metrics *(not blocked; lower value until something is running)*

- `adorn.contract.violations` counter, dimensions `{constraint, parameter, code.function.name, trust}` — all low-cardinality by construction, no values ever.
- Duration histogram from `@Time` records.

### Phase O4 — OTel Logs *(genuinely blocked upstream)*

**Blocked on the JS Logs Bridge API leaving alpha.** Verified: `@opentelemetry/api-logs` is 0.x, self-described as alpha with no stability guarantee, and slated to be folded into `@opentelemetry/api` and deprecated when it stabilises (§2.3). Depending on it now means depending on a package that is scheduled to be deleted.

I cannot date this. It is the one item here with a real external dependency and it should be planned as indefinite.

### Deliberately not scheduled

- Context propagation across process boundaries — that is the SDK's job and adorn should not touch it.
- Log correlation IDs — comes free from OTel context once O2 exists; inventing adorn's own would be a competing standard.
- Browser instrumentation — upstream calls it experimental and mostly unspecified (§2.3).
- Anything requiring a `@adorn/rx` module.

---

## 7. Proposed decision entries

> **Proposals only.** Written in `DECISIONS.md` format for easy transfer. **The `DEC-OBS-n` identifiers are placeholders** — `DECISIONS.md` is being edited by other agents concurrently, so these must be renumbered into the main sequence on adoption rather than merged with these IDs.

### DEC-OBS-1 — adorn emits neutral observations; an adapter translates to OpenTelemetry
**Status:** PROPOSED

**Context.** Observability could be added by depending on `@opentelemetry/api` directly, which is zero-dependency, no-op by default, and what comparable libraries do. Against that: `Span.recordException` — the natural call for a violation — is being deprecated in favour of log-based events (OTEP 4430, March 2026); the JS Logs API those need is alpha; and upstream guidance to instrumentation authors during the transition is to support both, opt-in. Separately, DEC-019/GAP-6 established what a third-party import on the load path costs this project.

**Decision.** `src/Core/Observation.ts` defines a neutral `Observation` / `ObservationEvent` / `ObservationSink` model with **zero third-party imports**. A separately published `@adorn/otel` implements the sink over `@opentelemetry/api`, declared as a `peerDependency` (`^1.9.0`), matching the convention verified in `@opentelemetry/instrumentation-http`.

**The sink is around-shaped, and that is load-bearing.** `ObservationSink.scope<T>(observation, proceed): T` wraps the call, because a span must be the *active* context while the method body runs or nested work is orphaned. A fire-and-forget `(event) => void` sink would produce flat, unparented spans and destroy the main value of tracing. `record(event)` handles genuine point events.

**Consequences.** adorn stays usable with a plain logger, a test spy, or a non-OTel backend. Upstream API churn is absorbed by the adapter. Cost: one indirection, a second package to publish and version, and the risk that a first implementation gets `scope` wrong and emits flat spans — which the design must be tested against explicitly.

### DEC-OBS-2 — argument values are never emitted unless declared, per parameter
**Status:** PROPOSED

**Context.** adorn knows every parameter's name, index and declared type, which makes automatic value logging trivially easy to implement and dangerous to ship. OTel's own guidance is that privacy-risky attributes are **Opt-In** — *"SHOULD populate the attribute if and only if the user configures the instrumentation to do so"* — and that the best control is not collecting.

**Decision.** Deny by default. Absent a declaration, telemetry carries structural facts only (presence, declared type, position, name). `@Telemetry.value()` opts one parameter in. `@Telemetry.redact(strategy)` emits a derived surrogate. Strategies are descriptors (identity + params, transform **derived**) per DEC-010, so a strategy cannot claim one thing and do another. Name-based heuristics may only ever *suppress*, never *promote*. Structured violation attributes are assembled from `constraint` + `params` + `describe()` and **must not carry the rendered violation message**, which embeds the received value.

**Consequences.** A safe default that stays safe as code changes — a new parameter is silently *excluded*, not silently included. Costs one annotation for developers who do want values. Yields a genuinely novel artifact: a generated table of every parameter whose value leaves the process, which is a privacy-review document no logging library can produce. Does **not** discharge compliance obligations — hashing is pseudonymisation, and the docs must say so.

### DEC-OBS-3 — `@Log` and `@Time` become sugar over one behaviour; `@Log`'s default changes
**Status:** PROPOSED · **breaking for `@Log`**

**Context.** `@Log` emits an unstructured string to `console.log` containing every argument value. `@Time` already has the right architecture and its header argues for exactly this layering. `@Contract` + `@Log` + `@Time` on one method installs three wrappers today.

**Decision.** One observation behaviour underneath; `@Log()` and `@Time()` remain as distinct sugar. `@Time`'s settling classification (sync / thenable / observable) is shared, not duplicated, so spans and timings never disagree about a duration. `setTimingSink` is preserved as a documented narrow view of the observation sink. **`@Log` stops emitting argument and return values by default** — a breaking change, taken now while the API has no dependents.

**Consequences.** One wrapper instead of three: fewer `arguments` copies, context literals and closures per call. `@Log`'s output changes shape and content; anyone parsing `Call: name(args) => result` breaks. Taken deliberately, because the current default is a live PII exposure and the cost of the break only grows.

### DEC-OBS-4 — observability declarations must survive minification
**Status:** PROPOSED

**Context.** Parameter names are recovered by parsing `Function.prototype.toString` (SMELL-1) and degrade to single letters under minification. Telemetry keyed on parameter name therefore degrades exactly in the production build, where telemetry matters most. OTel Java hit the identical problem — `@SpanAttribute` derives names from parameters only when compiled with `-parameters` — and solved it by allowing an explicit name.

**Decision.** Every observability annotation that depends on a recovered name accepts an explicit override: `@Telemetry.value('accountId')`. Where no name is available and none was given, telemetry emits the **index** and omits the name rather than emitting `arg0` — the same honest-absence rule `docs.ts` follows for missing types.

**Consequences.** Developers who minify and want reliable telemetry annotate names explicitly, which is a real ergonomic cost. The alternative — plausible-looking but wrong attribute names in production — is the "looks complete, is not" failure DEC-016 rejects. This is a genuine limitation of the whole approach, not a detail; it should be documented publicly rather than discovered.

### DEC-OBS-5 — observability verbosity does not reuse the DEC-008 trust model
**Status:** PROPOSED

**Context.** DEC-008's `guard`/`assert` split is a per-site declaration determining production survival, and a verbosity analogue is tempting.

**Decision.** Reject the analogy. Ship one two-valued axis, `ObservationDetail = 'always' | 'detail'`, defaulting to `detail` for broadly-applied annotations.

**Rationale.** Three breaks. DEC-008's axis is *safety* (getting it wrong is a vulnerability); verbosity's is *cost* (getting it wrong is an invoice). **The safe defaults invert** — DEC-008 defaults to `guard` because more enforcement errs safely; observability must default to less because more emission is a leak and a bill — so sharing vocabulary would carry precisely the wrong intuition across. And OTel already owns runtime verbosity via **sampling**, which has context adorn does not; an authoring-time ladder would fight the sampler and punch unexplainable holes in traces.

**Consequences.** Two levels only. Rate, retention and backend stay with the SDK. Matches upstream guidance that verbose spans go behind a config option, disabled by default.

### DEC-OBS-6 — OTel Logs is designed for and deferred
**Status:** PROPOSED

**Context.** Traces and Metrics are **Stable** in OTel JS; **Logs is Development**. `@opentelemetry/api-logs` is 0.x, self-describes as "alpha software with no guarantee of stability," and is slated to fold into `@opentelemetry/api` and be deprecated on stabilisation. It also states it is "not intended to be called by application developers directly … provided for logging library authors to build log appenders" — a role adorn arguably fits.

**Decision.** Do not depend on `@opentelemetry/api-logs`. Ship structured log records through adorn's own sink (Phase O1), which needs no OTel at all. Revisit when the Logs API lands in `@opentelemetry/api` proper.

**Consequences.** adorn's structured logs are not natively OTel log records until then; a consumer wanting that bridges the sink themselves, which is a handful of lines. Avoids depending on a package scheduled for deletion. The deferral is indefinite — no upstream date exists.

---

## 8. Risks and limitations

**1. Overhead is real and the mitigations are requirements, not optimisations.** adorn's wrapper already costs an `arguments` copy, a context literal and a closure per call. Observation adds to that. For an I/O-bound service method this is noise; for a hot in-memory method in a loop it may dominate. Mitigations that must be treated as binding: the uninstalled path is one reference comparison; the `Observation` is built at install time, not per call; attributes are assembled lazily and never when no sink is present. Get any of these wrong and the feature becomes a reason not to use adorn. **This should be benchmarked, not asserted** — I have not measured it and cannot claim a number.

**2. The no-op OTel path is cheap, not free — and unquantified.** Verified from source that `NoopTracer.startActiveSpan` allocates a `NonRecordingSpan`, builds a context object, and calls `context.with`. The upstream docs' "does nothing and does not impact application performance" overstates it. I could find **no published benchmark of the no-op path**; the maintainers' own phrasing is "hopefully minimal overhead." Anyone relying on this being free should measure it.

**3. Parameter names degrade under minification — the most serious weakness here.** Telemetry keyed on recovered names silently becomes `s`, `e`, `t` in exactly the build where it matters. DEC-OBS-4 mitigates via explicit names, but the mitigation is opt-in, so the default experience for a minifying consumer is degraded telemetry that *looks* fine. This limits how strongly "structured logging for free" can honestly be claimed, and the claim should be qualified in public documentation rather than in a footnote.

**4. `design:paramtypes` is weaker than it looks.** Erases to `Object` for interfaces, unions and generics; absent entirely under esbuild/Babel (DEC-004). Telemetry must render absence, never a guess. So the "declared type" attribute is present for simple primitives and missing precisely for the rich domain types most worth knowing about.

**5. PII risk is not eliminated by deny-by-default.** Constraint `params` can carry business data (`@OneOf(['gold','internal_vip'])`). Method and parameter *names* can be sensitive in themselves. Hashing is pseudonymisation, not anonymisation. And a developer who applies `@Telemetry.value()` broadly has re-created the problem — the design makes the safe path the default, it does not make the unsafe path unreachable.

**6. Upstream API instability is live, not hypothetical.** The span-events deprecation is dated March 2026 and in progress; the Logs API is alpha; `code.*` attributes were renamed recently enough that most examples online are wrong. DEC-OBS-1's adapter isolation is the mitigation and it is the main reason for the whole design — but it means `@adorn/otel` will need active maintenance in a way adorn's core will not, and someone has to sign up for that.

**7. Cardinality is a foot-gun on the metrics path.** `constraint`, `parameter`, `code.function.name` and `trust` are low-cardinality by construction. Values are not. Any convenience that lets a value onto a metric dimension turns a counter into an outage. The values-off default protects this, but the metrics path should refuse values structurally, not merely default to omitting them.

**8. The `@Log` break has a cost even though it is right.** Anyone parsing `Call: name(args) => result` breaks. It is the correct call while the API has no dependents, but it is a break and should be announced as one, not slipped in.

**9. The registry only sees what has been imported.** DEC-007's honest limitation applies unchanged: a class nothing imports is invisible. This matters less for observability than for docs — telemetry is emitted by code that is running by definition — but "which classes could emit telemetry?" is a static question with the same runtime-introspection caveat, and the privacy-review table of §5.3 inherits it. **A privacy-review artifact that silently omits an unimported module is exactly the "looks complete, is not" failure DEC-016 rejects**, and this deserves more thought before that table is presented as authoritative.

**10. The unproven part.** I found no JavaScript prior art for contract-violation telemetry (§2.7). I read that as an opening, because the enabling condition — reified constraints — does not exist in the JS ecosystem, so nobody *could* have built it. But "nobody has done this" is also consistent with "nobody wants it," and I cannot distinguish those from the outside. The cheapest test is Phase O1, which costs no dependency and produces the data; whether anyone finds the violation-rate metric valuable is then an empirical question rather than an argument.

---

## 9. What I could not verify

- **No-op path overhead in OTel JS.** No published benchmark found. The public benchmark suite covers SDK-side work (span creation, batch processing, OTLP transform) but not the no-SDK path. Maintainer language is "hopefully minimal overhead." Reasoning about allocation comes from reading the `NoopTracer` source, which is solid for *what happens* but gives no timing.
- **A date for the JS Logs API stabilising.** None published.
- **A removal date for `Span.AddEvent` / `Span.RecordException`.** The blog post explicitly declines to give one and stresses that deprecation is about guidance for new code, not removal.
- **SMELL-16's bundler behaviour** remains unverified against a real bundler in the codebase, and my §3.2 argument leans on it. The reasoning about static specifier resolution is sound but has not been demonstrated. It only *strengthens* the separate-package recommendation, so the conclusion does not depend on it — but the claim should not be repeated as verified.
- **Whether `@opentelemetry/api` v1.9.1 is genuinely the current latest** at time of reading, versus a cached registry response. Version, dependency count and size were read from the registry metadata directly.
- **Whether any JS library does contract-violation telemetry.** I searched and found none; absence of evidence at this depth is weak evidence of absence.

---

## 10. References

**OpenTelemetry — concepts and guidance**
- [Instrumenting libraries](https://opentelemetry.io/docs/concepts/instrumentation/libraries/) — the API-only rule for libraries; verbose spans behind a disabled-by-default option.
- [JavaScript](https://opentelemetry.io/docs/languages/js/) — signal status table (Traces/Metrics Stable, Logs Development).
- [JS instrumentation](https://opentelemetry.io/docs/languages/js/instrumentation/) — `startActiveSpan` vs `startSpan`; libraries install only the API.
- [Benchmarks](https://opentelemetry.io/docs/languages/js/benchmarks/) · [raw data](https://open-telemetry.github.io/opentelemetry-js/benchmarks/data.js)
- [Handling sensitive data](https://opentelemetry.io/docs/security/handling-sensitive-data/) — implementer responsibility; "the best way … is not to collect."

**OpenTelemetry — specification**
- [OTLP specification](https://opentelemetry.io/docs/specs/otlp/) — the wire protocol, transports, ports.
- [Attribute requirement levels](https://opentelemetry.io/docs/specs/semconv/general/attribute-requirement-level/) — the Opt-In definition.
- [Code attributes registry](https://opentelemetry.io/docs/specs/semconv/registry/attributes/code/) — `code.function.name` and the renames.
- [Error attributes registry](https://opentelemetry.io/docs/specs/semconv/registry/attributes/error/) — `error.type` stable, low cardinality; `error.message` deprecated.
- [Exception conventions for spans](https://opentelemetry.io/docs/specs/semconv/exceptions/exceptions-spans/) — itself deprecated in favour of the logs form.
- [How to write semantic conventions](https://opentelemetry.io/docs/specs/semconv/how-to-write-conventions/) — PII attributes should be Opt-In.
- [Deprecating Span Events API](https://opentelemetry.io/blog/2026/deprecating-span-events/) · [OTEP 4430](https://github.com/open-telemetry/opentelemetry-specification/blob/main/oteps/4430-span-event-api-deprecation-plan.md)
- [OTEP 0202 — events and logs API](https://github.com/open-telemetry/opentelemetry-specification/blob/main/oteps/0202-events-and-logs-api.md)

**Packages and source**
- [`@opentelemetry/api` README](https://github.com/open-telemetry/opentelemetry-js/blob/main/api/README.md) — no-op default; the global singleton and version-compatibility check.
- [`@opentelemetry/api` registry metadata](https://registry.npmjs.org/@opentelemetry/api/latest) — 1.9.1, zero dependencies, 1,001,329 bytes / 588 files.
- [`@opentelemetry/instrumentation-http` registry metadata](https://registry.npmjs.org/@opentelemetry/instrumentation-http/latest) — API as `peerDependency: ^1.3.0`.
- [`@opentelemetry/api-logs` on npm](https://www.npmjs.com/package/@opentelemetry/api-logs) — alpha; for log-appender authors; to be deprecated on stabilisation.
- [`NoopTracer` source](https://raw.githubusercontent.com/open-telemetry/opentelemetry-js/main/api/src/trace/NoopTracer.ts) — allocation on the no-op path.
- [opentelemetry-js discussion #4414](https://github.com/open-telemetry/opentelemetry-js/discussions/4414) — "hopefully minimal overhead."

**Prior art**
- [OTel Java annotations](https://opentelemetry.io/docs/zero-code/java/agent/annotations/) — `@WithSpan` / `@SpanAttribute`; async settling; the `-parameters` name caveat.
- [nestjs-otel](https://github.com/pragmaticivan/nestjs-otel) · [Span decorator source](https://raw.githubusercontent.com/pragmaticivan/nestjs-otel/main/src/tracing/decorators/span.ts) — does not record argument values.
- [opentelemetry-nestjs](https://github.com/helveg/opentelemetry-nestjs)

**Internal**
- `README.md` · `docs/vision.md` · `docs/DECISIONS.md` (DEC-006, DEC-008, DEC-010, DEC-011, DEC-012, DEC-016, DEC-019) · `docs/ISSUES.md` (GAP-6, SMELL-1, SMELL-16, Q-3, Q-4, Q-6) · `docs/implementation-plan-t0-t1.md` §9
- `src/Core/MethodDecoratorFactory.ts` · `src/Core/ContractRegistry.ts` · `src/Core/Descriptor.ts` · `src/Core/Configuration.ts` · `src/Core/ContractInstaller.ts` · `src/MethodDecorators/Time.ts` · `src/MethodDecorators/Log.ts` · `src/Projections/docs.ts`
