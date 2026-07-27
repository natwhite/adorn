# adorn — Deciding the Add-on Ecosystem Shape

*A decisioning document, 2026-07-26. It ratifies the **shape** of the peer-dependency add-on ecosystem
sketched in `addon-modules-vision.md` (DEC-019's "heavy deps never in core"): the priority order of the
first three add-ons, each one's core/add-on boundary, the peer-dep/isolation contract, the extraction
contract (what Core must expose), and — the centrepiece — the **Q-22 composition-hazard detector**.*

> **Status: decisions + rationale, not a build plan.** No code accompanies this. It proposes
> `DEC-040`…`DEC-045` and new tracker items (§8) for the orchestrator to reconcile into
> `docs/DECISIONS.md` / `docs/ISSUES.md`. The `@adorn/*` names remain working titles.
>
> **Foundation read.** This sits on top of `addon-modules-vision.md` (the architecture and catalogue),
> the O1 observation build (DEC-035/036/037), the frozen registry surface (DEC-039), the add-on coupling
> gap (DEC-034 / GAP-11), the `@adorn/test` isolation template (`addons/test/isolation.test.ts`,
> IDEA-3/4), and IDEA-8's carried memoization findings. It **references** those; it does not re-derive them.

---

## 1. The decision this document makes

The vision catalogued ~12 candidate add-ons and tiered them by "what machinery a module needs that does
not exist yet." This document commits to the **first three** the orchestrator named — `@adorn/otel`,
`@adorn/rx`, `@adorn/cache` — and decides their order, boundaries, and the safety mechanism that is
adorn-specific and worth designing in from the start.

The organising finding is that **the three differ enormously in readiness against seams that already
exist**, and readiness — not headline value — should set the order:

| Add-on | New public core surface it needs | New core *machinery* it needs | Carries a known-unsolved hazard? |
|---|---|---|---|
| `@adorn/otel` | **none** — the entire O1 seam is already public & frozen | none | no |
| `@adorn/rx` | one small decision (`setObservableConstructor`, SMELL-16) | none (the `settle` Observable branch exists) | **yes** — BUG-15 keying, unsolved |
| `@adorn/cache` | a concern-recording seam + a composition read | **the concern registry band** (DEC-008's unbuilt `categories` axis) + the Q-22 detector | **yes** — inherits BUG-11/BUG-15, and *elevates them to a security defect* (Q-22) |

That table is the whole argument for §2's order.

---

## 2. DEC-040 — Priority: `@adorn/otel` → `@adorn/rx` → `@adorn/cache`

**Decision.** Build them in that order. The ordering is by **readiness against existing seams and by
risk introduced**, not by how much end-user value each promises.

**`@adorn/otel` first — it is the natural O1 follow-on and needs nothing new.**
- The O1 layer was *designed as its landing pad.* `settle.ts` states outright that "the O2 adapter ends
  its span using this exported `settle`", and `Observation.ts` spells the sink's `scope` as
  `tracer.startActiveSpan(name, {...}, () => proceed())`. The seam is not merely available; it was
  shaped for this consumer.
- **Zero new public surface.** Verified against `index.ts`: `setObservationSink`/`getObservationSink`,
  `settle`, `Settlement`/`SettleKind`, `ObservationSink`, `ObservationEvent`, `ViolationFacts`,
  `EmittedValue`, `ErrorFacts`, `ObservationCall`, `Observation`, `SpanKind`, `RETURN_INDEX` and
  `consoleObservationSink` are **all already exported and semver-frozen** (DEC-035/DEC-039). `@adorn/otel`
  is a *mapping layer over a frozen public API* — the cheapest of the three and the only one with no core
  prerequisite at all.
- **It de-risks the whole ecosystem's packaging story.** It is the first real external consumer of the
  frozen event union (proving Q-6's freeze is actually sufficient) and the first to exercise the
  peer-dependency isolation contract (§6) against a genuine ~1 MB SDK. Learn the packaging lessons on the
  add-on that carries the least other risk.
- It introduces **no new correctness hazard**: it is pure projection of a settled seam.

**`@adorn/rx` second — recover deleted functionality against a seam that already exists, but it costs a
heavy dep and one unsolved bug.**
- The interop seams are *already built and must not be deleted as dead code* (IDEA-8): `settle`'s
  Observable branch (the guarded lazy `require('rxjs')`, the `settled:false` honest refusal — SMELL-16)
  and the `isObservableLike` duck-type (the `instanceof`-then-duck-type order, BUG-5). So the hard part
  is done.
- But it brings `rxjs` back as a real dependency, and it re-introduces **BUG-15 as live, unsolved work**
  (§4). It recovers capability rather than adding net-new capability, so it ranks below the zero-cost
  otel and above the heaviest cache.

**`@adorn/cache` last — the richest capability, and by far the most new machinery and risk.**
- It needs a core capability that **does not exist**: the *concern* registry band (DEC-008 deliberately
  left the `categories` axis unbuilt "because nothing needed it yet" — this is what needs it). Without a
  place to record `cache` as registry data, neither the policy projection (vision §4) nor the Q-22
  detector (§5) is possible.
- It re-derives the cache-keying problem — it is "the larger sibling of `@Memoize`" — so it should be
  built **after** `@adorn/rx` establishes the shared keying machinery (BUG-11/BUG-15) once, not twice.
- It is where the sharpest hazard in the whole vision lives (Q-22), and designing that in is a
  prerequisite, not a follow-up.

**Consequence.** The order is also the order of rising extraction difficulty (§7): otel needs no new
public symbol, rx needs one, cache needs a whole new band plus a blessed writer path. Building
easiest-first means each add-on's packaging lessons inform the next.

---

## 3. DEC-041 — `@adorn/otel`: map the O1 model onto OTel, end spans via `settle`, honour "seeing ≠ emitting"

**Boundary.** Core owns the neutral model (already shipped, `Observation.ts` + `settle.ts`, zero
third-party specifiers). The add-on owns the OpenTelemetry binding and declares `@opentelemetry/api` as a
**peer** (§6). No `@opentelemetry/*` specifier ever enters core — `Observation.ts` documents this as the
whole point of the layer, and GAP-6 "cannot recur because its precondition is never created."

**The mapping.** `@adorn/otel` is an `ObservationSink` with both surfaces, installed via
`setObservationSink`:

- **`scope(call, proceed)` → an active span.** Implement as
  `tracer.startActiveSpan(call.observation.name, {kind: mapKind(call.observation.kind)}, span => …)` so the
  span is the active context while the body runs and nested decorated methods / auto-instrumented I/O
  parent under it. **The span is ended at *settlement*, using the exported `settle` — never a
  reimplementation of the sync/thenable/observable classification.** This is the concrete mechanism that
  prevents the "flat, early-ended spans" failure (an `async` method returns a promise in ~0 ms; ending
  the span there is worse than no span). Reusing `settle` is also what guarantees the span duration and
  `@Time`'s duration and the `completed` event's `durationMs` are *one number from one classifier* and
  cannot drift (DEC-006). `Settlement<T>`'s `outcome:'threw'` branch is what feeds `span.recordException`
  on every failing outcome (the Q-24/F2 gap the arity fix closed).
- **`record(event)` → span events, metrics, exceptions.** `{kind:'completed'}` → span status + a
  latency/throughput metric keyed on `observation.name` and `outcome`; `{kind:'violation'}` → a
  `span.recordException` / a `adorn.contract.violations` counter dimensioned by `ViolationFacts`
  (`constraint`, `kind`, `trust`, `blame` — all groupable for a reified constraint, `_OTHER` for an
  `@Ensures` closure, exactly as the facts degrade); `{kind:'message'}` → a span event / log record.

**The disclosure contract it must honour (DEC-036 "seeing ≠ emitting").** This is the load-bearing rule
and the adapter is where it is most tempting to break:
- Span **attributes come only from pre-disclosed data** — `Observation` (structural, value-free) and
  `ObservationCall.values` / the `record` events' `EmittedValue[]`, each of which is already
  `[REDACTED]` unless `setValueDisclosure('all')` / an explicit `@Telemetry` opt-in (and never when
  `@Sensitive` vetoes). The adapter must **never** lift a raw argument or return value onto a span.
- The **`scope` path *sees* the raw outcome** (through its own `settle`) because ending a span and reading
  return-derived timing needs the real outcome — but *seeing is not emitting*. The raw value/error from
  `Settlement<T>` may drive control flow (status, exception recording) but must not become a disclosed
  attribute except through the disclosed channel. `ErrorFacts.message` is already redacted-by-default at
  the source (BUG-19), so `recordException` on it is safe; a user-thrown error's message is
  developer-authored and out of adorn's boundary (DEC-025).

**Reconciliation to verify (not a new decision).** A `@Contract()`+`@Observe()` method already reconciles
the double-`completed` emit at install time (`ownsCompletion`, DEC-035/037). The adapter inherits that
resolved behaviour; the add-on's tests should pin "one span, one completed, violation still emitted" as
DEC-037 pins it in-core, so the seam is confirmed sufficient from the *consumer* side.

**Consequence.** `@adorn/otel` validates the vision's §2.3 claim (a sink has a record shape and an
around shape and a real add-on needs both) end-to-end, and proves the O1 freeze was adequate — or
surfaces the first additive growth of the event union, which is exactly the pressure DEC-039 designed the
all-optional/object-shaped payloads to absorb.

---

## 4. DEC-042 — `@adorn/rx`: reintroduce `@Memoize` + Observable handling, carrying the findings verbatim

**Boundary.** The add-on takes `rxjs` as a real dependency (it can — it is opt-in). Core keeps its two
interop seams (`settle`'s Observable branch, `isObservableLike`), which are **not dead code** and must
not be removed (IDEA-8). The add-on owns `@Memoize`, Observable-returning `@Time` support, and the
flow-control decorators the deleted `queue.ts` gestured at (SMELL-6).

**It owns the SMELL-16 public-API decision.** `setObservableConstructor()` — injecting the `Observable`
constructor rather than resolving a static `require('rxjs')` specifier a bundler flags — is a public-API
question that has been *waiting for its module*. It is decided **here, in `@adorn/rx`**, because this is
the package that supplies rxjs and therefore the package entitled to define how core is handed it.

**The findings that MUST travel — carried verbatim from IDEA-8 as ratified design constraints, not to be
re-derived.** The deleted implementation is recoverable at `src/MethodDecorators/promise/Memoize.ts` in
git history; reading it is cheaper than rediscovering these:

1. **BUG-9 — the replay operator.** Use `shareReplay({bufferSize: Infinity, refCount: false})`. **Not**
   `publishReplay()` + `refCount()`, which re-executes a non-completing source while replaying the stale
   buffer. The wrong pairing is what every tutorial reaches for and *looks* correct because completing
   sources (the intended HTTP case) never expose it.
2. **The cost of `refCount:false`, accepted deliberately.** The source subscription is never torn down
   for a non-completing source, so an endless stream leaks for the cache entry's life. Ship it *stated*,
   not discovered — it is the price of "run this once."
3. **BUG-10 — memoized failures become retryable** as a *consequence* of BUG-9's fix (`shareReplay`
   discards its subject on error), not by separate design; concurrent failures are not de-duplicated.
   Reverting the operator silently reverts this.
4. **BUG-3 — storage is a per-decoration, per-instance `WeakMap<instance, Map<argKey, value>>`**, never a
   prototype-level cache (which is shared, never invalidated, and ignores args — wrong three ways). The
   `WeakMap` ephemeron semantics are what make a value closing over its own instance not a leak.
5. **BUG-11 — cache-key handling for exotic containers is explicit.** `Map`, `Set`, typed arrays,
   `DataView`, `ArrayBuffer` are described explicitly; anything else exotic (detected via
   `Object.prototype.toString`) falls back to **identity**. Governing principle: *a miss costs
   performance, a wrong hit costs correctness, and the two do not trade.*
6. **BUG-15 — arrives UNSOLVED, as live work.** A class hiding all state behind private fields / closures
   / prototype getters reports no own enumerable keys, keys as empty, and collides across instances. It
   is unfixed because both general remedies are worse than the bug: identity-keying every instance
   destroys the structural hit memoization exists for, and walking prototype getters runs arbitrary user
   code during key construction. **This is not a `@adorn/rx` defect to fix — it is a documented floor —
   and it is exactly the finding Q-22 (§5) escalates from a performance note to a security defect the
   moment such a cache sits outside a guard.**
7. **BUG-5 — `instanceof` first, then duck-type on `subscribe`** (and `pipe`). `instanceof` alone fails
   across realms with a second rxjs copy; duck-typing alone accepts non-pipeable things.
8. **Cold-safety, above all.** Nothing may be subscribed at decoration or call time. Eager subscription
   to cache a value duplicates side effects and breaks cold Observables — the single most likely
   correctness bug in this whole area.
9. **Deliberately NOT provided by `@Memoize`:** invalidation, TTL, size limits. A correctness-only
   decorator is unbounded in distinct arg-keys per instance, known and accepted — a real caching
   vocabulary is `@adorn/cache`'s job (§5), which is the right place for it.

**Test-fidelity note (IDEA-8).** `Time.test.ts` currently exercises the Observable branch against a
hand-rolled `MockObservable` via a virtual jest mock. When `@adorn/rx` lands and brings real rxjs, those
tests must be re-run against the real thing.

**Consequence.** `@adorn/rx` is the proof that the "findings travel" discipline works: an entire hard-won
design is *recovered* rather than *rediscovered*. It also builds the shared keying machinery (5, 6) that
`@adorn/cache` reuses — which is why it precedes cache.

---

## 5. DEC-043 — `@adorn/cache`, and the Q-22 composition-hazard detector

**Boundary.** The add-on owns the caching vocabulary the vision names — argument-aware keys, TTL, size
bounds (optionally `lru-cache`, else a bounded map of its own), invalidation/`@CacheEvict`,
per-instance vs shared scope, stale-while-revalidate, single-flight coalescing. It caches the **settled**
value (`settle`, never the promise that may reject). Cache events (hit/miss/evict/refresh) are
record-shaped observations through the O1 sink. It **reuses `@adorn/rx`'s keying machinery** (BUG-11/15)
rather than re-deriving it.

**The prerequisite: the concern registry band (a new core capability).** `@adorn/cache` must record its
policy as registry data — identity `cache` + JSON-serialisable params — so the policy is enumerable
alongside value contracts (vision §2.2, §4) *and* so the detector below has something to read. This is
DEC-008's deliberately-unbuilt `categories`/`concern` axis. It is built as part of this add-on's landing,
because this add-on is the first thing that needs it. Recording goes through a **blessed concern-writing
seam** (§7), never a raw registry writer (DEC-039 keeps writers internal), so the band inherits the same
declaration-order normalisation (DEC-017) that lets a projection and the detector read composition order
faithfully.

### The Q-22 detector — the adorn-specific safety worth designing in

**The hazard, precisely.** A cache placed *outside* a guard or an authorization check turns a caching
optimisation into a security defect, and it fires on the *natural* ordering (cache outermost for hit-rate):
- **cache outside `@Authorize` → privilege escalation.** `Cache(Authorize(fn))`: admin A calls, the check
  passes, the result caches under an **argument-derived** key (adorn keys on arguments alone — the whole
  keying machinery knows nothing of an ambient principal). Non-admin B calls with the same arguments →
  **cache hit → the check never runs → B receives A's authorized result.**
- **cache outside a `guard` contract + a key collision → validation bypass.** With BUG-11/BUG-15's
  unsolved collision (§4.6), an invalid argument colliding to a valid one's key gets a cache hit and its
  `guard`-trust check (DEC-008) never runs — the collision, harmless as a memoization note, becomes the
  *skipping of validation on untrusted input.*

**Why adorn can detect it and nobody else can.** adorn is the only library offering *both* the cache and
the check in one composition, and **composition is registry data**: once the cache concern is recorded in
the concern band (above), the registry knows a method carries a `cache` concern *and* a `guard`-trust
contract (or a future `@Authorize` concern) *and their order* (DEC-017 normalises order at record time).
The dangerous ordering is therefore a **static, registry-level lint**, not an incident.

**The detector, in one design.** At **install time** — deferred one microtask so the full composition is
known, exactly as DEC-014's diagnostic is (member decorators run before the class decorator, so the stack
is not yet complete at cache-decoration time) — the installer inspects, for each method carrying a
`cache` concern, the ordered union of that method's concerns and contracts, and flags the case where the
cache is **outside** (outermost of / earlier in enforcement order than):
- any `guard`-trust precondition on the method (detectable **today** — `guard` trust exists, DEC-008), or
- any `@Authorize` concern (dormant until `@adorn/policy` lands — the rule is written now so the
  capability grows in, not bolted on).

It reads *"a cache concern is recorded outside a guard-trust check,"* never *"the `@Cache` decorator was
written outside `@Authorize`"* — decorator-agnostic (DEC-012), so both the legacy and a future stage-3
adapter, and every projection, see the same hazard.

**Disposition — refuse by default, with a narrow, explicit escape.** Because the defect is *by
construction* and fires on the *natural* ordering, a warn-only default would be routinely ignored, so the
default is to **refuse at install time (throw)**, in the spirit of DEC-016's "enforced-but-undocumented is
the worse failure" inverted into "cached-past-a-guard is a silent bypass." The escape hatch mirrors
DEC-008's `disableGuardEnforcement({confirm, reason})` shape — an *explicit acknowledgement*, or a
**principal-aware key declaration** (`@Cache({keyIncludes: 'principal'})` or equivalent) that tells the
detector the cache is safe because the key incorporates the principal and the guard outcome. The safe
composition the detector steers toward is `Guard(Authorize(Cache(fn)))` — the check always runs, only the
underlying computation is cached.

**This is one instance of a general capability (vision §4.3).** The same "composition is data" move lets
the registry answer cross-cutting audits no single decorator can — *"every `@Retry` is read-only or
`@Idempotent`"*, worst-case latency-budget derivation, declared-capacity inventory. The Q-22 detector is
the first and sharpest; building the concern band pays for all of them.

---

## 6. DEC-044 — The peer-dependency / isolation contract (generalising DEC-019)

**Decision.** Every heavy runtime lives in the add-on package that declares it, **never as a specifier on
the core load path** (DEC-019 / GAP-6 — the only category with a zero failure rate is *no specifier in
core at all*). Per add-on:
- `@adorn/otel` — `@opentelemetry/api` as a **peer**. The peer (not ordinary-dep) choice is load-bearing
  for a specific reason: the OTel global-singleton version check degrades to a silent no-op on a
  duplicated copy. Copy the *reasoning*, don't cargo-cult the choice.
- `@adorn/rx` — `rxjs` as a **real dependency** (it can be, being opt-in), plus the `setObservableConstructor`
  injection seam (§4) so core still names no rxjs specifier a bundler can resolve (SMELL-16).
- `@adorn/cache` — `lru-cache` **optional** (else a bounded map of its own); the dependency lives in the
  add-on either way.

**Each add-on ships an isolation test mirroring `addons/test/isolation.test.ts`.** That template is the
ratified shape and each add-on gets its own copy of it, asserting: the heavy dep is imported by **no file
under `src/` and not `index.ts`**; the built `dist/` contains **no `require("<dep>")`**; and **no
add-on-shaped export leaks through the root `index`** (the substring guard, not a magic count — core
exports grow legitimately). This is DEC-019's rxjs lesson and GAP-4's CI step, applied per add-on, made
executable.

---

## 7. DEC-045 — The extraction contract: what Core must expose for an add-on to become a real package

Today the add-ons reach into `src/Core/*`; that is fine **in-repo** but blocks publication (DEC-034 /
GAP-11). This decision states, per add-on, exactly what must become public — and confirms the read/write
boundary DEC-039 froze is respected.

- **`@adorn/otel` — needs nothing new.** Its entire seam (`setObservationSink`, `settle`, `Settlement`,
  the event/observation union) is already exported and frozen (§2, verified in `index.ts`). It is the
  proof that the O1 surface was designed extractable from day one, and the reason it is first.
- **`@adorn/rx` — needs one public symbol:** the `setObservableConstructor` injection seam (SMELL-16),
  decided in DEC-042. The `settle` Observable branch and `isObservableLike` behaviour it relies on are
  already core-internal and reachable through `settle` (public).
- **`@adorn/cache` — needs the most:** (a) the new **concern registry band**, with a **blessed
  concern-recording seam** (a public factory that installs the around-behaviour *and* records the concern
  descriptor in one call, mirroring how `@Contract` installs + enumerates) — **not** a raw registry
  writer, because DEC-039 keeps writers internal permanently to stop a caller bypassing the adapter that
  owns ordering; and (b) a **composition read** over the concern+contract union for the detector, which
  is a new *read* and therefore joins DEC-039's frozen public read surface.
- **`@adorn/test` (already extant) sets the precedent and the warning:** it reaches into `Descriptor`,
  `ContractRegistry`, `redaction`, `Configuration` internals (DEC-034). Extracting *any* add-on as a real
  package needs either those internals made public (a DEC-039 surface decision) or a deep-import /
  `exports`-subpath strategy. **Rule going forward:** an add-on may consume the frozen public read surface
  and the blessed behaviour/concern/sink seams; if it finds itself reaching for a writer or a `*Keys`
  helper, that is a signal a new *blessed seam* is owed, not a licence to deep-import.

**Each add-on also owns an isolation test (§6) and a layering posture:** the concern's *model* (its
descriptor / sink usage) stays decorator-agnostic and Core-adjacent (DEC-012/DEC-038), while the
*decorator* that authors it lives adapter-side — so a projection can read "what does this system cache /
retry / authorize?" without dragging in a decorator toolchain.

