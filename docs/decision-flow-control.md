# adorn — Decision: Flow-Control Decorators

*A direction-setting decision document for the flow-control family named in `vision.md` Direction 2 —
queue / rate-limit / throttle / debounce / retry / timeout and their resilience siblings. It decides
**which primitives adorn offers**, **whether each is core or add-on**, **how the stateful, async-shaped
behaviours compose with the contract and observation machinery already shipped**, and the
**statefulness / hazard rules** they must obey. This is a decisions-and-rationale document, not a build
plan: it exists so that the flow-control work, whenever it is scheduled, lands aligned with the vision
rather than as a grab-bag of behaviours that happen to be spelled with an `@`.*

> **Status: proposed.** No code and no tracker edits accompany this document. It proposes DEC-040…DEC-045
> and new ISSUES/IDEAs for the orchestrator to reconcile into `DECISIONS.md` / `ISSUES.md`. The
> `@adorn/*` package names are working titles.

---

## Foundation and what is already settled

This document does not re-derive the platform; it stands on shipped decisions and one prior vision:

- **The around-behaviour seam.** `MethodBehavior = (context, proceed) => result`
  (`src/Adapters/legacy/MethodDecoratorFactory.ts`) is the one sanctioned way a wrapper installs. It hands
  a behaviour an `InvocationContext` (`target`, `propertyKey`, `original`, `wrapper`, `thisArg`, a mutable
  `args`) and a `proceed` thunk it may call zero, one, or many times. Retry calls `proceed` up to *n*
  times; a rate limiter refuses to call it; a timeout races it. One shape subsumes before/after/onError.
  `proceed()` must stay **outside every `try`** the behaviour owns (the DEC-032/DEC-035 invariant).
- **The settling classifier.** `settle(operation, onSettle)` (`src/Core/settle.ts`, extracted verbatim
  from `@Time` under DEC-035) classifies a result as sync / thenable / Observable and reports **when the
  work settles**, not when the call returns. It hands back a `Settlement<T>` (`value` XOR `error`,
  discriminated on the string literal `outcome`) and preserves `@Time`'s Observable coldness (SMELL-15)
  and rxjs-absent `settled:false` refusal (SMELL-16).
- **The observation layer (O1, DEC-035/036/037).** A pluggable `ObservationSink` with a record path (fire-
  and-forget value-free events) and an around-shaped `scope` path (owns the active scope during
  `proceed`). Its event union is a **semver-frozen-but-additive** public surface: every payload field is
  optional and object-shaped so growth stays additive. `seeing ≠ emitting` (DEC-036): the `record` path
  carries only pre-disclosed data; the `scope`/`settle` path sees the raw outcome.
- **Core stays behaviour-free.** DEC-019/GAP-6 removed `rxjs` and `@Memoize`; runtime deps are `{tslib}`.
  `addon-modules-vision.md` §5.5 draws the line: *core is the substrate + the value contracts; every
  cross-cutting behaviour is an add-on; `@Time`/`@Log` are the only exceptions, as pure zero-dependency
  reference demonstrations of the seam and the sink.*
- **The prior vision.** `addon-modules-vision.md` §3.3 (`@adorn/resilience`), §3.4 (`@adorn/limit`), §5.1
  (ordering), §5.2 (the cache-outside-guard hazard) sketched this family in depth but ratified nothing.
  This document ratifies the flow-control subset of it.

Two shipped hazard findings transfer wholesale and are load-bearing below:

- **BUG-3** (MOVED → IDEA-8): `@Memoize` held state on the **prototype** — shared across every instance,
  never invalidated, ignoring arguments. The fix was a per-decoration, per-instance
  `WeakMap<instance, Map<argKey, value>>`. **Every cross-call-stateful flow-control primitive is stateful
  in exactly this way and must use exactly this storage.**
- **BUG-11 / BUG-15 / Q-22**: argument-key derivation collides for exotic containers, and a class hiding
  its state keys as empty (BUG-15, unsolved). Q-22 raises the stakes: a key collision *under a guard or
  authorization check* is not a stale value — it is a **validation bypass / privilege escalation**.

---

## Part 1 — Which primitives, and their exact semantics

The verdict column is one of **BUILD** (adorn should offer it), **REJECT** (a worse version of what the
host already has, or dishonest by construction), or **DEFER** (belongs to the family but needs machinery
adorn does not have yet).

