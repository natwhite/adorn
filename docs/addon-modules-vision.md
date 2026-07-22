# adorn — The Add-on Module Ecosystem

*A vision for what grows around adorn's core once the around-behaviour seam and the reified-descriptor registry are taken seriously as a platform. Produced 2026-07-21. This expands `vision.md`'s **Direction 2 (cross-cutting concerns)** from a sketch into a concrete module ecosystem, and expands **IDEA-8** (`docs/ISSUES.md`) from "a reactive module" into "the first of a family."*

> **Status: vision, not plan.** No code and no tracker changes accompany this document. It proposes an *architecture for add-ons* and a *catalogue of candidates*; nothing here is ratified, and the `@adorn/*` package names are working titles.
>
> **How to read the claims.** Statements about **how other libraries solve a concern** are verified against a primary or near-primary source and linked inline; a consolidated list is in §7. Statements about **what adorn should do** are proposals and are marked as such. Where a claim is my inference rather than a measured fact, it says so.
>
> **The observability module is treated as a worked exemplar, not re-derived.** `docs/observability-plan.md` already designs the OpenTelemetry add-on in depth — the neutral `Observation` model, the around-shaped sink, the adapter-as-separate-package pattern, deny-by-default PII. This document references it as the reference implementation of the contract below and then ranges wider. Read it first if you want the fully-worked case.

---

## 1. The thesis this document adds

adorn's founding move is that **a declaration becomes behaviour**: an inert annotation is rewritten into a live check that runs on every call. `vision.md`'s north star extends that — a declaration becomes behaviour *and* documentation *and* tests *and* fuzzing, because all four are restatements of one intent. That north star was argued for **value contracts** (what a method accepts and guarantees).

The claim of this document is narrower in subject and identical in shape:

> **A cross-cutting concern — a retry policy, a cache policy, a rate limit, a circuit breaker, an authorization rule — is also a declaration, and it also projects.** Stated on the method it governs, it becomes behaviour (the wrap), and it becomes an enumerable artifact: *"what does this system retry, cache, rate-limit, and guard?"* is a document that descends from the same registry the contracts do.

The two halves of adorn — the value contracts of Direction 1 and the cross-cutting concerns of Direction 2 — are usually treated as unrelated surfaces that happen to share a decorator syntax. §4 argues they are the *same* surface: both are reified declarations in one registry, and the registry's enumerability (DEC-011) is what makes the whole ecosystem a participant in the single-source-of-truth goal rather than a grab-bag of behaviours that each happen to be spelled with an `@`.

That is the idea that makes an *ecosystem* coherent. Everything else here is downstream of it.

---

## 2. The architectural contract for an add-on

An add-on library that merely exports decorators is not an adorn add-on; it is a decorator library that could have been written against any framework or none. What distinguishes an adorn add-on is that it plugs into the four seams the core already established and inherits their guarantees. Those seams exist today, in shipped code, and were each hard-won:

### 2.1 It rides the around-behaviour seam

