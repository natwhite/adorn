# Decision: a TC39 Stage-3 (standard) decorators adapter for `adorn`

> **Purpose.** Set the direction for a second decorator adapter at `src/Adapters/stage3/`, sibling to
> `src/Adapters/legacy/`, that records into the **same** decorator-agnostic Core model so every
> projection (docs, JSON Schema, telemetry, fuzzing) keeps working unchanged. This is a
> **decision + design-rationale** document, not a build plan: it decides the authoring surfaces, the
> shipping/selection model, and the layer boundary, with enough design to prove each decision real.
>
> **Foundation.** [`decorators-modernization.md`](./decorators-modernization.md) (the legacy-vs-standard
> research and the parameter-decorator gap), and DEC-003 (dual-track, co-equal), DEC-012 (Core imports
> no adapter), DEC-038 (adapter layer physically separated; `stage3/` meant to sit beside `legacy/`),
> DEC-016 (installation implies enumeration), DEC-039 (the registry read surface is the frozen public
> API), DEC-006/DEC-010 (contract-as-data). GAP-11 (the `exports` map) and GAP-8 (adapter separation)
> are both FIXED and are the runway this builds on.
>
> **Status:** direction-setting. No source under `src/` or `index.ts` is modified by this document. It
> proposes DEC-040…DEC-045 and new tracker entries for the orchestrator to reconcile.

---

## 0. Executive summary

1. **The crux — expressing per-parameter contracts with no parameter decorators — is resolved by a
   method-level positional spec** carried on the installer decorators (`@Validate({ params })` per
   method; `@Contract({ constructor })` for constructor parameters). It reads a list of
   `ConstraintDescriptor`s and records each into the **identical** `recordParameterConstraint(target,
   key, index, descriptor)` band the legacy per-parameter decorators write. The registry, and therefore
   every projection, cannot tell which adapter produced the row (DEC-012). The gap is broader than
   constraints: **`@Sensitive` and `@Telemetry` are also parameter decorators today** and lose the same
   authoring position — they fold into the same spec as sibling keys, recording into
   `recordParameterSensitivity` / `recordParameterTelemetry`.