| Primitive | Cross-call state? | Verdict | One-line reason |
|---|---|---|---|
| `@Retry` | no (per-call loop) | **BUILD** | pure, enumerable, the retry-inventory is safety-critical |
| `@Timeout` | no (per-call race) | **BUILD** | pure; the honest caveat is it cannot cancel |
| `@Fallback` | no | **BUILD** | pure; catch-and-substitute |
| `@RateLimit` | yes (bucket) | **BUILD** | temporal property of the method, not its callers |
| `@ConcurrencyLimit` (bulkhead) | yes (counter+queue) | **BUILD** | isolation; the honest half of flow control |
| `@Queue` (serialize) | yes (queue) | **BUILD** | `@ConcurrencyLimit(1)`; the deleted `queue.ts` stub (SMELL-6) |
| `@CircuitBreaker` | yes (state machine) | **BUILD** (mid-tier) | needs a reified state model to be projectable |
| `@Idempotent` | yes (key store) | **BUILD** | the safety pair that makes `@Retry` correct |
| `@Debounce` / `@Throttle` | yes | **REJECT** | dishonest on an awaited method; a worse rxjs/lodash |
| Observable (stream) flow control | — | **REJECT → `@adorn/rx`** | rxjs already has `retry`/`throttleTime`/… |
| `@Deadline` (budget propagation) | ambient | **DEFER** | needs an `AsyncLocalStorage` substrate adorn lacks |

### The BUILD set — exact semantics

**`@Retry({attempts, backoff?, retryIf?, onRetry?})`.** Runs `proceed()`; on a **settled failure** (a sync
throw, a rejection, or an Observable `error`, classified through `settle` — never a second classifier)
waits per `backoff` and re-runs, up to `attempts` total tries. `attempts` is a **required cap** — there is
no infinite default. `backoff` is `'none' | {kind:'fixed', delayMs} | {kind:'exponential', baseMs, factor?,
maxDelayMs?, jitter?}` — pure data, fully projectable. `retryIf?: (error) => boolean` is an optional hand-
written closure (opaque to projection, Q-3/SMELL-14 — projected as *"retries on: «custom predicate»"*,
never fabricated). On exhaustion the **last** error propagates untouched. Preconditions are checked once,
outside the loop (arguments do not change between attempts — DEC-022 idempotence); the postcondition is
checked on the final settled result (see Part 4 for the retry-toward-oracle opt-in). **Hazard: retrying a
non-idempotent effectful method duplicates effects** — pair with `@Idempotent`.

**`@Timeout(ms, {onTimeout?})`.** Races `proceed()`'s **settlement** (via `settle`) against `ms`; if it has
not settled, rejects with a `TimeoutError` (or returns `onTimeout(...)`). **Honest limit stated up front:
adorn cannot cancel the underlying work.** JavaScript promises are not cancellable, so the method keeps
running after the timeout fires and *may leave a mutation half-done* — the timeout bounds *how long the
caller waits*, not *how long the work runs*. A synchronous method cannot be interrupted mid-execution on a
single thread, so `@Timeout` on a sync method is a no-op and warns at install time. Future direction: thread
an `AbortSignal` through `context` for methods that accept one — noted, not decided here.

**`@Fallback(valueOrFn)`.** On a settled failure, returns a static value or `(error, ...args) => result`
(closure opaque to projection). Composes as the innermost safety net or the outermost last resort depending
on placement (Part 4).

**`@RateLimit({limit, windowMs | perSecond, burst?, onExceed?, keyFrom?, scope?})`.** A token / leaky
bucket admitting at most `limit` calls per window. On exceed: `onExceed: 'reject'` (default — a
`RateLimitError`) or `'queue'` (delay until a token frees, **bounded** — an unbounded delay queue is a
memory-leak DoS; a `maxQueue` overflow rejects). Per-instance by default (Part 3); `keyFrom` gives per-key
limits and inherits the Part 3 key hazards.

**`@ConcurrencyLimit(n, {maxQueue?, scope?})`** (bulkhead). Admits at most `n` `proceed()` calls in flight;
excess is queued FIFO up to `maxQueue`, then rejected. Isolates a slow dependency from starving the rest.

