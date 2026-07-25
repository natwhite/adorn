# adorn — Next Build Phase Plan

*Produced 2026-07-25. One cohesive implementation plan covering three work items: Fuzzing Phase B, the reified `@Returns(<descriptor>)` postcondition tier, and Observability O1. This is a build plan handed to implementers — it changes no code, and it reconciles the three earlier single-feature plans (`fuzzing-foundation.md`, `postconditions-plan-*.md`, `observability-o1-plan.md`) now that all three are in view at once.*

> **Status:** implementation plan. It does not re-argue settled design — DEC-006/010/012/019/021/022/025/030/031/032 and the O1 revision (Q-24) are cited, not re-derived. It states exact files, functions, registry bands, projections, tests, edge cases, the consolidated `index.ts` export delta, and the tracker updates each phase needs.

---

## 0. Orientation

Three work items, and the relationships that set their order:

1. **Fuzzing Phase B — the full oracle** (`addons/test/`). Upgrade Phase A's weak invariant oracle so the fuzz driver consumes the **real** contract oracle — `getEffectivePostconditions` + `evaluatePostconditions`, the exact functions the runtime wrapper runs (DEC-032, no drift) — plus the reified descriptor `post` band that item 2 adds. Entirely inside the `@adorn/test` add-on; fast-check never enters core/dist.

2. **Reified `@Returns(<descriptor>)` tier + return-value-schema projection** (core). DEC-032's recommended next step. `@Ensures` records a closure into `postconditionsByTarget` (opaque, unprojectable); `@Returns(descriptor)` puts a **`ConstraintDescriptor` into the reserved `MethodContract.post` slot** — the slot DEC-032 kept reserved for exactly this — so the return value is (a) checked by the same descriptor-`predicate` machinery preconditions use and (b) projectable: `src/Projections/schema.ts` emits a return-value schema (the OpenAPI-response half) and `docs.ts` renders a Returns section.

3. **Observability O1** (core). Build per the adversary-hardened `docs/observability-o1-plan.md`, honouring its `Revision (Q-24)` resolution (the per-call payload channel — permission *and* payload). A neutral, zero-dependency observation model + around-shaped sink; structured, value-free violation telemetry from reified constraints; the `@Telemetry` per-parameter disclosure band; `@Observe`; `@Log`/`@Time` rebased onto a shared `settle`; and the "what leaves the process" privacy projection.

**Independence and the soft dependency.** Item 1 and item 3 are independent of everything. Item 1 is **buildable today** against the shipped oracle (closure band) even without item 2. Item 2 **enriches** item 1 — a reified `@Returns` postcondition is *data*, so the fuzzer's scope report can name what it checked ("verified `result` ≥ 0") instead of only "oracle passed" (foundation §5.2 pt 3), and a reified violation carries groupable telemetry facts item 3 can emit while a closure cannot. Item 2 also settles the `post`-band *shape* before the fuzzer authors an oracle over it — the DEC-010/DEC-006 scheduling lesson (settle the shape, then author).

**Recommended order (rationale in §7): Item 2 → Item 1 → Item 3**, with Item 3 runnable concurrently by a second implementer since it touches an orthogonal surface. Building item 2 first means the fuzzer's oracle is written **once** to consume both postcondition bands, rather than built against closures and retrofitted.

---

## Item 2 (build first) — Reified `@Returns(<descriptor>)` + return-value schema

### Goal
A **projectable** postcondition tier. `@Returns(GreaterThan(0))` asserts the (settled) return value satisfies a reified `ConstraintDescriptor`, checked by `descriptor.predicate(result)` — the same predicate enforcement runs, derived from params (DEC-010) — and projected into a JSON-Schema return fragment and a docs "Returns" row. It coexists with `@Ensures`: `@Returns` is the *single-value, projectable* subset (the return in isolation); `@Ensures` remains the *n-ary, opaque* superset (return related to inputs).

### Files to add / change (repo-relative)

- **`src/MethodDecorators/Returns.ts`** *(new)* — the decorator. Structurally a sibling of `Ensures.ts`: it **records, does not install** (installation stays the job of `@Contract()`/`@Validate()`, DEC-016). Signature `Returns(descriptor: ConstraintDescriptor, description?: string): MethodDecorator`.
  - Validates: `descriptor` must be a `ConstraintDescriptor` (`typeof descriptor.predicate === 'function'`), else `TypeError` — mirroring `recordParameterConstraint`'s bare-predicate rejection. Applied to a method (`typeof descriptor.value === 'function'` on the property descriptor), else `TypeError`.
  - Calls `recordReturnConstraint(target, propertyKey, descriptor, 'prepend')` — `'prepend'` for the same reason `@Ensures` prepends: method decorators stack bottom-up under `__decorate`, so prepending yields declaration order (DEC-015/DEC-017).
  - Calls `notePendingContract(target, propertyKey)` (the same missing-`@Contract()` diagnostic hook `@Ensures` uses).
  - Returns the descriptor untouched (recording only).

- **`src/Core/ContractRegistry.ts`** *(edit)* — the writer for the reserved band, plus a convenience read.
  - `recordReturnConstraint(target, key, constraint: ConstraintDescriptor, position?: ConstraintPosition)` — writes to `MethodContract.post` (the reserved `ConstraintDescriptor[]` slot, `MutableMethodContract.post`). Rejects bare predicates exactly as `recordParameterConstraint` does. This is the first writer the `post` slot has ever had (Q-11 reserved it; DEC-032 kept it reserved for this tier).
  - `getEffectiveReturnConstraints(target, key): ReadonlyArray<ConstraintDescriptor>` — thin wrapper over the `post` union `getEffectiveContract` already computes base-most-first (registry lines ~477–483 already concatenate `post`). Not exported from root `index.ts` (like `getEffectiveContractKeys`, it is installer/projection plumbing; projections read `getEffectiveContract().post`). Its purpose is to give the installer and the fuzzer one call, and to key the install decision on *has-return-constraints*.
  - **No band-enumeration change needed:** `recordReturnConstraint` goes through `methodEntry`, so a `@Returns`-only method gets a `contractsByTarget` entry and `getEffectiveContractKeys` already enumerates it → `installOn` already collects the key. Confirm with a test.