2. **Two adapters, selected by entry point, never mixed in one build.** `experimentalDecorators` is a
   per-*compilation* switch owned by the **consumer**, so legacy and standard are a per-consumer choice.
   adorn ships `adorn` (root, **legacy default** — DEC-038/DEC-039's frozen surface unchanged) and
   `adorn/stage3` (the standard adapter), both re-exporting one shared decorator-agnostic surface. The
   `exports` map (GAP-11) gains a `"./stage3"` subpath. `index.ts` is **not** forked; the shared exports
   are factored so each entry point composes the shared surface with its own adapter's decorators.

3. **Almost everything is reusable.** The Core model (`ContractRegistry`, `Descriptor`/`defineConstraint`
   and the whole `Contracts/*` descriptor library, `Configuration`, `redaction`, `Observation`, `settle`,
   `Postconditions`, `telemetryDisclosure`, `ViolationError`) and all three projections are already
   decorator-agnostic and shared verbatim. The **enforcement weave** (gate → preconditions → `proceed()`
   → postconditions, plus the O1b observation emission) currently lives in the legacy adapter but is
   itself decorator-agnostic; it should be **hoisted into a shared enforcement layer** both adapters
   consume, leaving only wrapper-install mechanics and the authoring decorators adapter-specific.
   `layering.test.ts` extends to guard `stage3/`.

4. **The honest capability losses are two, both advisory or narrow.** Standard decorators emit **no
   `design:type`** (no standard `emitDecoratorMetadata`; TS team calls a counterpart "very unlikely"),
   so the Stage-3 adapter records no reflected types — projections already treat `type` as optional and
   degrade to `—`. And **plain class fields cannot be intercepted on every write** under standard
   field semantics (`useDefineForClassFields` define-semantics bypass inherited setters), so Stage-3
   field enforcement targets **`accessor` auto-accessors**; a plain-field decorator can validate the
   initializer only. Parameter *names* are **not** lost — the method decorator still receives the
   function, so the same `toString` recovery works, and the positional/name-keyed spec can supply names
   explicitly (strictly better under minification).

---

## 1. What the legacy adapter records and installs (the shapes to reproduce)

Every authoring form ultimately writes the decorator-agnostic registry keyed by `(target, key[, index])`,
where `target` is a prototype (instance members) or a constructor (statics). The Stage-3 adapter must
produce the **same registry writes**; only the authoring surface and the install mechanics change.

| Legacy authoring form | Decorator kind | Records via | Installs? |
|---|---|---|---|
| `m(@GreaterThan(0) x)` | parameter | `recordParameterConstraint(t,k,i,desc,'prepend')` | no — needs `@Contract()`/`@Validate()` |
| `m(@Sensitive() x)` | parameter | `recordParameterSensitivity(t,k,i,marking)` | no (record-only, never installs) |
| `m(@Telemetry.value() x)` | parameter | `recordParameterTelemetry(t,k,i,marking)` | no (record-only) |
| `@Enforce.greaterThan(0) f` | field | `recordFieldConstraint(t,k,desc)` | **yes, self-installs** (trampoline accessor) at decoration time |
| `@Sensitive() f` / `@Sensitive() class` | field / class | `recordFieldSensitivity` / `recordClassSensitivity` | no |
| `@Ensures((r,...a)=>bool)` | method | `recordPostcondition(t,k,{predicate,description},'prepend')` | no — needs `@Contract()`/`@Validate()` |
| `@Returns(descriptor)` | method | `recordReturnConstraint(t,k,desc,'prepend')` (reified `post` band) | no — needs installer |
| `@Telemetry.result()` | method | `recordReturnTelemetry(t,k,marking)` | no |
| `@Log()` / `@Time()` / `@Observe()` | method | *(no registry record)* | **yes, self-installs** via `CreateMethodDecorator` |
| `@Contract()` | class | `registerContractedClass` + `installOn` | installs every recorded method + registers for enumeration |
| `@Validate()` | method | `registerOwningClass` | installs one method + registers |

Two structural facts make the port cheap:

- **The registry writers are already adapter-blind.** `recordParameterConstraint(target, key, index,
  descriptor, position)` takes a prototype/constructor and a `ConstraintDescriptor` — nothing about a
  `ParameterDecorator`. The header of `ContractRegistry.ts` says so explicitly: *"A method-level
  `@Contract({...})` on standard decorators must be able to populate this store exactly as the legacy
  per-parameter form does."* Descriptors (`Descriptor.ts`) are frozen JSON-derived data with a
  derived predicate; they are the shared currency both adapters trade in.

- **Installation is already split from recording** for the record-only forms, and the field band already
  proved a *descriptor-only* authoring path with no closure escape hatch (no SMELL-14 to pay off). The
  legacy adapter drives record-then-install together only because it has no later hook; the field
  factory's own header notes *"a standard-decorator adapter would record at decoration time and install
  from `context.addInitializer` without this module changing."*

---

## 2. The Stage-3 authoring surface, per contract kind

Standard decorators (TS 5.0+) cover **class, method, accessor, getter/setter, and field**, each receiving
`(value, context)` with `context.{kind,name,static,private,access,addInitializer,metadata}`; class and
method/accessor decorators may **return a replacement** the language honours; field decorators return an
initializer transform; accessor decorators return `{get?,set?,init?}`. There is **no parameter decorator**.
`context.metadata` accumulates onto `Class[Symbol.metadata]` after all decorators run (TS 5.2+).

### 2.1 The install model: members stage into `context.metadata`; `@Contract` drains and installs

The Stage-3 adapter mirrors the legacy split, adapted to the standard model:

- **Member decorators that record** (`@Ensures`, `@Returns`, and the parameter spec — see §3) do **not**
  have the prototype/constructor at decoration time, so they **stage their recording into
  `context.metadata`** (an ordinary object shared by all decorators of that class). They return nothing.
- **The class-level `@Contract` decorator runs last**, receives the constructor `value` directly, and
  **drains `context.metadata` into `ContractRegistry`** keyed by `constructor` (statics) and
  `constructor.prototype` (instance members) — the same two key bands `getContractsForClass` reconciles —
  then installs one wrapper per method (`Object.defineProperty(prototype, key, {value: wrapper})`, safe
  because the class is fully defined) and registers the class for enumeration (DEC-011/DEC-016).

This keeps **one wrapper per method** (no per-decorator wrapping dance), shares the legacy weave, and
makes the conformance suite meaningful. It is the standard-mode analogue of legacy's *"class decorators
run last, so the installer sees complete metadata."*

- **Self-installing method decorators** (`@Log`, `@Time`, `@Observe`) map onto standard method decorators
  that **return their replacement** — the sanctioned mechanism (research §4.2). This is where Stage-3 is
  *simpler* than legacy: the return value is honoured, so the `OverrideObjectDefineProperty` monkey-patch
  and the whole `__decorate`-clobbers-the-wrapper problem (DEC-005) **never exist** in this adapter. The
  completion-emit coordination (`ownsCompletion`/`markOwnsCompletion`, so an outer enforcement wrapper
  suppresses `@Observe`'s duplicate `completed`) ports directly.

### 2.2 Fields — `accessor` for every-write enforcement (the one genuine mechanism change)

Legacy installs a **prototype trampoline accessor** and it intercepts instance-field assignment because
legacy runs under `target: es2019` + `experimentalDecorators`, where `useDefineForClassFields` defaults
**false** and field initialization uses *set* semantics (hits the inherited setter). Standard decorators
run under ES2022+ semantics where field init uses **define** semantics and **bypasses inherited setters** —
so the legacy trampoline silently would not fire.

The standard mechanism for every-write field interception is the **auto-accessor**:

```ts
class Widget { @Enforce.greaterThan(0) accessor count = 0; }   // Stage-3
```

The Stage-3 accessor decorator returns `{get, set, init}`, validating on `init` and every `set` — a clean,
sanctioned equivalent of the trampoline (and, unlike the trampoline, no `defineProperty` gymnastics). A
Stage-3 **plain-field** decorator (`@Enforce.greaterThan(0) count = 0`, no `accessor`) can only return an
initializer transform, so it validates the **initial value once** and cannot guard later assignments — a
real, documented capability difference. Because a field constraint is a *class invariant* (DEC-021), the
recommended Stage-3 form is `accessor`; a plain-field decorator emits a one-time dev diagnostic that it
only checks initialization (honest capability framing, per MikroORM's precedent in research §6.5).

Field constraints, sensitivity, and reflected type all still write the same field band
(`recordFieldConstraint` / `recordFieldSensitivity` / `setFieldMetadata` — the last simply left unset,
§5).

### 2.3 Class, `@Ensures`, `@Returns`, method behaviours

- **`@Contract` (class), `@Validate` (method)** keep their names and roles from legacy — the installers and
  enumeration markers. `@Contract` additionally drains staged metadata (§2.1) and installs field
  accessors it staged. `@Validate` may self-install its own method (returning the wrapper) and register
  enumeration via `addInitializer` (`this.constructor` at first construction) — see the enumeration-timing
  caveat in §6.
- **`@Ensures` / `@Returns`** are method decorators that stage `recordPostcondition` /
  `recordReturnConstraint` into `context.metadata`; `@Contract`/`@Validate` install the after-`proceed()`
  checks. The reified/opaque split (DEC-032/DEC-033) is a Core property and is preserved untouched.
- **`@Log` / `@Time` / `@Observe`** self-install by returning a replacement (§2.1).

---

## 3. The crux: per-parameter contracts without parameter decorators (DEC-041)

TC39 standard decorators do **not** include parameter decorators, the extension proposal is Stage 1 and
dormant since 2023-03 with committee opposition to its motivating use case, and it cannot advance past a
parent proposal itself back at Stage 2.7 (research §2). So the Stage-3 adapter **cannot** offer the
`m(@GreaterThan(0) x)` authoring position — for constraints **or** for the parameter forms of `@Sensitive`
and `@Telemetry`, which share the identical position.

**Decision — a method-level positional descriptor-list spec, recording into the same param band.**

```ts
// Stage-3
@Validate({
  params: [ [GreaterThan(0)], [MinLength(3), NotEmpty()] ],  // by position; index = slot
  sensitive: [0],                                            // parameter-position @Sensitive
  telemetry: { 1: 'value' },                                 // parameter-position @Telemetry
})
transfer(amount: number, memo: string) { /* ... */ }

// Constructor parameters have no method to hang @Validate on, so they ride the class installer:
@Contract({ constructor: [ [GreaterThan(0)] ] })
class Account { constructor(openingBalance: number) {} }
```

The spec is read at decoration time and each descriptor recorded via
`recordParameterConstraint(proto, key, index, descriptor)`; the sensitivity/telemetry keys record via
`recordParameterSensitivity` / `recordParameterTelemetry`. **The registry writes are byte-identical to what
the legacy per-parameter decorators produce**, so enforcement, docs, schema, telemetry, and fuzzing are
all adapter-blind (DEC-012). Because the standard adapter's decorators arrive in declaration order (not
`__decorate`'s reverse), the spec records with the **default `'append'`**, exactly as `ContractRegistry`
anticipates (DEC-017).

**Why this shape:**

- It is the research's verified Option B (§4.2), the shape `decorator-contracts` migrated to voluntarily
  (§6.6), and the convergent answer of standard-decorator-native libraries (`@freshgum/typedi`'s
  `@Service([...])`, §6.8). It is a legitimate contract idiom, not a consolation prize.
- **Positional** (not index-keyed-object) so the constraint↔parameter correspondence can be made
  **partially type-safe** with a variadic-tuple type mapping each slot's checks to the corresponding
  parameter type (`MinLength` on a `number` slot becomes a compile error) — a guarantee the legacy
  per-parameter form never had (nothing type-checks the pairing there). This is flagged
  **[Low]-confidence / to-prototype** (research §8); the runtime shape is proven regardless.
- A **name-keyed object** (`params: { amount: [GreaterThan(0)] }`) is accepted as an ergonomic alternative:
  it reads best and survives parameter reordering, at the cost of not being type-checkable against the
  signature. Both forms resolve to the same index-keyed registry writes.

**What is accepted as lost:** locality (the constraint no longer sits on the parameter) and, for the
positional form, a compiler-unchecked index↔parameter link if type-safety is not built. This is the
inherent trade of the whole standard-decorator direction and is why adorn keeps the legacy per-parameter
form as a co-equal (DEC-003), not a deprecated one.

**Explicitly rejected as the primary surface:** a non-decorator HOF `contract(spec, fn)` (research §4.6) —
it stops being a decorator library and does not compose with class methods; kept only as a possible
**supplementary** export for free functions (which no decorator model can target), deferred.

---

## 4. Shipping and selection (DEC-040)

**`experimentalDecorators` is per-compilation and owned by the consumer** (research §1.4): a consumer's one
`tsconfig.json` interprets *all* decorators under one model, with no per-file override. Legacy and standard
therefore **cannot be mixed in a single consumer build** — it is a per-consumer choice. A library cannot
straddle it for its consumers, because adorn's decorators are *applied* in consumer code.

**Decision — two adapters, one entry point each, over one shared surface:**

- **`adorn` (root) stays legacy-default.** DEC-038's pure move and DEC-039's frozen 72-export surface are
  unchanged; existing consumers and the `bin` are untouched.
- **`adorn/stage3` is the standard-decorator adapter.** It re-exports the **same** shared decorator-agnostic
  surface (registry reads, projections, configuration, descriptors, the observation seam, the postcondition
  oracle) and adds its own adapter's decorators (`@Contract`, `@Validate`, `@Enforce`, `@Log`, `@Time`,
  `@Observe`, `@Ensures`, `@Returns`, `@Sensitive`, `@Telemetry`), authored for standard decorators.
- **`index.ts` is not forked.** The decorator-agnostic public surface is extracted into a shared re-export
  module that both `index.ts` (legacy) and a new `index.stage3.ts` compose with their adapter-specific
  decorators. DEC-039's export-count tripwire then applies **per entry point** (each gets its own pinned
  count; the shared core count is asserted once).
- **The `exports` map (GAP-11) gains `"./stage3"`:**

  ```jsonc
  "exports": {
    ".":        { "types": "./dist/index.d.ts",         "default": "./dist/index.js" },
    "./stage3": { "types": "./dist/index.stage3.d.ts",  "default": "./dist/index.stage3.js" }
  }
  ```

  The frozen registry read-surface (DEC-039) is the one thing a consumer resolves through either subpath —
  identical from both, because it is Core.

Consumers select by import path *and* their tsconfig mode; the two must agree (a `adorn/stage3` import under
`experimentalDecorators: true`, or vice-versa, is a consumer misconfiguration the docs must call out — the
decorators simply will not type/emit under the wrong mode).

---

## 5. Reusable vs adapter-specific, and the layer boundary (DEC-043)

**Shared verbatim (Core / Contracts / Projections — already decorator-agnostic, guarded by
`layering.test.ts`):** `ContractRegistry` (model + reads + writes), `Descriptor`/`defineConstraint` and the
entire `Contracts/*` descriptor library, `Configuration` (trust, gates, violation policy), `redaction`,
`Observation`, `settle`, `Postconditions`, `telemetryDisclosure`, `ViolationError`, and all three
projections (`docs`, `schema`, `telemetry`).

**The enforcement weave should be hoisted to a shared layer.** `enforcementBehavior` +
`checkReturnConstraints` + `checkPostconditions` + the O1b emission currently live in
`Adapters/legacy/ContractInstaller.ts`, but they are decorator-agnostic in substance: they take
`(host, key, trust, ...)`, read the registry's effective contracts/postconditions, and return an
around-shaped behaviour. Their only adapter-coupled dependencies are the *invocation seam*
(`MethodBehavior`/`InvocationContext`) and `buildParameterEnforcement`/`planChecks` — both of which are
themselves neutral (`planChecks` reads the registry and parses the function's `toString`; the only
legacy-specific piece is the `CreateSimpleDecorator` **staging table** for hand-written closures, which
Stage-3 need not replicate). **Decision:** extract the weave, the invocation seam, and the
registry-driven check planner into a shared enforcement layer (Core-eligible, or a new
`src/Enforcement/` band) that **both** adapters consume; each adapter keeps only its *install mechanics*
(legacy: `defineProperty` + the field trampoline; stage3: return-a-replacement + `accessor` returns) and
its *authoring decorators*. This is what makes DEC-003's "one engine, two skins" literally true and the
conformance suite (DEC-045) checkable.

**DEC-012 extends to `stage3/`.** `layering.test.ts` already sweeps every `Core`/`Contracts`/`Projections`
module and asserts none imports from `Adapters/`; it needs no change to cover the new adapter, but the
hoisted enforcement layer must land on the **Core side** of that boundary (it must not import either
adapter). The reverse — `stage3/` importing Core/Contracts freely — is legal and unchecked, exactly as for
`legacy/`.

**Adapter-specific, per adapter:** the authoring decorators; the install mechanics; and Stage-3
counterparts of the two legacy adapter helpers that bake in the decorator model —
`ObservationBehavior` (consumes `InvocationContext`, `getParamNames`, `design:paramtypes`, and the
`target`/`constructor` split) and `ContractDiagnostics` (keys on `(target, propertyKey)` and relies on
"member decorators run before the class decorator, synchronously" for its microtask sweep). The
pending-set / warn-once *mechanism* of the diagnostic is model-agnostic and should be shared; only its
recording shape and timing assumption need a Stage-3 version (staging via `addInitializer` / metadata).

---

## 6. Feasibility and risks

- **No `design:type` under standard decorators (DEC-044).** There is no standard `emitDecoratorMetadata`
  and the TS team calls a counterpart "very unlikely" (research §1.5, §3.2). The Stage-3 adapter records
  no reflected `type` on parameters or fields. **Impact is advisory only:** `ParameterContract.type` /
  `FieldContract.type` are already optional; the docs projection renders `—`; the schema projection derives
  JSON-Schema `type` from the *constraint's* `schema()`/kind, not from `design:type`. **No projection
  breaks**, and parameter *names* are unaffected (the method decorator still gets the function, so
  `getParamNames` works; the spec can also supply names explicitly — minification-safe, research §5). The
  Stage-3 adapter drops the `reflect-metadata` dependency entirely on its path.

- **Field define-vs-set semantics** — the reason Stage-3 field enforcement needs `accessor` (§2.2). This is
  the one place a Stage-3 authoring form differs visibly from legacy, and it must be documented, not
  smoothed over.

- **adorn's own build needs a second compilation unit.** The Stage-3 adapter *source* mostly compiles
  fine under the existing config (it defines decorator functions; it does not apply `@`-decorators), but
  its **tests and examples apply standard decorators**, which requires `experimentalDecorators: false` —
  incompatible with the legacy suite's `true` in one tsconfig. So the repo needs a `tsconfig.stage3.json`
  (and a jest project) with standard mode for the stage3 tests/examples. This mirrors, recursively, the
  consumer constraint the whole document is about. (ts-jest under TS 6.0.3 supports standard decorators;
  DEC-013's ceiling is unaffected.)

- **Enumeration timing for a standalone `@Validate`.** Legacy enumerates at *decoration* time. A Stage-3
  standalone `@Validate` (without a class `@Contract`) has no constructor at decoration time, so it must
  enumerate via `addInitializer` at *first construction* — a minor divergence (a never-instantiated,
  `@Validate`-only class would be invisible to enumeration until constructed). Recommend `@Contract` as the
  documented primary installer in Stage-3 (it has the constructor and enumerates immediately), with
  standalone `@Validate` carrying the documented caveat. New **Q**.

- **No closure escape hatch in Stage-3.** Legacy keeps `CreateSimpleDecorator` (hand-written closures,
  staged adapter-locally, invisible to projections — SMELL-14). The Stage-3 adapter should be
  **descriptor-only**, exactly like the field band already is, so it never acquires a SMELL-14. New **Q**
  records the deliberate omission.

- **Drift between adapters is Option G's main failure mode** — addressed by the shared weave (§5) and the
  conformance suite (DEC-045).

- **Monitoring triggers (research §7.4) unchanged:** a real `experimentalDecorators` deprecation would
  promote Stage-3 to primary; a Stage-2+ parameter-decorator proposal would let *both* adapters delete
  fragile machinery. Neither is imminent.

---

## 7. Recommended DECISIONS (for reconciliation into `DECISIONS.md`)

- **DEC-040 — Two adapters, one entry point each, per-consumer decorator mode.** `adorn` stays legacy
  default (DEC-038/DEC-039 unchanged); `adorn/stage3` is the standard adapter; both re-export one shared
  decorator-agnostic surface; `index.ts` is not forked; the `exports` map (GAP-11) gains `"./stage3"`.
  Legacy and standard are not mixable in one consumer build — selection is by import path + tsconfig mode.

- **DEC-041 — Stage-3 expresses per-parameter contracts as a method-level positional descriptor-list spec**
  (`@Validate({ params, sensitive, telemetry })`; `@Contract({ constructor })` for constructor params),
  recording into the identical `recordParameterConstraint` / `recordParameterSensitivity` /
  `recordParameterTelemetry` bands. Positional primary (admits partial variadic-tuple type-safety),
  name-keyed accepted, HOF rejected as primary. **The central decision.**

- **DEC-042 — Stage-3 field constraints target `accessor` auto-accessors for every-write enforcement;**
  a plain-field decorator validates the initializer only and says so (define-semantics bypasses inherited
  setters). Honest capability difference, documented.

- **DEC-043 — The enforcement weave, invocation seam, and registry-driven check planner are hoisted to a
  shared, decorator-agnostic enforcement layer** both adapters consume; only install mechanics and
  authoring decorators are adapter-specific. `layering.test.ts` / DEC-012 extend to `stage3/`, and the
  hoisted layer sits on the Core side of the boundary.

- **DEC-044 — The Stage-3 adapter records no `design:type` and drops `reflect-metadata`** (no standard
  `emitDecoratorMetadata`). Projections degrade gracefully (advisory `type` only); parameter names are
  unaffected. Accepted loss.

- **DEC-045 — One shared conformance suite runs identical scenarios against both adapters** (same
  descriptors, violation messages, trust/production semantics, inheritance union, postcondition weave),
  because behavioural drift is the dual-track design's primary failure mode.

## 8. New ISSUES / IDEAs (proposed numbers; reconcile against live maxima — currently DEC-039, GAP-11, IDEA-13, Q-24)

- **GAP-12 — `src/Adapters/stage3/` does not exist yet.** The adapter, its `index.stage3.ts` entry, the
  `"./stage3"` exports subpath, and a `tsconfig.stage3.json` + jest project (standard mode) for its
  tests/examples. Depends on DEC-043's weave hoist to avoid a divergent second implementation.

- **IDEA-14 — Type-safe positional parameter spec via variadic tuples.** Prototype the type-level mapping
  from each slot's `ConstraintDescriptor[]` to the corresponding parameter type, so a mis-typed constraint
  is a compile error (research §4.2/§8, [Low]-confidence — a genuine advantage legacy never had).

- **IDEA-15 — Supplementary HOF `contract(spec, fn)` for free functions** (research §4.6, F), which no
  decorator model can target. Fully type-safe; deferred, secondary to the class-method story.

- **Q-25 — Enumeration timing for a standalone Stage-3 `@Validate`** (construction-time via
  `addInitializer` vs legacy decoration-time). Recommend `@Contract` as documented primary installer.

- **Q-26 — Confirm the Stage-3 adapter ships descriptor-only** (no `CreateSimpleDecorator` closure escape
  hatch), so it never acquires a SMELL-14, matching the field band.

- **IDEA-16 — Shared conformance harness** implementing DEC-045 (one scenario table, two adapters).

---

## 9. Answering the brief

**Parameter-gap resolution:** a **method-level positional descriptor-list spec** on the installer
decorators (`@Validate({ params })`, `@Contract({ constructor })`), reading `ConstraintDescriptor`s and
recording them into the **same** `recordParameterConstraint` band the legacy per-parameter decorators
write — so every projection is adapter-blind. The parameter forms of `@Sensitive` and `@Telemetry` lose
the same position and fold into the same spec (`sensitive` / `telemetry` keys → the same sensitivity /
telemetry writers).

**Shipping/selection:** two adapters, `adorn` (legacy default) and `adorn/stage3`, over one shared
decorator-agnostic surface; `index.ts` not forked; `exports` map gains `"./stage3"`. `experimentalDecorators`
is a per-consumer tsconfig switch, so the two are not mixable in one build — the consumer picks by import
path + mode.

**Recommended DECISIONS:** DEC-040 (dual entry points), DEC-041 (the method-level parameter spec — the
crux), DEC-042 (`accessor` fields), DEC-043 (hoist the shared enforcement weave), DEC-044 (no `design:type`,
graceful degradation), DEC-045 (shared conformance suite). New trackers: GAP-12, IDEA-14/15/16, Q-25/26.