**`@Queue({concurrency?, priority?, maxQueue?, scope?})`.** Serialization: `concurrency` defaults to `1`, so
calls run one at a time in order — the common case the deleted `queue.ts` stub gestured at (SMELL-6). It is
`@ConcurrencyLimit` with `n=1` as the ergonomic default plus optional priority; implemented over the same
gate, not a second mechanism.

**`@CircuitBreaker({failureThreshold, windowMs, resetTimeoutMs, halfOpenTrials?, onStateChange?})`**
(mid-tier). A reified state machine: **closed** → **open** (after `failureThreshold` failures in `windowMs`)
→ **half-open** (after `resetTimeoutMs`, admits `halfOpenTrials` trial calls) → closed or open. While open,
rejects fast (or defers to a composed `@Fallback`). The **state model must be reified as params, not an
opaque boolean** (§3.3 of the vision), so the breaker is projectable and the state transitions are
observable (Part 4). Cross-call state (Part 3).

**`@Idempotent({keyFrom, store?, ttlMs?})`.** At-most-once **effect** per idempotency key: a second call
with the same key returns the first result and **suppresses the second effect**. Distinct from a cache (a
cache is an optimisation — a miss is fine; idempotency is a *correctness* guarantee — a miss that runs twice
is a duplicate charge) and from single-flight coalescing (which dedupes only *concurrent* in-flight calls;
idempotency persists across time via `store`, in-memory by default, pluggable for distributed exactly-once).
It is the safety pair for `@Retry`: `@Idempotent` is how you make a write retry-safe.

### The REJECT set — the "worse version of what they have" lines

**`@Debounce` / `@Throttle` — rejected as decorators on an awaited method.** They drop or delay calls and
return stale-or-void, so a method decorated with them **cannot honestly return its result to every caller**.
That breaks the tacit contract every method call carries — *a call returns its answer* — and it breaks it
silently and prettily, which is the worst way. They belong on a fire-and-forget DOM/event handler, a domain
where `rxjs` (`debounceTime`/`throttleTime`) and `lodash` already do it better and where "no return value"
is expected. Building them here would be a worse version of what the developer already has, wrapped in a
lie about what the call does. *If* a future need for a genuinely fire-and-forget (`void`-returning) mode
appears, it may be revisited as an explicitly `void`-only decorator that refuses a value-returning target at
install time — but it is not in the flow-control set this document ratifies. (Recorded as an open question,
not a plan.)

**Observable (stream) flow control — rejected in the pure add-ons; deferred to `@adorn/rx`.** Retrying,
throttling, debouncing, or rate-limiting an **Observable stream** is what `rxjs`'s operators (`retry`,
`retryWhen`, `throttleTime`, `debounceTime`, `bufferTime`, `concatMap` for queueing) exist for, and
reimplementing them over a duck-typed Observable would be the archetypal worse version. The pure add-ons
(`@adorn/resilience`, `@adorn/limit`) handle **sync and `Promise`** results natively through `settle`; when
`settle` reports an Observable and rxjs is absent it degrades to `settled:false`, and the honest response is
that **Observable flow control lives in `@adorn/rx`** (which takes rxjs as a real dependency, IDEA-8) and is
expressed with rxjs operators rather than re-derived. This is the same "a worse version of one the user
already has" line `@Time` draws for profiling frameworks.

**Distributed / cluster-wide limits — out of scope for the primitive; delegated to a sink-shaped backend or
infrastructure.** A single-process token bucket is what adorn builds. Cross-process rate limiting (Redis-
backed, service-mesh-enforced) is what Bottleneck/Envoy/Istio do; adorn's value is the *declaration and its
enumeration*, not out-competing a service mesh. A distributed backend, if ever wanted, plugs in as the
pluggable `store`/limiter behind the same declaration — the declaration does not change.

---

## Part 2 — Core or add-on (per primitive)

**Decision: the entire flow-control family is an add-on, never core.** It ships as
`@adorn/resilience` (`@Retry`, `@Timeout`, `@Fallback`, `@CircuitBreaker`), `@adorn/limit` (`@RateLimit`,
`@ConcurrencyLimit`, `@Queue`), and `@adorn/idempotency` (`@Idempotent`). `@Time` and `@Log` remain the
**only** behavioural decorators in core.