- **`src/Core/ContractInstaller.ts`** *(edit)* — thread the descriptor `post` band through the weave.
  - `installMethod` (line ~280) and `Validate` (line ~176): read `getEffectiveReturnConstraints(host, key)` alongside `getEffectivePostconditions`. The "nothing recorded" guard becomes `if (!enforce && posts.length === 0 && returns.length === 0) return;` (both places — `installMethod` line ~294 and `Validate` line ~182).
  - `enforcementBehavior` (line ~333): accept a new `returns: ReadonlyArray<ConstraintDescriptor>` parameter. After `proceed()` and inside the same settling branch as closures, check the return descriptors on the settled value. Reuse the existing `isThenable` await path — both bands are checked against the same settled value; a rejected Promise skips both; a throw skips both. Add `checkReturnConstraints(returns, result, calleeSite)` next to `checkPostconditions`.
  - **`checkReturnConstraints`** *(new internal)*: for each descriptor, `if (!descriptor.predicate(result))` build a message via `descriptor.message({value: result, paramName: 'return value', disclose: shouldDiscloseValue(false)})` (a return cannot be `@Sensitive` — Q-23 — so disclosure follows the global switch alone, exactly what `postconditionMessage` does) and route through `applyViolationPolicy(new Error(message), calleeSite)`. First-failure-wins, same as `evaluatePostconditions`.
  - **Cross-band ordering (decide and pin):** check the **reified `post` descriptor band first, then the `@Ensures` closure band.** Rationale: the reified violation is more precise and projectable, and produces the groupable telemetry item 3 wants; making it first means the *most structured* broken guarantee is reported first. Pin it with a test where both fail. Both bands share the one `POSTCONDITION_TRUST = 'assert'` gate and the one `calleeSite` (blame `'callee'`) — no new trust machinery.