---

## 8. Recommended DECISIONS + new tracker items (for the orchestrator to reconcile)

### Proposed decision entries (next free number is DEC-040; highest current is DEC-039)

| Entry | Title / records |
|---|---|
| **DEC-040** | **Add-on priority: `@adorn/otel` → `@adorn/rx` → `@adorn/cache`.** Ordered by readiness against existing seams and risk introduced, not headline value (§2). |
| **DEC-041** | **`@adorn/otel` maps the O1 model onto OpenTelemetry, ends spans via the exported `settle` (never a reimplementation), and honours "seeing ≠ emitting" (DEC-036).** `@opentelemetry/api` peer; zero new core surface (§3). |
| **DEC-042** | **`@adorn/rx` reintroduces `@Memoize` + Observable handling, carrying BUG-3/5/9/10/11/15 + cold-safety verbatim as design constraints; owns the SMELL-16 `setObservableConstructor()` public-API decision.** rxjs a real add-on dep; BUG-15 lands unsolved and documented (§4). |
| **DEC-043** | **`@adorn/cache` records its policy in a new concern registry band, and adorn detects the Q-22 composition hazard at install time.** Cache-outside-a-guard/`@Authorize` is refused by default (explicit-acknowledgement / principal-keyed escape); the guard rule is live today, the `@Authorize` rule dormant until `@adorn/policy` (§5). |
| **DEC-044** | **The peer-dep/isolation contract: heavy deps live in the add-on (peer or real dep), never a core specifier; each add-on ships an isolation test mirroring `addons/test/isolation.test.ts`.** Generalises DEC-019/GAP-4 (§6). |
| **DEC-045** | **The extraction contract: add-ons consume the frozen public read surface + blessed behaviour/concern/sink seams; writers stay internal (DEC-039).** Names per-add-on what must become public — otel: nothing; rx: `setObservableConstructor`; cache: the concern band + a blessed concern-recording seam + a composition read (§7). |