**Why add-on, when these need no heavy dependency?** The task correctly notes these *could* be core on the
dependency-weight test alone — `@Retry`/`@Timeout` are pure. The dependency-weight test is not the deciding
one. Three reasons decide it:

1. **The vision's own principle.** *"The factory is the product; the built-in decorators are
   demonstrations"* (`vision.md`). Core exists to prove the seam and hold the value contracts. Two pure
   reference demonstrations (`@Time`, `@Log`) are enough to demonstrate the seam and the sink; a third,
   fourth, and eighth do not demonstrate anything new — they just enlarge core's frozen surface and its
   semver commitments (DEC-039) for no gain.
2. **The line has to be somewhere, and "behaviours are add-ons" is the only line that does not erode.**
   `@adorn/cache`, `@adorn/tx`, `@adorn/policy` are add-ons on any reading. Splitting the family — retry in
   core because it is pure, cache in an add-on because it wants `lru-cache` — makes "is it core?" a question
   about incidental dependency weight rather than about what a thing *is*. Every "why is `@Retry` core but
   `@RateLimit` not?" conversation is one adorn should never have. `addon-modules-vision.md` §5.5 already
   drew this line; this decision ratifies it for the flow-control subset.
3. **Statefulness is a different lifecycle from the contract core.** Most of the family holds cross-call,
   per-instance mutable state (buckets, counters, queues, breaker state, key stores). Core's contract
   enforcement is, by contrast, stateless per call — a check reads the registry and returns. Housing a
   fleet of stateful behaviours inside the module whose thesis is *stateless declarative enforcement*
   muddies exactly the thing that makes core easy to reason about (and to strip in production, DEC-008).

**The per-call vs cross-call distinction still matters — but for statefulness, not for the core line.**
`@Retry`/`@Timeout`/`@Fallback` hold no state between invocations; `@RateLimit`/`@ConcurrencyLimit`/
`@Queue`/`@CircuitBreaker`/`@Idempotent` do. That distinction governs Part 3 (which primitives need the
WeakMap discipline), not Part 2 — all of them are add-ons regardless.

**What must land in core to enable the add-ons.** An add-on is only an *adorn* add-on if its policy is
registry-visible data (so it projects and so the composition lint of Part 4 can see it). That needs the
**`concern` registry band** — the `categories` axis DEC-008 deliberately left unbuilt *"because nothing
needed it yet."* A flow-control ecosystem is what needs it (DEC-045). Everything else the add-ons need is
already core and shipped: the around seam, `settle`, the `ObservationSink`, the sink-slot pattern, and the
trust/config model. Those seams **must not be removed as dead code** — `settle` and `isObservableLike` are
the interop the add-ons ride (as IDEA-8 already records for `@adorn/rx`).

---

## Part 3 — Statefulness and the hazard rules

**Decision: every cross-call-stateful primitive holds its state per-instance in a
`WeakMap<receiver, State>`, never on the prototype and never in a plain module-level variable keyed by
nothing.** This is BUG-3's storage design, transferred unchanged. A `@RateLimit` on `Service.fetch` limits
*per `Service` instance* by default, because the decorator installs once on the prototype and its closure is
shared across every instance — the identical trap `@Memoize` fell into (shared cache, never invalidated).
The `WeakMap` is keyed on `this` (the receiver), so each instance gets its own bucket / counter / queue /
breaker / key store, and ephemeron semantics mean the state is collected with the instance.

- **`scope: 'instance' | 'shared'`, default `'instance'`.** Per-instance is the safe default (isolation, no
  cross-instance interference, no leak). `'shared'` is the deliberate opt-in for a limit that protects a
  *shared downstream* — one bucket for every instance of a client that all hit the same rate-limited API.
  Shared state lives in the decorator closure (module scope), which is the one legitimate use of it, chosen
  explicitly rather than defaulted into.
- **Static methods** key on the constructor (`this` is the constructor). **Detached calls**
  (`thisArg === undefined`) fall back to a single shared state slot for that decoration — stated, because
  silently creating a fresh bucket per detached call would make the limit vanish.
- **`resetRegistry()` / test isolation** (SMELL-18): stateful decorators must expose a reset hook for tests,
  since their WeakMap state outlives a single test otherwise. This is add-on API, not core.