- **`src/Projections/schema.ts`** *(edit)* — the return-value schema (OpenAPI-response half).
  - In `methodSchema` (line ~250), after building `prefixItems`, add a `returns` key: `mergeFragments(schemaFragmentsOf(entry.contract.post))`, emitted only when `entry.contract.post` is non-empty. Result shape: `{title, type:'array', prefixItems:[…], returns:{…}}`. `returns` is an annotation keyword a tuple-validator ignores, exactly as `methods`/`staticMethods` are (module header's under-claim discipline preserved: a descriptor with no `schema()` hook contributes `{}`; conjunction merge is unchanged).
  - Add `'returns'` to `KEY_ORDER` (after `prefixItems`) so canonical output is diff-stable.

- **`src/Projections/docs.ts`** *(edit)* — render the return contract.
  - `MethodDoc.post` already exists and is already populated from `entry.contract.post` (line ~275, `toConstraintDoc`) — it was carried-but-unrendered pending exactly this writer. Add a `renderReturns` block inside `renderMethod` (after the parameter table): a small table `| Return | Constraint | Expectation |` driven by `method.post`, emitted only when `method.post.length > 0`. No model change needed — the model was built forward-compatible (docs.ts header, `MethodDoc.post`).

### Registry band touched
`MethodContract.post` (the reserved `ConstraintDescriptor[]` slot) — its first writer. **Not** `postconditionsByTarget` (that stays the closure band). The two bands are deliberately parallel — see the Gaps section on the two-band consumption rule.

### Projection touched
`schema.ts` (adds `returns`) and `docs.ts` (adds a Returns table). The arbitraries bridge is *not* touched by item 2 (a `@Returns` descriptor carries an `arbitrary()` hook, but that generates the return, which is meaningless for an oracle — the fuzzer *checks* it, §Item 1).

### New tests
- `src/MethodDecorators/Returns.test.ts` *(new)* — records a descriptor into `post`; rejects a bare predicate; rejects a non-method target; declaration-order via `'prepend'`; fires `notePendingContract` when `@Contract()` is absent.
- `test/returns-enforcement.test.ts` *(new)* — sync pass/fail; async (awaits settled value, rejects with the return violation on failure); throw skips; inheritance conjunction (subclass `@Returns` conjoins with base, base-most-first — free via `getEffectiveContract().post`); `@Returns` + `@Ensures` on one method (reified checked first, pinned); trust default `assert` (stripped under production mode, guard preconditions survive — mirror `enforcementBehavior`'s existing gate test).
- `src/Projections/schema.test.ts` *(extend)* — a method with `@Returns(GreaterThan(0))` emits `returns:{type:'number', exclusiveMinimum:0}`; under-claim preserved (a return descriptor with no `schema()` hook → `returns:{}`); conjunction of stacked `@Returns`.
- `src/Projections/docs.test.ts` *(extend)* — the Returns table renders `describe()` output; absent when no `@Returns`.
- `src/Projections/schema.imports.test.ts` / `docs.imports.test.ts` — unchanged (still Core-only; DEC-012 holds).

### Edge cases
- **async/throw/rejection/Observable:** reuse `enforcementBehavior`'s existing `isThenable` settling — descriptor checks run on the settled value; rejection and throw skip (async twin of sync-throw); Observables are checked as the raw value (rxjs gone, DEC-019) — identical to the closure band, so no new settling logic.
- **redaction:** return-value violation messages redact by default (DEC-030) — `disclose` resolved from the global switch only (Q-23). Reuse `Descriptor.message`.
- **inheritance conjunction:** free — `getEffectiveContract().post` already unions covariantly (strengthen-only, orthodox Meyer — the DEC-021/032 mechanism).
- **`@Validate()` order hazard:** identical to `@Ensures` — `@Returns` must sit *below* `@Validate()` (member decorators interleave by source order); class-level `@Contract()` is the order-safe form. Document and pin, reusing the DEC-032 note.
- **expressiveness limit (state plainly):** `@Returns` cannot relate the return to inputs (a `ConstraintDescriptor` is single-value). "result is greater than the `amount` argument" stays `@Ensures`. This is the projectable/opaque split, not a defect.

---

## Item 1 (build second) — Fuzzing Phase B: the full oracle

### Goal
Replace Phase A's weak invariant oracle with one that consumes the **real** contract oracle. The driver generates precondition-valid inputs (Phase A's sound generation, unchanged), runs the method, and asks the actual guarantee: *did the postconditions hold?* — via `evaluatePostconditions` (closure band) **and** `descriptor.predicate` (the reified `post` band item 2 adds). The shared `evaluatePostconditions` call is the no-drift guarantee: the oracle checked is byte-for-byte the oracle enforced (DEC-032). Entirely inside `@adorn/test`; fast-check stays out of core/dist (`addons/test/isolation.test.ts`).

### Files to change (repo-relative)
- **`addons/test/oracle.ts`** *(edit)* — the core of Phase B.
  - Imports (all from core, already reachable via `../../src/Core/...`): add `getEffectivePostconditions`, `getEffectiveContract` (for `.post`) from `ContractRegistry`, and `evaluatePostconditions`, `PostconditionResult` from `Postconditions`.
  - `OracleMode` gains `'postcondition'` (Phase A comment already anticipates this). `FindingType` gains `'postcondition-violation'`.
  - `FuzzOptions` gains `oracle?: OracleMode` — default **auto**: `'postcondition'` when the method has any effective postcondition (closure band non-empty OR `getEffectiveContract().post` non-empty), else `'weak-invariant'`. Auto keeps Phase A behaviour for methods with no oracle, and upgrades automatically once a postcondition exists.
  - `invoke` must **return the result** (currently `void`). `oracleOutcome` captures it.
  - `oracleOutcome` gains a postcondition stage after the clean-run field-invariant stage: evaluate the closure band (`evaluatePostconditions(posts, result, args)`) then the reified band (`for (const d of returns) if (!d.predicate(result)) …`). A `{ok:false}` or a failing descriptor → `{type:'postcondition-violation', message, postconditionDescription?}`. A postcondition that **throws** is a failure, not a method error — `evaluatePostconditions` already encodes this (`error` field); surface it as a postcondition-violation whose message names the thrown value, so a buggy oracle is not mistaken for the bug it hunts (foundation §5.2 pt 1).
  - **Layering, not replacement:** postcondition mode is weak-mode *plus* the oracle. A throw is still an `unexpected-throw` finding (robustness); field invariants are still re-checked; postconditions are checked only on a non-throwing run — matching enforcement, where a throw skips postconditions.
  - `FuzzFinding` gains optional `postconditionDescription?: string` (the reified descriptor's `describe()` or the closure's `description`) so the report names the broken guarantee.
  - `FuzzResult` gains `oraclesChecked: ReadonlyArray<string>` (the postcondition descriptions/identities the run exercised) — the honest "what I checked" the scope report needs (foundation §5.2 pt 3). Reified `@Returns` populate this with `constraint`+`describe()`; `@Ensures` closures populate it with their `description` or `'(anonymous closure postcondition)'`.

- **`addons/test/oracle.ts` — async oracle** *(edit / new export)*: enforcement awaits settled values; the fuzzer must too. `fc.check(fc.property(...))` is synchronous. Add an async path: when the method returns a thenable, use `fc.asyncProperty` + `await fc.check(...)`. Expose `fuzzMethodAsync(options): Promise<FuzzResult>` (and `fuzzClassAsync`) for async methods; keep `fuzzMethod` sync. Auto-detect on the first sample is unreliable, so make it explicit: `fuzzMethod` throws-as-declined with a clear message if it observes a thenable return ("method is async — use `fuzzMethodAsync`"), never silently checking a Promise object as a value (the "number that looks like an answer" hazard `@Time`/DEC-032 guard against).

- **`addons/test/report.ts`** *(edit)* — report the postcondition oracle.
  - The header/banner switches from "weak invariant oracle — Phase A" to name the oracle per result (`result.oracle`): "postcondition oracle" vs "weak-invariant". A postcondition-mode clean run must say *which* postconditions it checked (`oraclesChecked`), or a green result over-claims (the report's whole reason to exist — foundation §8, DEC-028 pt 3): "clean — N cases, postconditions {≥0, sorted} held". A weak-mode run keeps saying "no crash and no field-invariant break — NOT correctness".
  - `describeStrategy` / coverage block unchanged. Add a finding branch for `postcondition-violation` printing `postconditionDescription`.
  - **Counterexample redaction (decide and pin):** the counterexample args are *generated by adorn's own generator*, and reproduction is impossible without them, so they are **disclosed by default in the fuzz report** — this is the one adorn emission where the value is the deliverable, and it is a local, opt-in dev tool (foundation §7, DEC-025 boundary: adorn secures its *emissions*; a fuzz report the developer explicitly requested and reads locally is the developer's own output surface). BUT: the postcondition **violation message** built inside enforcement still redacts the return value by default (DEC-030) — so if the fuzzer surfaces the enforcement message it will read `[REDACTED]`. Phase B builds its own finding message from the counterexample rather than the enforcement string, so the input is visible; the returned value follows `getValueDisclosure()`. See the Gaps section for the `@Sensitive`-parameter-in-a-counterexample open question.

- **`addons/test/index.ts`** *(edit)* — export the new async entry points and any new types (`fuzzMethodAsync`, `fuzzClassAsync`; the widened `OracleMode`/`FindingType`/`FuzzOptions`/`FuzzResult`/`FuzzFinding` are already exported as types).

### Registry band(s) touched
Read-only: `postconditionsByTarget` (via `getEffectivePostconditions`) and `MethodContract.post` (via `getEffectiveContract().post`). No writes. The fuzzer never installs — it reads the same effective (inheritance-unioned) reads enforcement plans from.

### Projection touched
None in core. The fuzz "projection" is the add-on's own `report.ts`. (Fuzzing is the fourth projection but lives in `@adorn/test`, DEC-019/foundation §6.2.)

### New tests
- `addons/test/oracle.postcondition.test.ts` *(new)* — a method with `@Ensures((r,x)=>r>=x)` that a generated input violates → a `postcondition-violation` finding with the shrunk counterexample and seed; a correct method → clean with `oraclesChecked` populated; a throwing postcondition → reported as a postcondition-violation, not swallowed; inheritance (subclass strengthens, the conjoined base+sub oracle checked); reified `@Returns` violation found and named.
- `addons/test/oracle.async.test.ts` *(new)* — `fuzzMethodAsync` awaits and checks the resolved value; a rejected Promise on a valid input → an `unexpected-throw`-style finding (the async twin), never a false postcondition pass; `fuzzMethod` on an async method declines with the "use fuzzMethodAsync" reason.
- `addons/test/oracle.test.ts` *(extend)* — auto mode picks `'postcondition'` when a postcondition exists, `'weak-invariant'` when not.
- `addons/test/isolation.test.ts` *(extend)* — still zero `fast-check` in `dist`, runtime deps `{tslib}`, **root `index.ts` export count unchanged by Phase B** (the add-on adds nothing to the runtime surface).
- `addons/test/report.test.ts` *(extend)* — postcondition-mode banner names the oracle and the checked postconditions; counterexample input visible.
- **The no-drift integration pin** — assert the fuzzer flags a postcondition-violation *exactly when* the enforcement wrapper does, on the same `(method, args)` (the DEC-032 "one oracle, two callers" property, now made executable from the fuzzer side).

### Edge cases
- **async / rejection:** `fuzzMethodAsync` + `fc.asyncProperty`; rejection skips postconditions and is a robustness finding, mirroring enforcement.
- **throw:** still an `unexpected-throw` finding; postconditions checked only on non-throwing runs.
- **Observable returns:** checked as the raw value (rxjs gone), same as enforcement — but a stream postcondition is rarely meaningful; the report should note "postcondition checked against the raw Observable" so a green result is not over-read.
- **redaction of counterexamples:** input disclosed (reproduction need); returned value follows `getValueDisclosure()`. Open question flagged for `@Sensitive` parameters.
- **inheritance conjunction:** free — `getEffectivePostconditions` and `getEffectiveContract().post` both union base-most-first.
- **side effects:** unchanged from Phase A — the loud `STANDING_WARNINGS` about running the real method thousands of times still ships (foundation §7.2, DEC-025).
- **the honest oracle-throw convention:** a throwing postcondition is a finding, not a masked method error (foundation §5.2 pt 1) — already handled by `evaluatePostconditions`.

---

## Item 3 (concurrent / build last) — Observability O1

### Goal
Structured logging and contract-violation telemetry on a neutral, pluggable, **zero-third-party-dependency** observation layer that ends exactly where OpenTelemetry begins. Build per `docs/observability-o1-plan.md`, honouring its **`Revision (Q-24)`** in full: the per-call payload channel (values and errors have a home on the event union; `settle` hands back value XOR error; span kind is declarable), disclosure-gated on the `record` path and outcome-passing on the `scope` path — the "seeing ≠ emitting" principle (§R0). What O1 actually builds, as concrete steps:

### The four sub-phases (the O1 plan's §10 sequencing, made concrete)

**O1a — model + sink + shared `settle` (foundation; blocks on nothing).**
- **`src/Core/Observation.ts`** *(new)* — interfaces + `NOOP_SINK` + `setObservationSink`/`getObservationSink`. Zero third-party imports; imports only `Descriptor` types. Contains the **revised (Q-24)** shapes: `Observation` (incl. `kind: SpanKind`, default `'internal'`), `ObservedParameter`, `ParameterDisclosure`, `Attributes`/`AttributeValue`, `ObservationDetail`, `ViolationFacts`, `LogLevel`, `ObservationEvent` (with the new optional `values?: EmittedValue[]`, `error?: ErrorFacts`, `attributes?` on `completed`/`violation`/`message`), `EmittedValue`, `ErrorFacts`, `ObservationCall`, `SpanKind`, `RETURN_INDEX`, `ObservationSink` (`scope?<T>(call: ObservationCall, proceed) : T` + `record?(event)`).
- **`src/Core/settle.ts`** *(new)* — extract `@Time`'s settling classifier verbatim, exported as `settle<T>(result, onSettle: (s: Settlement<T>) => void): T` with the **corrected single object-shaped callback** (`Settlement<T>` = `{outcome:'returned', value}` XOR `{outcome:'threw', error}`, plus `durationMs`/`kind`/`settled`). This arity is a **precondition of O1a** (Q-24/R1) — extracting the old value-and-error-less arity would bake the F2 defect into the foundation. The `Settlement<T>` union is discriminated on the *string* literal `outcome`, which narrows under `strict:false` (unlike the boolean-discriminant case DEC-032 hit), so it can be a real discriminated union.
- **`src/MethodDecorators/Time.ts`** *(edit)* — rebase onto `settle`; `setTimingSink`, console output, Observable behaviour, and `settled:false` rxjs-absent refusal all byte-for-byte preserved. First consumer of `settle`; proves the extraction. `TimingRecord` becomes a view of a `completed` event.
- **Deliverable:** the neutral layer exists, `@Time` uses it, zero output change, zero new dependency.

**O1b — violation observations (the headline; depends on O1a).**
- **`src/Core/ParameterDecoratorFactory.ts`** *(edit)* — `descriptorCheck` throws a structured `ViolationError` (new `Error` subclass in `Core/`) whose **message is byte-for-byte unchanged** (every DEC-030 redaction test and message-parity test stays green) but which additionally carries a frozen `facts: ViolationFacts` (constraint identity, kind, params, `describe()`, parameter name/index/type — **no value, no rendered string**; deny-by-default at the source).
- **`src/Core/ContractInstaller.ts`** *(edit)* — in `enforcementBehavior`'s precondition `catch`, emit `{kind:'violation'}` as a **side-channel** *before* `applyViolationPolicy`, gated on `getObservationSink() !== NOOP_SINK && violation instanceof ViolationError`, adding `site.trust` and `site.blame`. It never influences control flow, fires under `'warn'` and suppressing handlers alike, and costs one `===` until a sink is installed and a violation fires.
- **Extend to the postcondition catch (the cross-item synergy — see Gaps):** `checkPostconditions`/`checkReturnConstraints` (item 2) also route through `applyViolationPolicy` at `calleeSite`. O1b should emit `{kind:'violation'}` there too. A **reified `@Returns` violation carries full `ViolationFacts`** (it is a descriptor) → groupable telemetry for free; an `@Ensures` closure violation degrades to a low-fidelity event (`owner.member` + `blame:'callee'` + `error.type:_OTHER`, no `constraint` dimension) — the SMELL-14 trade, stated not hidden. This connection is invisible in the single-feature plans and is a reason item 2 precedes item 3.
- **Deliverable:** any `@Contract()`/`@Validate()` method, with a sink installed, emits one value-free structured violation per failing call, independent of `setViolationPolicy`.

**O1c — `@Telemetry` band + resolver + `@Observe` + rebased `@Log` (depends on O1a).**
- **`src/Core/ContractRegistry.ts`** *(edit)* — a telemetry-disclosure band (own-scoped, index-keyed hence minification-safe, decorator-agnostic, record-only — installs nothing), the exact twin of the sensitivity band. Writers `recordParameterTelemetry`/`recordReturnTelemetry`; reads `getParameterTelemetry`/effective variants.
- **`src/Telemetry/Telemetry.ts`** *(new)* — `Telemetry.value(name?)`, `Telemetry.redact(strategy)`, `Telemetry.result()`. Redact strategies are **descriptors, not closures** (DEC-010): ship `value`/`type`/`length` first, `hash`/`first`/`last`/`domain` as a fast-follow once the strategy-descriptor shape is pinned.
- **`src/Core/ObservationBehavior.ts`** *(new, adapter-side)* — the one `MethodBehavior` `@Observe`/`@Log`/`@Time` become sugar over. The uninstalled path is one `===` compare; `Observation` built once at install time; the revised (Q-24/R5) body renders per-parameter `EmittedValue[]` via `renderValues` (reusing `shouldDiscloseValue` + `@Log`'s `safeStringify`), passes `ObservationCall` into `scope`, and `settle`s with the `Settlement<T>` callback.
- **`src/Core/redaction.ts`** *(reused, not edited)* — the disclosure resolver composes `getEffectiveFieldSensitivity`/`getParameterSensitivity` (veto) + the telemetry band (opt-in) + `getValueDisclosure()` (global). Resolves once at install into `ObservedParameter.disclosure`. **This is where O1's payload work touches redaction** (see Gaps): `renderValues` is a thin composition over `shouldDiscloseValue` — no new redaction logic, deny-by-default preserved.
- **`src/Core/Configuration.ts`** *(edit)* — `setObservationVerbosity('normal'|'detailed')`.
- **`src/MethodDecorators/Observe.ts`** *(new)* — the span+duration+message sugar, carrying `@Observe({kind})` (the only place `SpanKind` is overridden, Q-24/R7).
- **`src/MethodDecorators/Log.ts`** *(edit)* — emit `{kind:'message'}` events when a sink is installed; retain the console string as the no-sink fallback (no second breaking change — DEC-030 already made `@Log` structured/redacted).
- **`src/Sensitive/Sensitive.ts` interplay (Q-24/R8)** — `@Sensitive` overriding an explicit `@Telemetry.value()` **warns** (one-shot, via `setContractDiagnosticsSink`) and sets `EmittedValue.vetoed = true`; no `{force:true}` escape, no silent nullification.
- A small opt-in JSON-to-`console` `ObservationSink` ships here for out-of-the-box visibility (not installed by default).

**O1d — the privacy-review projection (depends on O1c's band).**
- **`src/Projections/telemetry.ts`** *(new)* — the "what leaves the process, and in what form" table: reads the telemetry band + sensitivity band + `getContractsForClass`, Core/+Contracts/ only (DEC-012). Renders its own scanned denominator (a clean table is never a clean bill of health — DEC-007 risk 9, DEC-028 pt 3), and a distinct "opted-in, vetoed by @Sensitive" row state (Q-24/R8).

### Registry band(s) touched
A **new telemetry-disclosure band** (O1c) — twin of the sensitivity band, record-only. Reuses (reads) the sensitivity band and the constraint bands. No enforcement band changes beyond `ViolationError` carrying facts (which does not change the stored contract).

### Projection touched
A **new sixth projection** `src/Projections/telemetry.ts` (O1d). No change to docs/schema.

### New tests
- `src/Core/Observation.test.ts` — `NOOP_SINK` is the cheap default; event union shapes; `RETURN_INDEX`.
- `src/Core/settle.test.ts` — the `Settlement<T>` mapping for sync/promise/observable/throw/rejection/rxjs-absent (the R1 table); `@Time` unchanged (`Time.test.ts`/`Time.rxjs-absent.test.ts` pass except where they assert the classifier's *internal* location).
- `test/violation-telemetry.test.ts` (O1b) — one value-free `{kind:'violation'}` per failing call carrying `{constraint,kind,params,expectation,parameterName?,parameterIndex,parameterType?,trust,blame}`; fires under `throw`/`warn`/suppress; never influences control flow; reified `@Returns` violation carries facts, `@Ensures` closure degrades to `_OTHER`.
- `src/Telemetry/Telemetry.test.ts` (O1c) — the three-input resolver truth table; deny-by-default; `@Sensitive` veto + warn + `vetoed`; `EmittedValue` rendering (`disclosed:true` value vs `disclosed:false` `[REDACTED]`); minification name-hatch.
- `test/observe.test.ts` — span kind default `'internal'` + `@Observe({kind})`; `error: ErrorFacts` on a throw with real `type`/`message`/`stack`; the one-`===` uninstalled fast path.
- `src/Projections/telemetry.test.ts` + `telemetry.imports.test.ts` (DEC-012 guard).
- CI extension (GAP-4): assert `@opentelemetry/*` never enters core's tree, exactly as rxjs is asserted absent.

### Edge cases
- **async/throw/rejection/Observable:** all via `settle`'s `Settlement<T>` (value XOR error); the span ends on settle, not return; rxjs-absent degrades to `settled:false` unchanged (SMELL-16 neither worsened nor fixed).
- **redaction:** the `record` path carries only pre-disclosed `EmittedValue` (deny-by-default `[REDACTED]`); the `scope` path sees the raw outcome (as `@Time` already does — around-shape grants it), and adorn hands it the pre-disclosed `values` as the safe default. `@Sensitive` vetoes visibly.
- **return-value disclosure (Q-23):** `@Telemetry.result()` gives a return the opt-in a `@Sensitive` return cannot express — the disclosure-side half of Q-23. Note the interplay with item 2's `@Returns` violation facts (both describe the return; keep them independent — one is telemetry disclosure, one is a contract).
- **minification (SMELL-1/DEC-OBS-4):** names degrade to `s`/`e`/`t` in production; `EmittedValue` emits *index* not `arg0`; `@Telemetry.value('name')` is the opt-in hatch. Qualify "structured logging for free" publicly (O1 §11 pt 5).

---

## Consolidated new `index.ts` exports

The orchestrator reconciles root `index.ts` centrally; enumerated precisely below. **Writers are never exported** (established rule, `index.ts` lines 50–56): `recordReturnConstraint`, `recordParameterTelemetry`, etc. stay internal. `getEffectiveReturnConstraints` and `getEffectiveContractKeys`-style installer plumbing stay internal.

### Item 2 — Reified Returns (root `index.ts`)
| Symbol | From | Purpose |
|---|---|---|
| `Returns` | `src/MethodDecorators/Returns.ts` | Method decorator: record a `ConstraintDescriptor` into the projectable `post` band. |

*(No new registry read export — projections read the already-exported `getEffectiveContract().post`. `MethodDoc.post`/`ClassSchema` are existing exported types whose surface gains a `returns` shape — a type-surface change, not a new symbol.)*

### Item 1 — Fuzzing Phase B (`addons/test/index.ts` only — **zero** root `index.ts` change)
| Symbol | From | Purpose |
|---|---|---|
| `fuzzMethodAsync` | `addons/test/oracle.ts` | Async twin of `fuzzMethod`; awaits the settled value before the oracle. |
| `fuzzClassAsync` | `addons/test/oracle.ts` | Async twin of `fuzzClass`. |

*(`OracleMode` gains `'postcondition'`, `FindingType` gains `'postcondition-violation'`, `FuzzOptions`/`FuzzResult`/`FuzzFinding` gain fields — all already type-exported. The add-on must remain absent from root `index.ts` — fast-check isolation, `isolation.test.ts`.)*

### Item 3 — Observability O1 (root `index.ts`)
**O1a**
| Symbol | From | Purpose |
|---|---|---|
| `setObservationSink` / `getObservationSink` | `src/Core/Observation.ts` | Install / read the one around-shaped sink. |
| `settle` | `src/Core/settle.ts` | The shared settling classifier; exported so `@adorn/otel` (O2) ends spans with adorn's one classifier. |
| type `ObservationSink` | `Observation.ts` | The sink interface (`scope`/`record`). |
| type `Observation`, `ObservedParameter`, `ParameterDisclosure` | `Observation.ts` | Install-time facts of an instrumented method. |
| type `ObservationEvent`, `ViolationFacts`, `EmittedValue`, `ErrorFacts`, `Attributes`, `AttributeValue`, `LogLevel`, `ObservationDetail`, `ObservationCall` | `Observation.ts` | The event/payload surface an adapter binds to. |
| type `SpanKind`, const `RETURN_INDEX` | `Observation.ts` | Span-kind union (F3) and the return sentinel index. |
| type `Settlement`, `SettleKind` | `settle.ts` | The value-XOR-error settlement handed to `settle`'s callback. |

**O1c**
| Symbol | From | Purpose |
|---|---|---|
| `Observe` | `src/MethodDecorators/Observe.ts` | Span+duration+message sugar over `observeBehavior`; carries `{kind}`. |
| type `ObserveOptions` | `Observe.ts` | `@Observe({kind, detail})` options. |
| `Telemetry` | `src/Telemetry/Telemetry.ts` | Namespace: `.value(name?)` / `.redact(strategy)` / `.result()`. |
| `setObservationVerbosity` | `src/Core/Configuration.ts` | The `'normal'|'detailed'` detail gate. |
| type `ObservationVerbosity` | `Configuration.ts` | The verbosity value type. |
| `consoleObservationSink` | `Observation.ts` (or `ObservationBehavior.ts`) | Opt-in JSON-to-`console` sink for out-of-the-box visibility. |

**O1d**
| Symbol | From | Purpose |
|---|---|---|
| `telemetryForClass` / `telemetryForContracts` | `src/Projections/telemetry.ts` | The "what leaves the process" model, per class / whole registry. |
| `serializeTelemetry` / `generateTelemetryReport` | `src/Projections/telemetry.ts` | Render the privacy-review table (with its scanned denominator). |
| type `TelemetryReport` (or `TelemetryDoc`) | `telemetry.ts` | The projection's model type. |

*(`ViolationError` from O1b stays **internal** — consumers receive facts through the sink, not by catching; exporting it would widen the surface with no consumer. `NOOP_SINK` stays internal — a sink author does not need the sentinel.)*

---

## Consolidated tracker updates

### `docs/ISSUES.md`
| Item | Change |
|---|---|
| **Q-11** | Already RESOLVED (v1). Item 2 completes it — the reserved `ConstraintDescriptor` `post` slot finally has its writer (`@Returns`/`recordReturnConstraint`), the projectable tier DEC-032 kept it reserved for. Note it as fully closed for the descriptor tier (`old()`/invariants still deferred separately). |
| **Q-24** | Move to **BUILT** when O1 lands — the payload channel the Revision designed is implemented (`EmittedValue`/`ErrorFacts`/`ObservationCall`/`Settlement<T>`), disclosure-gated on `record`, outcome-passing on `scope`. |
| **Q-23** | Partially addressed — `@Telemetry.result()` (O1c) gives a return the disclosure opt-in; the marking-a-return-`@Sensitive` half stays open. Item 2's `@Returns` is a *contract* on the return, orthogonal to sensitivity — record that they are independent. |
| **IDEA-3** | PARTIAL (Phase A) → advance: Phase B (item 1) wires the full oracle; move toward IMPLEMENTED (custom-generator registry / persisted corpus remain Phase C). |
| **IDEA-4** | v1 BUILT → the fuzzer now *consumes* the oracle (item 1); the reified/projectable postcondition (item 2) is the DEC-032-deferred piece, now built. |
| **IDEA-7 / IDEA-12** | docs & schema projections gain a return-value fragment (item 2). OpenAPI *response* half is now expressible; full OpenAPI still blocked on Q-10 arity. |
| **Q-6** | Stakes rise on three fronts — the registry `post` reads (item 2), the semver-frozen `ObservationEvent`/`ObservationSink` union (item 3, pinned all-optional/object-shaped for additive growth), and the fuzzer's `OracleMode`. Enumerate the additions. |
| **Q-3 / Q-4 / Q-5 / Q-10** | Standing limits, restated not resolved: hand-written predicates/closures still generate nothing and still project nothing (SMELL-14 floor); postcondition expressiveness (Q-5) is the real adoption risk item 1 cannot fix. |
| **New (open)** | **Cross-band postcondition ordering & blame** — `@Returns` (descriptor `post`) vs `@Ensures` (closure `postconditionsByTarget`): both callee/assert, first-failure-wins across two bands; the reified band is checked first (pinned). Record as an issue so the ordering is not silently changed. |
| **New (open)** | **Counterexample redaction under `@Sensitive`** — a fuzz counterexample must be visible to reproduce, but a `@Sensitive` parameter's generated value in that counterexample is a disclosure question DEC-030/DEC-025 do not cleanly resolve for a dev-tool report. Flag it. |
| **Fr1 / Fr3** (from O1 review) | Remain open — the name-hatch coupled to value disclosure (Fr1) and the `setObservationVerbosity` knob included on principle (Fr3); the payload channel neither helped nor worsened them. |
| **Q-22** | Untouched (cache/authorize ordering hazard — future `@adorn/cache`). |

### `docs/DECISIONS.md` (new entries DEC-033+)
| Entry | Records |
|---|---|
| **DEC-033** — Reified `@Returns(<descriptor>)`, the projectable postcondition tier | Writes to the reserved `post` `ConstraintDescriptor` band (not the closure band); coexists with `@Ensures`; the reified-first cross-band ordering; callee blame / `assert` trust shared with closures; the return-value schema + docs projections; the single-value/projectable vs n-ary/opaque split; DEC-010 (predicate derived) and DEC-012 (projection reads Core/Contracts only) preserved. |
| **DEC-034** — Fuzzing Phase B: the full oracle | The fuzzer consumes `getEffectivePostconditions` + `evaluatePostconditions` **and** `getEffectiveContract().post` (both bands); auto oracle-mode selection; async via `fc.asyncProperty`; counterexample-visible-but-return-redacted; the no-drift integration pin (fuzzer flags iff wrapper flags); stays wholly in `@adorn/test` (DEC-019). |
| **DEC-035** — Observability O1 | Umbrella that ratifies the O1 build and **absorbs the proposed DEC-OBS-1..6 into the DEC-0xx sequence** (zero-core-dependency, around-shaped sink, deny-by-default value emission, the `@adorn/otel` peer split, the two-value verbosity ladder, the moving-`recordException` confinement). |
| **DEC-036** — The per-call payload channel principle ("seeing ≠ emitting") | Ratifies Q-24/R0/DEC-OBS-7: the `record` surface carries only pre-disclosed data (redacted by default); the `scope` surface sees the raw outcome exactly as `@Time` already does; span kind is declared (`@Observe({kind})`, default `'internal'`) not inferred; `@Sensitive` overriding `@Telemetry.value()` warns-and-surfaces rather than silently nullifies. |

---

## Gaps / anything missing (visible only with all three in view)

1. **Two postcondition bands now exist, and three consumers must read both.** After item 2 there are `postconditionsByTarget` (closures) *and* `MethodContract.post` (descriptors). The enforcement weave, the fuzzer oracle (item 1), **and** the docs/schema/telemetry projections must each consume **both** or silently drop half a method's guarantees — the exact "enforced but undocumented / unchecked" asymmetry DEC-016 rejects, which never throws to reveal itself. *Mitigation:* treat "consume both bands" as one rule with one obvious seam. Consider a single core helper (e.g. `getEffectiveReturnConstraints` beside `getEffectivePostconditions`) and a checklist pinned by a test that a method carrying only a `@Returns` (no `@Ensures`, no params) is enforced, fuzzed, documented, and schema'd. This is the single highest-risk interaction across the three items.

2. **`@Returns` × `@Ensures` ordering and blame.** Both are callee/`assert`, first-failure-wins, in *separate bands* whose cross-band declaration order is unrecoverable. The plan fixes reified-first (structured guarantee reported first, and it feeds groupable telemetry). This is a real behavioural choice — a method failing both now reports the `@Returns` message — so it must be pinned, not left emergent. The prior single-feature plans could not see this because `@Ensures` shipped before `@Returns` existed.

3. **Should the fuzzer prefer reified `@Returns` over `@Ensures` closures? No — it runs both.** The reified band does not *replace* the closure band as an oracle; it *adds* a projectable, nameable check. The value of reified for the fuzzer is the **report**, not the checking: `oraclesChecked` can name "verified result ≥ 0" for a `@Returns` and only "(anonymous closure)" for an `@Ensures` — the foundation §5.2-pt-3 honesty win. Do not build a "prefer one" path; build a "check both, name what you can" path.

4. **O1's violation telemetry should cover postcondition violations, and reified vs closure splits the fidelity — a synergy the single plans missed.** O1b as written focuses on *precondition* `ViolationError`s. But item 2 routes `@Returns`/`@Ensures` failures through the same `applyViolationPolicy` at `calleeSite`. Emitting `{kind:'violation'}` there too means a **reified `@Returns` violation carries full `ViolationFacts`** (groupable: `constraint`+`params`+`blame:'callee'`) while an `@Ensures` closure degrades to `_OTHER` — the SMELL-14 trade surfacing in telemetry. This is a concrete reason to build item 2 before item 3, and to make O1b's emit site the shared `applyViolationPolicy`-adjacent seam, not only the precondition catch.

5. **O1's payload work does touch redaction — but adds no new redaction logic.** `renderValues` (O1c) composes `shouldDiscloseValue` + `safeStringify` (both shipped, DEC-030); the resolver composes the sensitivity band (veto) + telemetry band (opt-in) + global switch. Deny-by-default is preserved and the `record` path never carries a raw value. The one genuinely new surface is `EmittedValue` on the *frozen* event union (Q-6) — pinned all-optional so growth stays additive. Verify the interplay: item 2's `@Returns` violation facts and O1c's `@Telemetry.result()` both concern the return but are independent (contract vs disclosure) — keep them decoupled.

6. **Async is the recurring hard edge across all three.** Enforcement already awaits (DEC-032). Item 2 reuses that. Item 1 needs `fc.asyncProperty` and an explicit `fuzzMethodAsync` (silently checking a Promise object is the "number that looks like an answer" trap). Item 3's `settle` is the shared classifier that makes `@Time`, `@Observe`, and O2 spans agree on one duration and one settled value. One classifier, three consumers — if any reimplements settling, the drift DEC-006 exists to abolish reappears. Route everything through `src/Core/settle.ts`.

7. **`strict:false` narrowing (DEC-032's gotcha) — check each new union.** `PostconditionResult` is already flat for this reason. `Settlement<T>` is discriminated on a *string* literal (`outcome:'returned'|'threw'`), which **does** narrow without `strictNullChecks` — so it may be a real discriminated union (unlike the boolean case). `EmittedValue`/`ObservationEvent` are object-shaped with optional fields, safe. Confirm no new `{ok:true}|{ok:false}` boolean-discriminant shapes are introduced.

8. **Semver surface grows on three fronts at once (Q-6).** Item 2 adds registry `post` reads and a `returns` schema keyword; item 3 freezes the `ObservationSink`/`ObservationEvent` union the moment `@adorn/otel` binds; item 1 adds `OracleMode`. Each is individually additive, but three at once is worth one consolidated Q-6 note so the eventual public/frozen boundary is drawn deliberately rather than accreted.

9. **The add-on isolation invariant is load-bearing for item 1.** Phase B must not add a single symbol to root `index.ts`, and `isolation.test.ts` must keep asserting zero `fast-check` in `dist` and runtime deps `{tslib}`. The async entry points live only in `addons/test/index.ts`.

---

## Recommended build order (with rationale)

**1. Item 2 — Reified `@Returns` + return-value schema.** Smallest, highest-leverage, and it settles the `post`-band *shape* before anything authors an oracle or a projection over it (the DEC-010/DEC-006 scheduling lesson: settle the descriptor shape first, avoid the author-then-retrofit rework the project has paid for repeatedly). It reuses the entire descriptor/predicate/schema machinery already shipped, so it is the cheapest of the three, and it hands item 1 a richer oracle and item 3 a groupable-telemetry source.

**2. Item 1 — Fuzzing Phase B.** Build it **once** to consume *both* postcondition bands (closures + reified `post`), rather than building it against closures today and retrofitting the descriptor band after item 2. Phase B is otherwise buildable today against the shipped closure oracle — so if item 2 slips, Phase B can ship closure-only and gain the descriptor band as a small additive oracle change (auto-mode already keys on "any effective postcondition"). It is the direct completion of the fuzzing foundation and the fourth projection's payoff.

**3. Item 3 — Observability O1.** Fully independent of items 1 and 2 in its foundation (O1a/O1b), so a **second implementer can run it concurrently** from the start. It is sequenced nominally last because it is the largest, touches the enforcement weave (the violation side-channel) and redaction, and its O1b synergy with reified-`@Returns` telemetry (Gap 4) is only realised once item 2 exists — so O1b's *value* peaks after item 2, even though O1a/O1b can be coded before it. Within O1, follow the plan's own O1a → O1b → O1c → O1d order, and treat the corrected `settle` arity (`Settlement<T>`, Q-24/R1) as a hard precondition of O1a.

**One-line summary:** settle the projectable postcondition shape (2), complete the fuzzer against both oracle bands (1), then build observability on the neutral layer (3) — with 3 free to proceed in parallel and its telemetry-fidelity payoff realised once 2 has landed.