Every method-wrapping concern is an *around* behaviour: `MethodBehavior = (context, proceed) => result`, defined in `src/Core/MethodDecoratorFactory.ts`. The seam hands the behaviour an `InvocationContext` (`target`, `propertyKey`, `original`, `wrapper`, `thisArg`, a mutable `args`) and a `proceed` thunk it is responsible for calling — or not. Retry calls `proceed` up to *n* times; cache calls it only on a miss; a circuit breaker refuses to call it while open; a timeout races it. One shape subsumes before/after/onError, deliberately (the factory's own comment argues this), and it is *already* the shape every one of these concerns wants.

`@Time` and `@Log` are built on exactly this seam and are the reference add-ons that happen to ship in-tree. An add-on that installs any other way — patching globals, owning its own `Object.defineProperty` path — has left the platform and forfeited its guarantees (DEC-005 is the record of how costly the non-seam path was).

A subtle but load-bearing property: adorn installs its wrapper as an **own property on the prototype** (`installMethodWrapper`), so an in-class self-call `this.foo()` *does* pass through the wrapper. This is stronger than the proxy-based interception that Spring's `@Cacheable`/`@Transactional` use, where [an internal self-invocation bypasses the proxy entirely](https://khmousa.medium.com/caching-limitations-in-spring-why-cacheable-fails-on-internal-method-calls-33e00a101ab5) and silently skips the aspect. adorn add-ons inherit the better behaviour for free — a real, citable advantage worth stating in their docs.

### 2.2 It reifies its policy as data, with behaviour *derived* from params

This is the seam that most cleanly separates an adorn add-on from a decorator library, and the one most easily skipped. A constraint in adorn is not a closure that throws; it is a `ConstraintDescriptor` — identity + JSON-serialisable params, with the predicate *derived* from the params by a `ConstraintDefinition` (`src/Core/Descriptor.ts`, DEC-010). Deriving rather than attaching is what makes the enforcement unable to drift from the documentation (Q-4).

A policy is the same shape, and in fact a *cleaner* instance of it:

- `@Retry({attempts: 3, backoff: 'exponential', base: 100})` is identity `retry` + params `{attempts, backoff, base}`.
- `@Cache({ttl: 60_000, maxSize: 500})` is identity `cache` + params.
- `@RateLimit({perSecond: 10, burst: 20})` is identity `rateLimit` + params.

The *wrapping behaviour* is derived from those params by one shared implementation, exactly as a predicate is derived from `{min: 0}`. A policy carries **no user predicate at all** — it is pure configuration — so the one thing that made constraints only *partially* projectable (you cannot synthesise a generator for a hand-written closure, Q-3/SMELL-14) does not arise for a policy's core. `@Retry(3)` is 100% data. That is why §4 can claim policies project *more* reliably than contracts do, not less.

**Proposal:** an add-on should record its policy through the same registry writers the constraints use, so a policy descriptor is registry-visible alongside the value contracts. The registry would grow a *concern* band beside its parameter and field bands (the plan's `categories` axis, deliberately unbuilt in DEC-008 because nothing needed it yet — an add-on ecosystem is what needs it).

### 2.3 It routes output through a pluggable sink — in one of two shapes

adorn never hard-wires where output goes. `@Time`'s `setTimingSink(next | null)` is the template (`src/MethodDecorators/Time.ts`): a module-level default sink, a per-site override via decorator options, `null` restores the default, and the sink call is wrapped in `try/catch` so *"measurement must never become the failure."* The same shape recurs as `setContractDiagnosticsSink`, `setViolationPolicy`, `setConfigurationSink`.

The observability plan discovered that a sink has **two shapes**, and the distinction generalises to every add-on:

- **Record-shaped** (`record(event) => void`): fire-and-forget point events. A cache hit/miss, a circuit-breaker state transition, a rate-limit rejection, a completed timing. Most add-ons need only this.
- **Around-shaped** (`scope(descriptor, proceed) => result`): the sink must own the *active scope while the method body runs*. A tracing span must be active during `proceed` so nested work parents under it; a **transaction** must be open during `proceed` so nested repository calls enlist in it; a **deadline scope** must be in force during `proceed` so downstream calls can read the remaining budget. A fire-and-forget sink produces flat, unparented spans — the observability plan's load-bearing detail (its §4.1), and it is the same reason `@adorn/tx` and `@adorn/deadline` need an around-shaped sink too.

An add-on picks the shape its concern requires and routes *all* output through it. Hard-wiring `console.log` (as `@Log` does today, BUG-18) is acceptable only as a visible default placeholder, never as the destination.

### 2.4 It adds zero mandatory dependencies to adorn core

This is the rxjs lesson, and it is not negotiable. DEC-019 / GAP-6 record what a single runtime dependency on the core load path cost: `require('adorn')` failed for every consumer because `index.ts` eagerly imported `Memoize`, which eagerly required `rxjs` — a manifest demotion to optional-peer did *not* fix it, and even a lazy guarded `require` with a string-literal specifier is statically resolvable by a bundler and so converts "wasteful pull-in" into "unresolved-module diagnostic" (SMELL-16). The only category with a zero failure rate is *no specifier in the core at all*.

Therefore: **any heavy runtime — `rxjs`, an OTel SDK, `lru-cache`, a Redis client — lives in the add-on package that declares it, as a real dependency (which it can, being opt-in) or as a peer.** The observability plan's §5.6 is the fully-worked statement of this: core defines a neutral model that erases at compile time (an interface has no specifier to resolve), and `@adorn/otel` is a separate package declaring `@opentelemetry/api` as a peer. The peer, not ordinary-dependency, choice is itself load-bearing there for a specific reason (the OTel global-singleton version check degrades to a silent no-op on a duplicated copy) — an add-on author should copy the *reasoning*, not cargo-cult the choice.

### 2.5 It keeps the core decorator-agnostic

DEC-012: projections may depend on `Core/` and `Contracts/` only, never on a decorator adapter. The consequence for add-ons is that a concern's *model* (its descriptor, its sink interface) lives in a Core-adjacent module that imports no decorator type, while the *decorator* that authors it lives adapter-side. This is what lets both the legacy per-parameter adapter and a future stage-3 adapter (DEC-003) author the same policy, and it is what lets a **projection** read the policy without dragging in a decorator toolchain. If an add-on binds its model to one decorator syntax, "enumerate the system's retries" silently becomes "enumerate the system's retries *if you used the legacy syntax*" — the exact reach failure DEC-012 exists to prevent.

### 2.6 It confines itself to safe-by-default emissions

DEC-025: adorn secures *its own emissions*, not the application's I/O. An add-on inherits this boundary. `@adorn/cache` must not log cache keys that embed argument values by default; `@adorn/otel`'s deny-by-default value rule (observability plan §5.3) is the template; a resilience add-on that logs the arguments of every retried call has re-created BUG-18 in a new package. The boundary narrows *what the add-on is responsible for* — not *how carefully it behaves inside that boundary*.

### The contract, in one paragraph

> **An adorn add-on is a package that expresses one cross-cutting concern as a decorator that (1) installs through the around-behaviour seam `(context, proceed) => result` rather than by patching or owning installation; (2) reifies its policy as identity + JSON-serialisable params with the wrapping behaviour *derived* from those params (DEC-010), so the policy is registry-visible and cannot drift from how it is documented; (3) routes every output through a pluggable sink in the `setTimingSink` shape — record-shaped for point events, around-shaped when the concern must own the active scope during the call; (4) adds *zero* mandatory dependencies to adorn core, keeping any heavy runtime in the add-on package that declares it as a peer (the rxjs lesson, DEC-019); (5) keeps the concern's model decorator-agnostic (DEC-012) so both adapters and every projection can consume it; and (6) confines its own emissions to adorn's safe-by-default discipline (DEC-025).** An add-on that meets these six is not another decorator library — it is a participant in adorn's single-source-of-truth registry, and its policies become enumerable artifacts alongside the value contracts.

---

## 3. The module catalogue

Each entry states: what it does, why it belongs as a *declaration* (locality of intent), what it depends on, how it rides the seam and the sink, and the prior art it should learn from. Verified facts about that prior art are linked; the adorn-specific design is proposal.

### 3.1 `@adorn/rx` — the reactive module (the seed, IDEA-8)

**What.** Reintroduces the functionality removed from core when `rxjs` was dropped: `@Memoize` for Observable-returning methods, Observable timing for `@Time`, and the flow-control decorators `vision.md` names (the deleted `queue.ts` stub, SMELL-6, was gesturing here).

**Why a declaration.** "Run this Observable once and replay it" is intent that belongs on the method, not copy-pasted `shareReplay` plumbing at every call site — which is exactly where the subtle bugs live.

**Depends on.** `rxjs`, as a real dependency (it can, being opt-in).

**Seam/sink.** The interop seams are *already built in core and must not be removed as dead code* (IDEA-8): `@Time`'s `loadObservable()` guarded lazy require and its `isObservableLike` duck-type (the `instanceof`-then-duck-type order BUG-5 established). SMELL-16's `setObservableConstructor()` fix — injecting the `Observable` constructor rather than resolving a static specifier — is unblocked and *belongs to this module*, since it is a public-API decision.

**Findings that must travel — do not re-derive (from IDEA-8).** These are carried in `docs/ISSUES.md` as `MOVED` precisely so a from-scratch rewrite does not walk back into them:
- **BUG-9:** `publishReplay()` + `refCount()` re-executes a non-completing source; the fix is `shareReplay({bufferSize: Infinity, refCount: false})`. Every "memoize an Observable" tutorial reaches for the broken pairing, and it *looks* correct because completing sources (the intended HTTP case) never expose it.
- **BUG-3:** storage is a per-decoration, per-instance `WeakMap<instance, Map<argKey, value>>`, never a prototype-level cache (which is shared, never invalidated, and ignores args — wrong three ways).
- **BUG-11 / BUG-15:** cache-key derivation for exotic containers (`Map`, `Set`, typed arrays) must be explicit; anything else exotic falls back to *identity* (a miss costs performance, a wrong hit costs correctness, and the two do not trade). BUG-15 — a user class hiding all state behind private fields keys as empty and collides — arrives **unsolved**, because both general remedies are worse than the bug. **This unsolved finding becomes a *security* hazard the moment a cache sits outside a guard; see §5.2.**
- **Cold-safety, above all:** nothing may be subscribed at decoration or call time.

This module is the proof that the "findings travel" discipline works: the entire hard-won memoization design is recoverable rather than rediscovered.

### 3.2 `@adorn/cache` — caching and memoization, generalised

**What.** The larger sibling of `@Memoize` for plain `Promise`- and value-returning methods, with the vocabulary `vision.md` asks for: argument-aware keys, TTL, size bounds, invalidation, per-instance vs shared scope, stale-while-revalidate, and single-flight coalescing.

**Why a declaration.** A hand-rolled cache is the most copy-pasted, most subtly-wrong cross-cutting concern in any codebase. Declaring `@Cache({ttl})` on the method states the caching intent next to the thing cached, where it can be read and audited, instead of scattered across callers.

**Depends on.** Optionally [`lru-cache`](https://github.com/isaacs/node-lru-cache) for eviction; otherwise a bounded map of its own. Either way the dependency lives in the add-on.

**Seam/sink.** A miss calls `proceed`, caches the *settled* value (the `@Time` settling classification, §5.4, is shared — you cache the resolved value, never the promise that might reject); a hit returns without calling `proceed`. Cache events (hit/miss/evict/refresh) are record-shaped observations.

**Prior art to learn from (verified).**
- **Eviction and TTL:** `lru-cache` exposes `max` (item count), `maxSize` + `sizeCalculation` (size-bounded), `ttl`, and a `dispose` eviction callback; stale items are purged on access rather than pre-emptively unless `ttlAutopurge` is set ([README](https://github.com/isaacs/node-lru-cache/blob/main/README.md)). This is the size-bounded and TTL vocabulary BUG-3's "unbounded per instance" note flagged as missing.
- **Stale-while-revalidate:** `lru-cache`'s `fetchMethod` option exists specifically for *"stale-while-revalidate type of behavior"* ([README](https://github.com/isaacs/node-lru-cache/blob/main/README.md)) — serve the stale value immediately, refresh in the background. This is the [SWR](https://swr.vercel.app/) / React Query pattern brought to the method boundary.
- **Cache stampede / dogpile:** when a hot key expires, concurrent misses all regenerate it at once. The fundamental fix is **single-flight / request coalescing** — only one regeneration for a key is in flight; the rest await it ([singleflight write-up](https://medium.com/pickme-engineering-blog/singleflight-in-go-a-clean-solution-to-cache-stampede-02acaf5818e3), [stampede prevention](https://oneuptime.com/blog/post/2026-01-21-redis-cache-stampede/view)). Note this is *distinct* from the cache itself: coalescing dedupes concurrent in-flight calls even for uncached or first-time keys.
- **Declarative precedent:** Spring's [`@Cacheable` / `@CacheEvict`](https://www.baeldung.com/spring-retry) and Polly's [`CachePolicy`](https://github.com/App-vNext/Polly/wiki/Cache) (a read-through / cache-aside implementation) show the annotation shape is mature and expected.

**Proposal-specific.** Invalidation is the interesting surface: `@CacheEvict({keyFrom})` on a *write* method that clears entries a *read* method populated is a cross-method relationship the registry can see — which ties into §4 (an audit of "which writes invalidate which reads' caches" is a projectable artifact, and a *missing* eviction is a staleness bug the registry could flag).

### 3.3 `@adorn/resilience` — retry, timeout, circuit breaker, fallback, bulkhead

**What.** The distributed-systems resilience vocabulary as declarations: `@Retry` with backoff, `@Timeout`, `@CircuitBreaker`, `@Fallback`, `@Bulkhead` (concurrency isolation).

**Why a declaration.** A method that *says* "retry three times with exponential backoff, then fall back" is more honest and more correct than the same logic tangled into its body — and, decisively for adorn, it is enumerable (§4): "what does this system retry?" is the single most safety-relevant question about a resilience posture, and no per-call-site implementation can answer it.

**Depends on.** Ideally nothing (retry/timeout/fallback are pure); a circuit breaker needs cross-call state but no external runtime.

**Seam/sink.** Each is an around-behaviour. Retry loops `proceed`; timeout races `proceed` against a timer (and must classify the settle, §5.4); the breaker consults its state before deciding whether to call `proceed`; fallback catches and substitutes. State transitions (breaker open → half-open → closed) are record-shaped observations.

**Prior art to learn from (verified).**
- **[cockatiel](https://github.com/connor4312/cockatiel)** is the JS-native reference: Backoff, Retry, Circuit Breaker, Timeout, Bulkhead, Fallback, composed via `wrap()`. Its wrap semantics are the model for adorn's composition story (§5.1): `wrap(retry, breaker, timeout).execute(fn)` is exactly `retry.execute(() => breaker.execute(() => timeout.execute(fn)))` — **the first policy listed is outermost** ([readme](https://github.com/connor4312/cockatiel/blob/master/readme.md)).
- **[opossum](https://github.com/nodeshift/opossum)** is the JS circuit-breaker reference: after `resetTimeout` the breaker goes *half-open* and admits one trial request; success closes it, failure re-opens; statistics live in a rolling window (`rollingCountTimeout` / `rollingCountBuckets`), and a `fallback` fires while open ([opossum docs](https://nodeshift.dev/opossum/)). The half-open/rolling-window state model is what makes a circuit breaker more than a boolean, and it is the part an adorn breaker must reify as *params* to stay projectable.
- **[Polly](https://github.com/App-vNext/Polly) (.NET)** and **[resilience4j](https://resilience4j.readme.io/docs/getting-started) (Java)** are the mature precedents, and their *ordering* discipline is the most valuable thing to take from them — see §5.1. resilience4j notably **hard-codes** the order `Retry(CircuitBreaker(RateLimiter(TimeLimiter(Bulkhead(Function)))))` regardless of annotation order, which is one defensible answer to the composition problem (pick an order, document it, enforce it).

### 3.4 `@adorn/limit` — rate and flow control

**What.** `@Debounce`, `@Throttle`, `@RateLimit` (token/leaky bucket), `@ConcurrencyLimit`, `@Queue`. The concern the deleted `queue.ts` stub pointed at (SMELL-6).

**Why a declaration.** "Never fire this more than once a second" is a temporal property of the method, not of its callers; declaring it on the method keeps every caller honest without each having to know.

**Depends on.** Ideally nothing; the algorithms are small.

**Seam/sink.** `@ConcurrencyLimit` and `@Queue` wrap `proceed` in a gate that admits at most *n* concurrently, queueing the rest; `@RateLimit` admits per a token bucket. Rejections/queue-depth are record-shaped observations.

**Prior art to learn from (verified).** [`p-limit`](https://npm-compare.com/p-limit,p-queue,p-throttle) (simple concurrency cap), [`p-queue`](https://npm-compare.com/p-limit,p-queue,p-throttle) (priority queue atop concurrency + timeouts + pause/resume), [`p-throttle`](https://npm-compare.com/p-limit,p-queue,p-throttle) (rate over an interval), and [`Bottleneck`](https://npm-compare.com/async,bottleneck,fastq,p-limit,promise-queue,queue) (reservoir refills, cluster-wide limits via Redis). Spring shows rate-limiting done as a [custom `@RateLimited` annotation + aspect](https://dev.to/jackynote/how-to-implement-rate-limiting-in-spring-boot-apis-using-aspect-oriented-programming-ehi).

**Honest note — `@Debounce`/`@Throttle` are a trap on a value-returning method.** These drop or delay calls and return stale-or-void; a method decorated with them *cannot honestly return its result to every caller*. This breaks the tacit contract that "a method call returns its answer," and it does so silently and prettily. It belongs on a fire-and-forget event handler, not on a method whose result is awaited. See §6 traps.

### 3.5 `@adorn/otel` and instrumentation — the worked exemplar

**What.** OpenTelemetry-compatible tracing/metrics, plus metrics/counters and structured audit logging.

**This is fully designed in `docs/observability-plan.md`. Do not re-derive it here.** It is the reference add-on for every point in §2: the neutral `Observation` model in core with zero third-party imports (§2.4); the around-shaped `scope` sink because a span must be active during `proceed` (§2.3); the adapter as a separate package with `@opentelemetry/api` as a peer (§2.4); deny-by-default value emission (§2.6); and — most relevantly to this document — its central finding that **contract-violation telemetry is a true projection of the existing declaration** while span/log telemetry is a *new* declaration. That split (projection vs new declaration) is the same one §4 draws for every policy, and the observability plan is where it was first worked out rigorously.

**The two extensions this document adds** to the instrumentation family, beyond the plan:
- **Metrics/counters** as declarations: `@Count`, `@Gauge`, `@Histogram` over the same observation sink, mapping to a metrics backend (a Prometheus client such as `prom-client`, or the OTel metrics API). The `adorn.contract.violations` counter the plan proposes (its §5.2) is the first of these.
- **Structured audit logging** — distinct from `@Log`. An append-only "who did what to which record" compliance trail is a *different* artifact from call-level logging, and its declaration surface (which fields are the actor, the object, the action) is new information the registry cannot derive — exactly the observability plan's "domain-event logging is not free" boundary (its §5.1).

### 3.6 `@adorn/tx` — transactions / units of work

**What.** `@Transactional` — run the method inside a transaction, commit on success, roll back on failure; nested calls enlist in the same transaction per a propagation mode.

**Why a declaration.** A declarative transaction boundary is clearer than manual begin/commit/rollback, and the boundary is enumerable.

**Honest assessment — this is a boundary case that fits the *syntax* but strains the *substrate*.** A transaction needs two things adorn does not have:
1. **An ambient context** to propagate the active transaction to nested repository calls without threading it through every signature. The mature solution is [Node's `AsyncLocalStorage`](https://nodejs.org/api/async_context.html), which propagates a store through `await`, `.then`, `setTimeout` automatically, with overhead measured *"consistently under 4% on real HTTP workloads and effectively zero when the store is empty"* — and adorn has *no* ambient-context substrate today.
2. **A resource manager** (the ORM/driver) that actually owns the connection and the transaction.

[`typeorm-transactional`](https://github.com/Aliheym/typeorm-transactional) already does this well — `@Transactional()` uses `AsyncLocalStorage` to propagate the `EntityManager`, supports propagation modes, and has *"zero performance impact when not in transaction."* adorn's realistic value-add is therefore **not** re-implementing the transaction manager; it is (a) providing the around-shaped sink so the tx-open-during-`proceed` scope composes with adorn's other decorators in a *known order* relative to retries and caches (§5), and (b) the **projection**: enumerate every `@Transactional` boundary and its propagation mode as a documentable artifact. The enforcement is the ORM's job; the *declaration and its projection* are adorn's.

### 3.7 `@adorn/flags` — feature flags and experiments

**What.** `@FeatureGate('flag')` to no-op or swap a method behind a flag; `@Experiment` to route between implementations.

**Why a declaration.** Making rollout a property of the code rather than a manual branch is genuine value, and — again — the set of gated methods is enumerable.

**Prior art — and a striking structural fit.** [OpenFeature](https://openfeature.dev/docs/reference/concepts/provider/) is a CNCF, vendor-neutral feature-flag API whose **provider** model *is the sink/adapter pattern*: application code talks only to the OpenFeature SDK, and a provider plugs a specific backend (LaunchDarkly, Unleash, ConfigCat, …) behind that standard API. That is precisely adorn's "neutral model in core, vendor adapter as a separate package" shape (§2.4). `@adorn/flags` should target the OpenFeature interface as its sink, exactly as `@adorn/otel` targets the OTel API.

**Honest assessment.** Two frictions. First, gating a *whole method* is coarse — real flag usage usually branches *inside* a method, which a decorator cannot express; the honest fit is the narrower "no-op / swap implementation" case. Second, flag evaluation needs an **evaluation context** (which user, which environment), and that is ambient — the same `AsyncLocalStorage` problem as `@adorn/tx`. So the enforcement is a partial fit; the *declaration + projection* (an inventory of every flag the code reads and where) is a clean fit.

### 3.8 `@adorn/policy` — authorization

**What.** `@Authorize(ability)` — only a principal with the stated ability may call the method.

**Why a declaration.** Guarding entry by declared policy keeps security decisions visible at the boundary rather than buried in the body.

**Prior art (verified).** [CASL](https://github.com/stalniy/casl) (isomorphic, ability-based: *what a user can do* on *which resource*), [Casbin](https://casbin.apache.org/) (policy-model based: RBAC/ABAC/custom via a policy file), and Spring's `@PreAuthorize` method security. CASL's ability model is the closest fit for an in-language decorator.

**Honest assessment — this is the clearest "needs too much ambient context" case for *enforcement*, and the strongest projection case.** Authorization needs the **principal**, which is ambient request context adorn has no notion of. `@Authorize` would have to reach into an `AsyncLocalStorage` the app populates — coupling adorn to the app's request framework — and, critically, **if that context is not set, the check fails *open*, silently.** This is not hypothetical: `docs/sensitive-flow-spike.md` §15 *measured* that `AsyncLocalStorage` survives every async hop but *"nothing opens a scope by default,"* so a decorator relying on an ambient scope fails open at every architectural boundary it wasn't wrapped at. An authorization check that silently passes when it can't find the principal is worse than no check. So: **enforcement is a poor fit; the declaration + projection is an excellent one** — enumerate every `@Authorize` and you have a complete, machine-checkable access-control matrix, which is a genuine security artifact no scattered `if (!user.isAdmin) throw` can produce. This mirrors DEC-025's boundary exactly: adorn documents and enforces *its own* declared policy surface, not the application's ambient identity plumbing.

### 3.9 `@adorn/idempotency` — exactly-once effects (self-generated)

**What.** `@Idempotent({keyFrom})` — dedupe by an idempotency key so a method invoked twice with the same key returns the first result and *suppresses the second effect*. The classic payment-API idempotency-key pattern.

**Why it's distinct from cache.** A cache is an optimisation (a hit is a bonus; a miss is fine). Idempotency is a *correctness* guarantee about side effects: the operation must run *at most once* per key, and a "miss" that runs it twice is a duplicate charge. It is also distinct from single-flight coalescing, which only dedupes *concurrent in-flight* calls — idempotency persists the key across time.

**Why it belongs as a declaration, and why it makes the ecosystem cohere.** "This operation must not run twice for the same key" is locality-of-intent. And it is the missing safety pair for `@Retry`: **retry is only safe on an idempotent method.** `@Idempotent` is how you *make* a write retry-safe, so `@adorn/resilience` and `@adorn/idempotency` compose — and the registry can then audit *"every `@Retry` method is either read-only or `@Idempotent`,"* which is the single most valuable resilience lint there is (§4). This is the coherence payoff made concrete: two independent add-ons whose declarations, read together from one registry, catch a bug neither can see alone.

**Depends on.** A key store (in-memory for a single process, or the app's KV/DB for distributed exactly-once). Rides the seam; the store is the sink-shaped dependency.

### 3.10 `@adorn/deadline` — budget propagation (self-generated, far-term)

**What.** `@Deadline`-aware methods read a *remaining-time budget* from ambient context, pass a *reduced* budget to each downstream call, and fail fast when it is exhausted — the gRPC / Go `context.Context` deadline-propagation pattern.

**Why it's distinct from `@Timeout`.** A per-call `@Timeout` is a *fixed local* limit and fixed local limits do not compose: nest three methods each with a 10s timeout inside a caller with a 5s timeout and the inner ones will happily run past the caller's deadline. A deadline *flows through* the call tree, so every level respects the *caller's* remaining budget rather than an independent local one.

**Why it belongs and why it's far-term.** It turns the scattered independent timeouts of `@adorn/resilience` into a coherent whole. But it needs an **around-shaped sink that opens an ambient deadline scope during `proceed`** — the same `AsyncLocalStorage` substrate `@adorn/tx`, `@adorn/flags`, and `@adorn/policy` all want, which adorn does not have yet. It is the strongest argument for adorn growing that substrate (§6). It pairs with the projection: enumerate every `@Timeout`/`@Deadline` on a path and you can *derive the worst-case latency the path can emit* (§4).

**Two further self-generated candidates, noted not developed:** `@adorn/batch` (DataLoader-style coalescing — turn `loadUser(id)` called 100× in a tick into one `loadUsers([...ids])`; a rate-control cousin but distinct: it *batches* rather than *limits*, per the [DataLoader](https://github.com/graphql/dataloader) pattern), and `@adorn/audit` (the append-only compliance trail noted in §3.5).

---

## 4. Do cross-cutting policies project? — the coherence-making question

This is the question `vision.md`'s north star forces and the one that decides whether the ecosystem is coherent or a grab-bag. adorn's whole premise is that a declaration is projectable: contracts enumerate from the registry into documentation, schema, tests, fuzzing. **Do resilience, cache, and rate-limit policies also project?**

**The strongest honest answer: yes — and for the documentation-and-audit projections, *more* cleanly than contracts do, because a policy is nothing but data. But they project into a *different artifact set*, and the coherence payoff is not the per-method render — it is the *cross-cutting queries over the enumerable union* that no single decorator can answer.**

Two questions are usually conflated, and separating them is the whole answer.

### 4.1 Is the policy itself enumerable? — Yes, and cleanly

A policy is identity + params with behaviour derived (§2.2). It has **no user predicate**, so the one thing that made contracts only partially projectable does not arise. `@Retry(3)` is 100% data; `@Cache({ttl})` is 100% data. Recorded in the registry (the unbuilt *concern* band, §2.2), the union of all declared policies is a snapshot:

> *"`OrderService.charge` retries 3× with exponential backoff, requires an idempotency key, and has a 2s timeout. `Catalog.search` caches for 60s (max 500 entries) and rate-limits to 10/s. `Admin.deleteUser` requires the `manage:users` ability."*

That paragraph is a document nobody writes today, that is always wrong when it exists in a wiki, and that descends **for free** from declarations the code already carries. The literal point-3 question — *"is 'what retries/caches/rate-limits does this system declare?' a documentable artifact?"* — is answered **yes**, and it is a cleaner instance of the projection idea than the contract case, not a weaker one.

### 4.2 Into *which* artifacts? — a different set from contracts

Contracts project into four artifacts about *values*. Policies project into a different set about *operational posture*. The honest mapping (in the spirit of the observability plan's projection-vs-new-declaration table):

| Projection | Value contract | Cross-cutting policy |
|---|---|---|
| **Enforcement** | check on call | wrap on call |
| **Documentation** | "must be ≥ 0" | an **operational profile** — every retry/timeout/cache/rate-limit/breaker/authz decision, per method |
| **Schema** | JSON Schema fragment | *partial* — rate limits → documented `429`/rate-limit headers; timeouts+retries → a client's latency/idempotency expectations |
| **Tests / oracle** | generator + oracle | *weaker in kind* — you cannot fuzz "does retry work" from the declaration; you *can* generate **conformance assertions** ("this method is declared `@Idempotent`, so calling it twice with one key must produce one effect") |
| **Fuzzing** | inputs to break it | mostly n/a |

So a policy does not slot into the same four columns. It produces a *fifth and sixth* artifact about operational posture:

### 4.3 The coherence payoff: cross-cutting queries over the union

The per-method render is nice but not the point. The point is that **once the policies are data in one enumerable registry, you can ask questions *across* them that no per-method annotation can answer** — which is exactly the move the observability plan makes (its "which contract fails most in production?" and its privacy-review table), generalised:

1. **Correctness audits a single decorator cannot see.** *"Every `@Retry` method is either read-only or `@Idempotent`."* Retrying a non-idempotent write is the single most dangerous resilience mistake, and it is invisible at any one call site. A registry that enumerates all `@Retry` sites and all `@Idempotent` sites can flag the intersection's *complement* — the retried, non-idempotent, effectful methods — as a lint. This is the §3.9 payoff, and it only exists because two independent add-ons write to one registry.
2. **Composition-hazard detection.** Because the registry knows a method carries *both* `@Cache` and `@Authorize`, and knows their order, it can flag the cache-outside-authz privilege-escalation hazard (§5.2) *statically*, as a lint over the registry rather than as an incident. This directly connects §4 to §5.
3. **Latency-budget derivation.** Enumerate every `@Timeout` and `@Retry` on a call path and compute the worst-case latency the path can emit (Σ timeouts × attempts) — a derived artifact ("this endpoint can take up to 27s before failing") otherwise invisible until an outage. This is what `@adorn/deadline` (§3.10) makes rigorous.
4. **Declared capacity.** Enumerate every `@RateLimit` / `@ConcurrencyLimit` for a machine-readable statement of the system's self-imposed limits, reviewable against the actual infrastructure.

This is what turns the ecosystem from a grab-bag into a *participant* in the source-of-truth goal: the value contracts and the operational policies are one enumerable declaration surface, and the queries across that surface are artifacts hand-written code structurally cannot produce.

### 4.4 The honest limits — the same walls, in the same places

Two limits, and it is a good sign that they are *exactly* the limits the core already documented — evidence the wall is real and correctly located, not a new problem:

- **Import scope (DEC-007).** The registry only sees what has been imported. An operational profile that silently omits an unimported module is the "looks complete, is not" failure DEC-016 rejects and the observability plan (its §8 risk 9) flags for its privacy table. The profile artifact inherits the same obligation: **render its own scope** — say which modules were loaded — or it manufactures false confidence.
- **Closure hooks are opaque (Q-3 / SMELL-14).** A policy's *core* is pure params, but some carry a closure: `@Retry({retryIf: err => err.code === 503})`, `@Fallback(() => cachedDefault)`. That predicate is a hand-written closure, invisible to projection exactly as `CreateSimpleDecorator` closures are invisible today (SMELL-14). The rule DEC-010 already set applies unchanged: **project the params, mark the closure as opaque, never fabricate a description of it.** `@Retry(3)` renders fully; `@Retry(3, {retryIf: fn})` renders "retries on: «custom predicate»." The add-on ecosystem hits the *same* wall in the *same* place as the core — which is the strongest evidence that the model is consistent.

---

## 5. Boundaries and composition

Async is the substrate (§5.4), ordering is a correctness question (§5.1–5.2), the contract interaction is adorn-specific and un-researched (§5.3), and the core/add-on line is drawn in §5.5.

### 5.1 Ordering when several wrap one method — a worked example

When *n* decorators wrap one method, the order they nest in is a correctness question, not taste. Every mature library says so and picks a convention:

- **cockatiel:** `wrap(retry, breaker, timeout)` = `retry.execute(() => breaker.execute(() => timeout.execute(fn)))` — **first listed is outermost** ([readme](https://github.com/connor4312/cockatiel/blob/master/readme.md)).
- **Polly v8:** *"strategies execute in the order added with the first added being outermost; a call flows inward through each strategy to your delegate, and the outcome flows back out through them in reverse"* ([Polly v8 pipelines](https://milanjovanovic.tech/blog/polly-v8-resilience-pipelines)).
- **resilience4j:** *hard-codes* `Retry(CircuitBreaker(RateLimiter(TimeLimiter(Bulkhead(Function)))))` regardless of annotation order ([getting started](https://resilience4j.readme.io/docs/getting-started-3)).

**The worked case — retry × cache.** Two orderings, and they are not equivalent:

- **cache-outside-retry** — `Cache(Retry(fn))`: check the cache; on a miss, run the retry loop; cache the *final successful* value. Subsequent calls hit the cache and the retry loop never engages. **This is almost always what you want.**
- **retry-outside-cache** — `Retry(Cache(fn))`: each retry attempt goes through the cache. If the cache stores *failures* (or the in-flight promise that then rejects), every retry attempt re-reads the *same cached failure* and the retry is silently defeated — it is retrying a cache lookup, not the operation. Even if failures are not cached, each attempt does a redundant always-missing lookup.

So retry-outside-cache is a trap that ranges from wasteful to silently-broken, and cache-outside-retry is correct. An adorn author writing `@Cache @Retry` on a method must know which one that spells — and the registry knows the order (DEC-017 normalises constraint order at record time; the same normalisation gives a projection the *policy* order), so §4.3's hazard lint can flag `retry-outside-cache` statically.

Two workable answers to "which order does a stack spell?", both defensible: **(a)** follow resilience4j and *fix* a documented canonical order (retry outermost, then breaker, then rate-limit, then timeout, then cache innermost) that annotation order cannot change; **(b)** follow cockatiel/Polly and make order *explicit and honoured*, with a registry lint for the known-dangerous orderings. (a) is safer for beginners; (b) is more honest and composes with adorn's existing "declaration order is enforcement order" principle (DEC-015). I lean (b) *plus* the lint, because a silently-reordered stack is the drift DEC-015 exists to prevent, in a new dialect.

### 5.2 The sharpest hazard I found — a cache outside a guard or an authorization check

The most dangerous composition is not within the resilience family; it is a policy composed with a *contract* or an *authz* check, and it turns a caching optimisation into a validation bypass or a privilege escalation. It is adorn-specific (adorn is the only library offering both the cache and the check), un-researched, and it fires on the *natural* ordering.

**cache outside authorization → privilege escalation.** `Cache(Authorize(fn))`, cache outermost for maximum hit rate — the obvious choice. Admin user A calls; `@Authorize` passes; the result is cached under a key derived from the *arguments*. Non-admin user B calls with the same arguments → **cache hit → the authorization check never runs → B receives A's authorized result.** Authorization must never be cached on a key that does not include the principal, and adorn's memoization keys on *arguments alone* (the entire IDEA-8 keying machinery knows nothing about an ambient principal, §3.1). So a naive `@Cache @Authorize` stack is a privilege-escalation bug *by construction*.

**cache outside a guard + a key collision → validation bypass.** Now recall the *unsolved* carried finding: BUG-11/BUG-15, where two *different* arguments can collide to one cache key (a class hiding its state behind private fields keys as empty). With a guard (`trust: 'guard'`, DEC-008) inside the cache, the first (valid) argument passes the guard and populates the key; a second, *invalid* argument that collides to the same key gets a **cache hit and its guard never runs.** A wrong cache hit is normally just a stale value; outside a guard it is *skipping the validation the guard exists to perform on untrusted input*. The BUG-11/BUG-15 collision, harmless as a memoization performance note, becomes a **security defect** the moment a cache sits outside a `guard`-trust contract.

**The rule this yields (proposal):** a cache must sit *inside* every guard and every authorization check (`Guard(Authorize(Cache(fn)))`), so the check always runs and only the underlying computation is cached — *or* the cache key must incorporate the principal and the guard outcome. And because the composition is data in the registry (§4.3), adorn can *detect* the dangerous ordering — a `@Cache` recorded outside a `guard` contract or an `@Authorize` — and refuse or warn at install time. This is DEC-016's "enforced-but-undocumented is the worse failure" logic inverted into "cached-past-a-guard is a silent bypass": the registry is the only thing positioned to see it, so the registry should be what flags it.

### 5.3 Interaction with contracts — adorn-specific, no prior art

adorn is the only library in this space that also enforces value contracts, so the contract × policy interaction is un-researched and must be reasoned from first principles.

- **Precondition before or after a retry?** A precondition is a pure function of the argument (DEC-010), so it should run **once, outside the retry** — re-checking it each attempt is wasteful and, since predicates are pure and idempotent, harmless if it does (DEC-022 already relies on that idempotence for super-call double-checking). The argument does not change between attempts, so a precondition that passed on attempt 1 cannot fail on attempt 2.
- **Precondition before or after a cache hit?** It must run **before** — i.e. the guard sits *outside* the cache — for the §5.2 reason: a cache hit that skips the guard is a bypass. This is the one place the "check once, outside" instinct is not merely an optimisation but a security requirement.
- **Postcondition inside or outside a retry?** Here the interesting composition lives. A postcondition validates the *result*. Placed **inside** each retry attempt, a postcondition *failure* can itself be a retryable signal — "retry until the result satisfies its guarantee" — which is a genuinely powerful, adorn-only pattern (the contract becomes the retry's success oracle). Placed **outside**, retry settles on some result and the postcondition checks it once. The former couples retry to the contract layer and should be opt-in, but it is the composition that most justifies adorn owning both surfaces: the postcondition is *the oracle the resilience layer retries toward*, which is `vision.md`'s "the contract supplies the oracle" reappearing in the resilience dialect.

### 5.4 Async is the substrate

Every concern here is fundamentally asynchronous, and the settling problem `@Time` already solved is the shared substrate. `@Time`'s classification — sync / thenable / observable, stopping the clock when the work *settles* rather than when the call *returns* (`src/MethodDecorators/Time.ts`) — is exactly what retry must await, what cache must key on (cache the *resolved* value, never the promise that may reject), and what timeout must race. The observability plan (its §5.5) already argues this settling logic must be *shared, not reimplemented*, so spans and timings never disagree about a duration; the same argument extends across the whole ecosystem, or a method's retry, cache, timeout, and span will disagree about when it "finished." **A shared `ResultAdapter` that classifies and settles a result is the single most reused piece of machinery the ecosystem needs, and it should live in core** (the plan calls it P1.7, still unbuilt). This is the OTel-Java `@WithSpan` insight — for a future-returning method the wrapper must not complete until the future does — generalised to every wrapper.

### 5.5 What belongs in core forever vs an add-on

The dividing line is sharp once stated:

- **Core, forever:** the substrate — the around seam (`MethodDecoratorFactory`), the reified-descriptor model (`Descriptor.ts`), the registry + enumeration (DEC-011), the sink-slot pattern, the trust/config model (DEC-008), the neutral observation model (per the plan, `Observation.ts` with zero deps), the shared settling adapter (§5.4), and the projection layer — plus the *value contracts* (validation), because those are the reason adorn exists.
- **Add-on, always:** every cross-cutting *behaviour*. DEC-019 taught that even one runtime dependency on the core load path is a regression, and `vision.md`'s own principle is that "the factory is the product; the built-in decorators are demonstrations." `@Time` and `@Log` are the *only* exception — they are core because they are pure (zero-dependency) reference demonstrations of the seam and the sink, the in-tree templates every add-on copies.
- **The test:** *if it needs a runtime dependency or ambient context, it is an add-on.* If it is pure data + the seam + a sink, it *could* be core but still should not be, unless it is part of adorn's value contract. The observation *model* is core (it is an interface, zero-cost); the OTel *adapter* is an add-on (it is a 1 MB dependency).

---

## 6. A tiered sketch

Conceptual, not a schedule. The tiers are cut by *what machinery a module needs that does not exist yet*, which is what actually gates them.

### Near tier — cheap given the seam that exists today

Pure around-behaviours over params + a sink, no ambient context, minimal or no dependencies. Each is "a small function over the seam," which is `vision.md`'s test for whether a direction is worth pursuing:

- `@Retry` + backoff, `@Timeout`, `@Fallback` (`@adorn/resilience`, the pure half).
- `@ConcurrencyLimit`, `@RateLimit` (`@adorn/limit`, the honest half — see the trap below for the dishonest half).
- `@Idempotent` (in-memory single-process).
- `@Cache` over a bounded map of its own (the TTL/LRU/SWR machinery is the mid tier).

These are the modules to build first, because they are cheap, they exercise the *concern* registry band (§2.2), and they are enough to demonstrate §4's cross-cutting audits (retry × idempotency) and §5's composition hazards.

### Mid tier — needs machinery that is small but real

- **`@CircuitBreaker`** — needs cross-call state and a reified state model (half-open/rolling-window, §3.3) to be a first-class *projectable* policy rather than an opaque boolean.
- **`@Cache` with LRU/TTL/SWR** — needs the eviction machinery (`lru-cache` or equivalent) *and* the IDEA-8 keying findings applied.
- **`@adorn/rx`** — needs `rxjs` and carries the BUG-3/9/10/11/15 findings; the core interop seams are already built.
- **`@adorn/otel`** — the whole observability plan; needs the neutral observation model landed in core first, then the adapter package.

### Far tier — needs ambient context adorn does not have

Everything that reads request-scoped state. adorn has *no* `AsyncLocalStorage`-based ambient-context substrate, and building one is the single largest capability the ecosystem is missing:

- **`@Transactional`** (`@adorn/tx`), **`@FeatureGate`** with an evaluation context (`@adorn/flags`), **`@Authorize`** with a principal (`@adorn/policy`), **`@Deadline`** propagation (`@adorn/deadline`).

For *every one of these, the projection half is near-tier and cheap* — enumerate the `@Transactional` boundaries, the flag reads, the `@Authorize` sites, the timeouts — because those are pure registry reads (§4). It is only the *enforcement* half that needs the ambient substrate. This is the same split the observability plan drew (violation telemetry is a projection, available now; span telemetry is a new declaration, later), and it is the honest way to sequence these: **ship the enumeration artifact first, the ambient enforcement later.**

### Traps and bad ideas — stated plainly

- **`@Debounce` / `@Throttle` on a value-returning method** (§3.4). They drop or delay calls and cannot honestly return a result to every caller; they read beautifully and lie about what the call does. Belongs on an event handler, not an awaited method.
- **A cache outside a guard or an authorization check** (§5.2). The *natural* ordering (cache outermost for hit rate) is a validation bypass / privilege escalation. The sharpest hazard in this document.
- **Retrying a non-idempotent method.** `@Retry` on a write is a duplicate-effect bug; retry is presented as pure upside and is not. The `@Retry`-implies-`@Idempotent` audit (§4.3) exists to catch this.
- **Authorization enforcement via a decorator that reaches into an unset ambient context** (§3.8). It *fails open, silently* — measured in `sensitive-flow-spike.md` §15 (nothing opens a scope by default). A security check that passes when it cannot find the principal is worse than no check.
- **A universal `@Resilient({retry, timeout, breaker, cache})` mega-decorator.** It collapses the composition-ordering decision (§5.1) — a correctness question — into one opaque option bag, hiding the very ordering that matters. resilience4j's *fixed, documented* order is a defensible design; an adorn mega-decorator with *unspecified* order is the trap. If a bundle decorator ships at all, it must commit to and document one canonical order, exactly as resilience4j does.

---

## 7. References

**Resilience — how it is composed elsewhere**
- [cockatiel readme](https://github.com/connor4312/cockatiel/blob/master/readme.md) — JS-native Backoff/Retry/Circuit-Breaker/Timeout/Bulkhead/Fallback; `wrap(a, b, c)` puts `a` outermost.
- [Polly v8 resilience pipelines](https://milanjovanovic.tech/blog/polly-v8-resilience-pipelines) — "first added is outermost; call flows inward, outcome flows back out in reverse." [PolicyWrap wiki](https://github.com/App-vNext/Polly/wiki/PolicyWrap) · [Polly Cache wiki](https://github.com/App-vNext/Polly/wiki/Cache) (read-through / cache-aside).
- [resilience4j getting started](https://resilience4j.readme.io/docs/getting-started-3) — the hard-coded aspect order `Retry(CircuitBreaker(RateLimiter(TimeLimiter(Bulkhead(Function)))))`.
- [opossum](https://github.com/nodeshift/opossum) · [opossum docs](https://nodeshift.dev/opossum/) — JS circuit breaker: half-open after `resetTimeout`, rolling window, fallback.

**Caching**
- [isaacs/node-lru-cache README](https://github.com/isaacs/node-lru-cache/blob/main/README.md) — `max`, `maxSize`, `ttl`, `dispose`, and `fetchMethod` for stale-while-revalidate.
- [SWR](https://swr.vercel.app/) — the stale-while-revalidate data-fetching pattern.
- [singleflight / cache stampede](https://medium.com/pickme-engineering-blog/singleflight-in-go-a-clean-solution-to-cache-stampede-02acaf5818e3) · [Redis cache stampede](https://oneuptime.com/blog/post/2026-01-21-redis-cache-stampede/view) — dogpile/thundering-herd and request coalescing.

**Rate and flow control**
- [p-limit vs p-queue vs p-throttle](https://npm-compare.com/p-limit,p-queue,p-throttle) · [Bottleneck comparison](https://npm-compare.com/async,bottleneck,fastq,p-limit,promise-queue,queue) — concurrency caps, priority queues, rate-over-interval, reservoir/Redis cluster limits.
- [Spring rate limiting via AOP annotation](https://dev.to/jackynote/how-to-implement-rate-limiting-in-spring-boot-apis-using-aspect-oriented-programming-ehi).

**Declarative-annotation precedent, and its limits**
- [Guide to Spring Retry](https://www.baeldung.com/spring-retry) — `@Retryable`, `@Cacheable`/`@CacheEvict` as annotations.
- [Spring `@Cacheable` self-invocation gotcha](https://khmousa.medium.com/caching-limitations-in-spring-why-cacheable-fails-on-internal-method-calls-33e00a101ab5) — proxy-based interception is bypassed by internal self-calls; adorn's prototype-wrapping is not.

**Ambient context**
- [Node.js AsyncLocalStorage](https://nodejs.org/api/async_context.html) — propagates a store through `await`/`.then`/timers; overhead under ~4% on HTTP workloads, ~zero when empty.
- [typeorm-transactional](https://github.com/Aliheym/typeorm-transactional) — `@Transactional` via AsyncLocalStorage, propagation modes, zero cost when not in a transaction.

**Feature flags, authorization**
- [OpenFeature providers](https://openfeature.dev/docs/reference/concepts/provider/) — CNCF vendor-neutral flag API; the provider model *is* the sink/adapter pattern.
- [CASL](https://github.com/stalniy/casl) — isomorphic ability-based authorization. [Casbin](https://casbin.apache.org/) — policy-model (RBAC/ABAC) authorization.
- [DataLoader](https://github.com/graphql/dataloader) — the batch-loading/coalescing pattern (`@adorn/batch`).

**Internal (grounding, not re-derived here)**
- `docs/vision.md` — Direction 2 (cross-cutting concerns), the raw material for this document; the North Star and Guiding Principles.
- `docs/observability-plan.md` — the fully-worked OTel add-on; the neutral `Observation` model, the around-shaped sink, adapter-as-separate-package, deny-by-default PII, projection-vs-new-declaration.
- `docs/DECISIONS.md` — DEC-010 (reify descriptors, derive predicates), DEC-011 (registry enumeration), DEC-012 (decorator-agnostic core + thin adapters), DEC-015/017 (declaration order is enforcement order), DEC-019 (the rxjs dependency-weight lesson), DEC-025 (adorn secures its own emissions).
- `docs/ISSUES.md` — IDEA-8 (`@adorn/rx` and the findings that must travel: BUG-3/9/10/11/15), SMELL-6 (the removed `queue.ts`), SMELL-14 / Q-3 (closures are opaque to projection), DEC-007 import-scope caveat.
- `docs/sensitive-flow-spike.md` §15 — the measured "nothing opens an ambient scope by default; the emitter fails open, silently" finding that governs §3.8 and the authorization trap.
- `src/Core/MethodDecoratorFactory.ts` (the around seam) · `src/MethodDecorators/Time.ts` (the sink pattern + the settling classification) · `src/Core/Descriptor.ts` (reified descriptors) · `src/Core/Configuration.ts` (trust / violation policy).