**Argument-keyed primitives inherit the cache-key findings whole.** `@RateLimit({keyFrom})`,
`@Idempotent({keyFrom})`, and any per-key gate derive a key from arguments and therefore inherit
BUG-11/BUG-15: exotic containers (`Map`, `Set`, typed arrays) must be keyed **explicitly**; anything else
exotic falls back to **identity** (a miss costs performance, a wrong hit costs correctness, and the two do
not trade); a user class hiding its state keys as empty and **collides** (BUG-15, unsolved — carried, not
re-solved). The keying machinery is recoverable from `@Memoize`'s history (IDEA-8) rather than rewritten.

**Q-22 is the reason this is a security decision, not a performance note.** A key collision under a
memoization is a stale value; **the same collision under a guard or an authorization check is a validation
bypass or a privilege escalation** — a second, invalid or differently-authorized argument that collides to
the same key skips the check the key was supposed to gate. This bounds Part 4's ordering rules: an
argument-keyed gate must never sit *outside* the check it could let a collision skip.

---

## Part 4 — Composition with contracts and observation

A rate-limited / queued / retried method is still a contracted, observable method. The flow-control wrap and
the contract wrap are **separate `MethodBehavior`s composed in an order**, and both fire. This part decides
that order, the contract-interaction rules, the hazard detection, and the observation emission.

### 4.1 Ordering: explicit and honoured, first-listed outermost

**Decision: composition order is explicit and honoured — the top-most decorator is outermost, the one
closest to the method is innermost** — matching cockatiel/Polly (*"first added is outermost"*) and, more
importantly, adorn's own DEC-015 (*declaration order is enforcement order*; source top-to-bottom =
outer-to-inner). `__decorate` applies method decorators bottom-up, so the decorator nearest the method wraps
first (innermost) and the top-most wraps last (outermost); this is the intuitive reading and it is pinned.

adorn **rejects resilience4j's hidden fixed order** (`Retry(CircuitBreaker(RateLimiter(TimeLimiter(...))))`
regardless of annotation order). A silently-reordered stack is exactly the drift DEC-015 exists to prevent,
in a new dialect: the author writes one nesting and gets another, with no way to see it. Honouring the
written order — plus a lint for the known-dangerous ones (§4.3) — keeps the composition honest and
consistent with everything else in the library. A `@Resilient({...})` mega-decorator that hides the ordering
inside one option bag is rejected for the same reason (it collapses a correctness decision into a config
key).

### 4.2 The enforcement weave and flow control — safe by construction under class-level `@Contract`

The interaction with contracts falls out of *how* enforcement installs, and the result is fortunate:

- Flow-control decorators are **method** decorators — they wrap the original during member decoration.
- `@Contract()` is a **class** decorator — its enforcement weave installs *after* all member decoration
  (`installMethodWrapper`), so it wraps the already-flow-wrapped method. **The enforcement weave therefore
  ends up outermost.**

This gives the safe answers by construction, with no author effort:

- **Precondition / guard runs once, outside the flow-control wrap.** Arguments do not change between retry
  attempts (DEC-022 idempotence), so checking once is correct and cheap; and because the guard is outside
  any cache/dedup, **a cache/dedup hit can never skip the guard** — the Q-22 privilege-escalation / bypass
  is closed *by construction* for the class-level form.
- **Invalid input is rejected before consuming a rate/concurrency token** — the guard is outermost, so a
  throwing guard means the gate is never entered.
- **Postcondition checks the final settled result, once** — the weave runs postconditions after `proceed()`
  returns the post-retry, post-fallback value.

**The asymmetry that must be stated (mirrors DEC-032).** With **per-method `@Validate()` + method-decorator
flow control**, both are member decorators and their order is **source-order-sensitive** — the author *can*
put a flow-control decorator outside the guard and reintroduce the Q-22 hazard. So, exactly as DEC-032 found
for `@Validate()`+`@Ensures()`: **class-level `@Contract()` is the order-safe form; the per-method form is
order-sensitive and is where the §4.3 lint earns its keep.** This is documented guidance plus a lint, not a
new mechanism.