### New / updated ISSUES + IDEAs

- **New GAP — the concern registry band is unbuilt and gates the projectable-policy story.** DEC-008's
  `categories` axis. Blocks `@adorn/cache`, the Q-22 detector, and every vision §4 cross-cutting audit.
  It is the single largest *new core* capability the near-tier ecosystem needs. (Distinct from the
  far-tier `AsyncLocalStorage` ambient-context substrate, which `@adorn/tx`/`policy`/`deadline` need and
  which is out of scope for these three.)
- **New Q — the Q-22 detector's escape-hatch shape.** Refuse-by-default is decided (DEC-043); the exact
  acknowledgement API and the `@Cache({keyIncludes:'principal'})` declaration are open. Record so the
  security default is not weakened silently.
- **New IDEA — `@adorn/policy` (`@Authorize`) is the second half of Q-22.** The detector's `@Authorize`
  rule is written in DEC-043 but dormant until this lands; the vision's honest assessment (§3.8 —
  *enforcement* needs an ambient principal and fails open when unset, so it is far-tier; the *declaration
  + projection* is near-tier) carries over unchanged.
- **Update Q-22 → status "ADDRESSED IN DESIGN (DEC-043)".** No longer merely "recorded for the future" —
  the detector is designed; the build is scheduled with `@adorn/cache`.