- **Postcondition as the retry oracle — a deferred opt-in.** The enforcement-outermost default checks the
  postcondition *after* retries settle, so a failing postcondition does **not** trigger a retry. The
  powerful adorn-only pattern *"retry until the result satisfies its guarantee"* (the contract as the
  retry's success oracle — `vision.md`'s "the contract supplies the oracle" in the resilience dialect)
  requires the postcondition *inside* the retry loop, which is the opposite nesting. It is deferred as an
  explicit opt-in (`@Retry({retryUntil})` or a documented per-method composition), not the default.

### 4.3 Dangerous compositions: detect them, because the composition is data

Because a policy is reified in the `concern` band (DEC-045) and the registry knows the order (DEC-017),
adorn is uniquely positioned to **detect** dangerous compositions that no single decorator can see. This is
`addon-modules-vision.md` §4.3/§5.2 turned into a decision.

**Decision: dangerous compositions are surfaced as a registry-level composition-hazard lint, report-only by
default (consistent with the sensitive-flow detector, DEC-028), with an opt-in strict mode that refuses at
install time for the security-class hazards.** The catalogue:

| Hazard | Detectable from the registry? | Response |
|---|---|---|
| **Cache/dedup outside a `guard` contract or `@Authorize`** (Q-22) — key collision → validation bypass / privilege escalation | **Yes** (order + trust band are data) | **Refuse in strict mode; warn by default.** The security-class case. |
| **`@Retry` on a non-read-only, non-`@Idempotent` method** — duplicate effects | **Partly** — cannot infer idempotency; can flag `@Retry` lacking `@Idempotent` on a method that is not marked read-only | **Warn** ("`@Retry` here is unsafe unless the method is idempotent — add `@Idempotent` or confirm read-only"). The single most valuable resilience lint (§4.3). |
| **`@Debounce`/`@Throttle` on a value-returning method** | **Yes** where return type metadata exists; otherwise on the decorator's presence | Moot — REJECTED in Part 1; the lint is the backstop if a third-party ships one. |
| **`retry-outside-cache`** — each attempt re-reads a cached failure, silently defeating the retry (§5.1) | **Yes** (order) | **Warn.** |
| **Fixed local `@Timeout`s that do not compose** (nested timeouts exceeding an outer one) | **Yes** on a call path, needs the deferred `@Deadline` analysis | Noted for `@Deadline` (DEFER). |
| **`@Timeout` leaving a mutation half-done** | **No** (cannot know a method mutates) | **Document only** — the honest limit stated in Part 1. |

The undetectable hazards are documented, never silently "handled." Report-only-by-default is the consistent
adorn stance (DEC-028); strict refusal is reserved for the by-construction security bypass, where proceeding
silently is the DEC-016 "enforced-but-undocumented is the worse failure" logic inverted into "cached-past-a-
guard is a silent bypass."

### 4.4 Observation: a dropped / throttled / retried / queued call is a telemetry event

**Decision: flow-control behaviours emit value-free observation events through the core `ObservationSink`,
and adorn extends the O1 event union with a first-class `{kind:'flow'}` event** (additive — DEC-035's union
is frozen-but-additive, so a new all-optional/object-shaped kind is a permitted growth, not a break). A
`{kind:'flow'}` event carries the **concern identity** (`retry`/`rateLimit`/`circuitBreaker`/…), a
**phase** (`attempt`/`exhausted`/`rejected`/`dropped`/`coalesced`/`enqueued`/`opened`/`half-open`/`closed`/
`timeout`), and **value-free facts** (attempt number, `delayMs`, `queueDepth`, `limit`, `remaining`,
breaker state). It is value-free *by construction* — a rejected/retried/queued call is a control event, not
a value emission — so it is not disclosure-gated (DEC-036: this is `record`-path telemetry, and the
`record` path carries only pre-disclosed data).

Rationale and rules:

- **The event union (vocabulary) is core; the emitters are add-ons.** Add-ons import the core `Observation`
  types and call `getObservationSink().record({kind:'flow', …})`. This is the one core-surface addition to
  reconcile; the alternative (add-ons emit `{kind:'message'}` with stringly-typed attributes) is rejected
  because it makes flow events unqueryable, and the whole point (§4.3 audits, capacity/latency projections)
  is that they are structured data.
- **Contracts still enforce and still emit.** The flow-control wrap does not replace the enforcement weave;
  under the §4.2 nesting the method still runs its precondition/postcondition and still emits O1
  `completed`/`violation` events. A retried call emits `flow:attempt` per attempt *and* a single
  `completed` when it finally settles.
- **Settling is reused, never re-classified (DEC-006/DEC-035).** Retry awaits the settled value; timeout
  races the settled value; cache/idempotency store the settled value; the breaker counts settled failures —
  all through `settle`. There is exactly one duration and one outcome classification in the system, so a
  method's retry, timeout, span, and timing can never disagree about when it "finished." This is the
  `ResultAdapter` the vision (§5.4) called the most-reused piece of machinery — already shipped as `settle`.
- **A sink that throws is contained** (as `@Time` and O1b already do); observation must never become the
  method's failure.

### 4.5 The projection payoff (why this is on-thesis, not a bolt-on)

Because policies are enumerable data in one registry, the flow-control family participates in the single-
source-of-truth goal rather than sitting beside it. The cross-cutting queries no per-call-site code can
answer become derivable artifacts (`addon-modules-vision.md` §4.3): *"every `@Retry` method is read-only or
`@Idempotent`"* (the §4.3 lint), *"this endpoint can take up to Σ(timeout × attempts) before failing"*
(latency-budget derivation), *"the system's self-imposed rate/concurrency limits"* (declared capacity), and
the composition-hazard scan itself. These inherit the two honest limits the core already documents unchanged
— **import scope** (DEC-007: the profile must render its own scope) and **opaque closures** (Q-3/SMELL-14:
`retryIf`/`onExceed` closures project as *"«custom predicate»"*, never fabricated).

---

## Recommended DECISIONS (for the orchestrator to reconcile)

- **DEC-040 — Flow-control decorators are an add-on family, never core.** The family ships as
  `@adorn/resilience`, `@adorn/limit`, `@adorn/idempotency`; `@Time`/`@Log` remain core's only behavioural
  decorators. Decided on the "behaviours are add-ons" line and statefulness, **not** dependency weight
  (Part 2). Ratifies `addon-modules-vision.md` §5.5 for this subset.
- **DEC-041 — The flow-control primitive set, semantics, and the build/reject/defer lines.** BUILD `@Retry`,
  `@Timeout`, `@Fallback`, `@RateLimit`, `@ConcurrencyLimit`, `@Queue`, `@CircuitBreaker`, `@Idempotent`
  with the Part 1 semantics; REJECT `@Debounce`/`@Throttle` as awaited-method decorators (dishonest by
  construction) and REJECT stream flow control (defer to `@adorn/rx`/rxjs); DEFER `@Deadline` (needs ambient
  context). Distributed limits delegate to a pluggable backend, not the primitive.
- **DEC-042 — Cross-call state is per-instance via `WeakMap<receiver, State>` (the BUG-3 rule), with
  `scope:'instance'|'shared'` defaulting to `'instance'`.** Argument-keyed gates inherit the
  BUG-11/BUG-15 keying rules; Q-22 makes a key collision under a guard/authz a security bypass, which bounds
  the Part 4 ordering.
- **DEC-043 — Composition order is explicit and honoured (top-most outermost, per DEC-015), and dangerous
  compositions are detected as a registry-level lint** — report-only by default (per DEC-028), opt-in strict
  install-time refusal for the security-class cache/dedup-outside-guard/authz hazard (Q-22). Rejects
  resilience4j-style hidden reordering and the opaque `@Resilient` mega-decorator.
- **DEC-044 — The contract weave composes safely with flow control by construction under class-level
  `@Contract()`** (enforcement is outermost: precondition once outside retry, guard outside cache/dedup,
  postcondition on the final result). The per-method `@Validate()` form is order-sensitive (mirrors
  DEC-032). Retry-toward-postcondition-oracle is a deferred opt-in.
- **DEC-045 — The registry gains a `concern` band** (realizing DEC-008's deliberately-deferred `categories`
  axis): a policy is reified as identity + JSON-serialisable params with behaviour derived (DEC-010), making
  it enumerable for projection and the DEC-043 lint. Built when the first flow-control add-on lands, not
  speculatively. Flow-control emits a value-free `{kind:'flow'}` O1 event (additive to the DEC-035 union),
  and all settling reuses `settle` (DEC-006) — no second classifier.

## Recommended new ISSUES / IDEAs / open questions