- **Update IDEA-8 → sequenced as `@adorn/rx`, priority #2 (DEC-040/DEC-042).** The SMELL-16 decision is
  now assigned to it; the BUG-3/5/9/10/11/15 findings are ratified as its design constraints; note the
  keying machinery (BUG-11/15) is built here and **shared** with `@adorn/cache`.
- **Cross-reference for GAP-11/DEC-034.** The extraction blockers now have a per-add-on shape (DEC-045);
  otel is extractable today, cache needs the new blessed seams.

---

## 9. What this document deliberately does not decide

- **The far-tier add-ons** (`@adorn/tx`, `@adorn/flags`, `@adorn/policy`, `@adorn/deadline`, resilience,
  limit, idempotency) beyond noting `@adorn/policy`'s role in Q-22. Their gating capability is the ambient
  `AsyncLocalStorage` substrate adorn does not have — a separate, larger decision (vision §6 far tier).
- **The canonical composition order for the resilience family** (vision §5.1's (a) fixed-order vs (b)
  explicit-and-linted). Only the *cache × guard/authz* ordering is a security question and only that is
  decided here (§5); the resilience-internal ordering waits for `@adorn/resilience`.
- **Publication mechanics** (npm release, versioning). DEC-039 deliberately froze the *surface* without
  committing to a release process; DEC-045 states what must be *public*, not when it ships.