- **IDEA-14 — `@adorn/resilience`** (`@Retry`, `@Timeout`, `@Fallback`, `@CircuitBreaker`). Near-tier for
  the pure three; `@CircuitBreaker` is mid-tier (reified state model). Prior art: cockatiel, opossum, Polly,
  resilience4j.
- **IDEA-15 — `@adorn/limit`** (`@RateLimit`, `@ConcurrencyLimit`, `@Queue`). Near-tier; single-process
  first. Prior art: p-limit, p-queue, Bottleneck. Absorbs the intent of the deleted `queue.ts` (SMELL-6).
- **IDEA-16 — `@adorn/idempotency`** (`@Idempotent`). The safety pair for `@Retry`; the
  `@Retry`-implies-`@Idempotent` audit is its coherence payoff.
- **IDEA-17 — The composition-hazard lint / operational-profile projection.** A registry read over the
  `concern` band producing the §4.3 audits and §4.5 profiles; ships via `adorn check`/a projection, report-
  only (DEC-028 shape). Depends on DEC-045's concern band.
- **Q-25 — Does adorn grow an `AsyncLocalStorage` ambient-context substrate?** Required for `@Deadline`
  budget propagation and for any per-principal scope; measured to fail open silently when a scope is not set
  (`sensitive-flow-spike.md` §15). The single largest capability the far-tier of the ecosystem is missing.
- **Q-26 — Build the `concern` registry band speculatively or on first add-on?** DEC-045 leans "on first
  add-on"; the risk is premature abstraction (the DEC-010 concern) versus retrofitting several add-ons.
- **Q-27 — The retry-toward-postcondition-oracle composition.** Is it worth the inverted nesting, and what
  is its authoring surface (`@Retry({retryUntil})` vs a documented per-method composition)? Deferred in
  DEC-044.
- **Q-28 — A fire-and-forget (`void`-only) `@Debounce`/`@Throttle`?** Rejected for awaited methods
  (DEC-041); reconsider only as a `void`-returning decorator that refuses a value-returning target at
  install time, if a real need appears.
- **Q-29 — `@Timeout` cancellation via `AbortSignal`.** Threading a signal through `context` for methods
  that accept one, to bound *work* and not merely *waiting* — the honest fix for the half-done-mutation
  hazard.

---

## Summary

**Primitive set (BUILD):** `@Retry`, `@Timeout`, `@Fallback`, `@RateLimit`, `@ConcurrencyLimit`, `@Queue`,
`@CircuitBreaker`, `@Idempotent`. **REJECT:** `@Debounce`/`@Throttle` on awaited methods (dishonest — they
cannot return a result to every caller) and Observable/stream flow control (a worse rxjs — defer to
`@adorn/rx`). **DEFER:** `@Deadline` (needs an ambient-context substrate adorn lacks).

**Core vs add-on:** the whole family is **add-on** (`@adorn/resilience` / `@adorn/limit` /
`@adorn/idempotency`), decided on the "behaviours are add-ons / the factory is the product" line and on
statefulness — not dependency weight, even though these are light. `@Time`/`@Log` stay the only core
behaviours. The one core change the add-ons need is the reified **`concern` registry band** (DEC-008's
deferred axis).

**Key hazard/composition rules:** cross-call state is per-instance via `WeakMap` (BUG-3), `scope:'shared'`
opt-in; argument keys inherit BUG-11/BUG-15, and under a guard a collision is a security bypass (Q-22);
composition order is explicit-and-honoured (top-most outermost, DEC-015), with class-level `@Contract()`
making guard-before-flow-control and postcondition-on-final-result **safe by construction** (the per-method
`@Validate()` form is order-sensitive, mirroring DEC-032); dangerous orderings are a report-only registry
lint with strict refusal reserved for cache/dedup-outside-guard (Q-22); a dropped/throttled/retried/queued
call is a value-free `{kind:'flow'}` O1 event; all settling reuses `settle` — never a second classifier
(DEC-006).

**Recommended DECs:** DEC-040 (family is add-on), DEC-041 (primitive set + semantics), DEC-042 (per-instance
`WeakMap` state + key hazards), DEC-043 (composition order + hazard lint), DEC-044 (contract-weave
composition, safe under class `@Contract`), DEC-045 (`concern` registry band + value-free flow observation +
`settle` reuse). Plus IDEA-14/15/16/17 and Q-25…Q-29.
