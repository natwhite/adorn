# Plan: shoring up the contract offering (the constraint/contract vocabulary)

**Status:** DESIGN + prioritized roadmap. No production code, no tracker edits.
**Frame:** DEC-049 just shipped `@OneOf` + `toolSchemaForMethod`. The real-world driver (AiVoiceAgent-ts)
made LLM tool-calling the top use case. This plan rounds out the vocabulary *deliberately* — surveying
what the offering covers vs. what is missing, designing the high-value additions to buildable depth, and
folding in the deferred tool-schema items (Q-28/Q-29/Q-30, the DEC-048 "#3" deferrals).

**One empirical result up front (probed in `spike/`, then removed):** the whole compositional family
(`@ArrayOf`, `@Shape`, `@Nullable`) hangs on one question — *can a descriptor carry another descriptor as
data, given params must be JSON and a predicate is a function?* It can. A serialised item descriptor
`{kind:'number',constraint:'min',params:{min:0}}` survives `normalizeParams` untouched; `derive` rebuilds
the item predicate **once** via `constraintFromJSON` (exactly as `matches` builds its `RegExp` once); the
`schema()` hook inherits the item's own fragment; and `descriptor.toJSON()` → `constraintFromJSON`
round-trips the whole thing back to an identical enforceable descriptor. That mechanism — **DEC-050**
below — is the spine of this plan.

---

## 1. The offering today, and the gap survey

### What exists (the full current vocabulary)

| Kind | Constraints | Fragment posture |
|---|---|---|
| `number` | `min` `max` `greaterThan` `lessThan` `between` `integer` `multipleOf` | exact (`minimum`/`maximum`/`exclusive*`/`multipleOf`, `type:'integer'`) |
| `string` | `minLength` `maxLength` `notEmpty` `matches` `email` `url` | exact for lengths/`email`; `matches` under-claims on flags; `url` under-claims to `format:'uri'` |
| `generic` | `oneOf` (DEC-049) | **exact** — `{enum:[…]}`, the constrained-decoding target |
| method post | `@Returns(<descriptor>)` (projectable) · `@Ensures(closure)` (opaque) | descriptor projects a `returns` fragment; closure is enforced-but-unprojectable (SMELL-14) |
| markers (record-only) | `@Sensitive`, `@Telemetry.*` | annotate their own bands; install nothing |

Projections consuming these: `documentClass`/`schemaForClass` (descriptive under-claim, DEC-029),
`toolSchemaForMethod` (prescriptive tight, DEC-048), `@adorn/test` arbitraries (sound generation, DEC-031),
`telemetryForClass` (privacy review). Every one reads descriptor data — `constraint`/`params`/`describe()`/
`schema()`/`arbitrary()` — so a new descriptor lights up all of them at once, and cannot drift (DEC-010).

### The gaps, ranked by cost to the LLM-tool use case and general robustness

| # | Gap | Severity | Why |
|---|---|---|---|
| 1 | **No array / collection kind** | **Critical** | LLM tools constantly take `string[]`, `number[]`, `tags`, enum-arrays. There is no way to say "a list of these", at all. The single biggest hole. |
| 2 | **Optional-but-constrained param** (Q-28) | High | `required = carries ≥1 constraint` wrongly forces every constrained param required. Blocks any tool with an optional-yet-validated arg. Subtler than it looks — see §3.1: schema-only is **drift**. |
| 3 | **Per-parameter semantic descriptions** (Q-30) | High | The model reads NL meaning ("the city to look up"), not "a non-empty string". Today only the constraint prose is available. |
| 4 | **No string formats** (`uuid`, `date-time`, `ipv4`, …) | High | Ubiquitous in tool args and DTOs; `format` is under-claim-safe, cheap, and gives sound generators for free. |
| 5 | **Nested object params** (Q-29) | Medium | A tool arg that is a structured object. Needs `@Shape` + inline expansion. Reuses DEC-050. |
| 6 | **No single-literal `@Const` / nullable** | Low–Med | `{const:v}` and `type:[…,'null']` are small, common polish. |
| 7 | **No `@Default`** | Low | `{default:v}` guides the model; pairs with optionality. Annotation only. |
| 8 | **Cross-parameter contracts** (IDEA-6) | High value / hard | `start < end`, "if mode=custom then config required". Relates multiple params → not a per-position descriptor. Mostly enforcement-only; a thin structured subset projects. |

The through-line: **items 1, 5 (and nullable in 6) are all one compositional pattern**; items 2, 3, 7 are
all one record-only-marker pattern; item 4 is ordinary descriptors; item 8 is the reserved `pre` band's
first writer. So the plan is four mechanisms, not eight features.

---

## 2. DEC-050 (proposed) — the compositional-descriptor pattern (the crux)

A **compositional descriptor** is one built *over* another descriptor (or a class's field contracts). It is
the mechanism `@ArrayOf`, `@Shape`, and `@Nullable` all share, and the reason to design it once.

**The problem it solves.** `params` must be JSON-serialisable (`normalizeParams` deep-clones/freezes and
rejects functions, `RegExp`, class instances). A descriptor's `predicate` is a function; a class reference
is not JSON. So a compositional descriptor **cannot store the inner descriptor or the class** — only *data*.

**The pattern (proven in the probe):**

1. **Carry the inner as its serialised form.** The item is stored as its `SerializedConstraint`
   (`{kind, constraint, params}`) — the exact output of `descriptor.toJSON()`, which is already plain JSON
   and survives `normalizeParams` verbatim. A *stack* of item constraints is stored as `SerializedConstraint[]`.
   A `@Shape` over a class stores `{fields: {name: SerializedConstraint[]}}` — the class's field contracts,
   flattened to data at authoring time.
2. **Rebuild once, in `derive`.** `derive(params)` runs a single time at construction (`createDescriptor`).
   Inside it, `constraintFromJSON(params.item)` reconstructs the inner descriptor — predicate and all — and
   the returned closure closes over it. **No per-call rebuild** (identical to how `matchesPattern` compiles
   its `RegExp` once). The outer predicate is still *derived from params* — the serialised inner *is* the
   params — so DEC-010 holds: no drift, and the composite JSON-round-trips to an identical enforceable form.
3. **Inherit the inner fragment in `schema()`.** The outer `schema()` rebuilds the inner and calls its
   `schema()` hook, wrapping the result (`items:`, `properties.<field>:`). It inherits the inner's own
   under-claim decisions unchanged — never re-tightens or re-derives them (the same discipline
   `schema.ts` follows by reading `descriptor.schema()` rather than rebuilding from `params`).
4. **Totality (BUG-4).** The outer predicate gates the container type first (`Array.isArray` / plain-object
   check), returning `false` for `null`/`undefined`/wrong-type before touching elements.

**Layering (DEC-012):** `constraintFromJSON` lives in `Core/Descriptor`, which `Contracts/*` already import.
For multiple item constraints the fragment uses `allOf` of the rebuilt inner fragments (exact conjunction,
self-contained) rather than importing the schema projection's `mergeFragments` — Contracts stays pure.

**One caveat, stated (DEC-007 family):** `constraintFromJSON` requires the inner identity to be *registered*
(its module imported). In-process this is automatic — the inner was constructed live, so its module is
loaded. Across a fresh-process JSON round-trip, the defining module must be imported first, exactly as every
rehydration already requires.

**`ConstraintKind` (minor):** arrays/objects/nullable ride `kind:'generic'` (as `oneOf` does) — no widening
is load-bearing. Optionally widen to `'…|'array'|'object'|'boolean'` so `formatReceived` renders a violation
value honestly; cheap, do it with this wave, not a blocker.

---

## 3. Part A — the deferred tool-schema items (#3), designed concretely

These are **record-only markers**, the exact pattern of `@Sensitive`/`@Telemetry`: an own-scoped
`WeakMap` band in the registry, a decorator-agnostic `record*`/`get*` pair, wired into `resetRegistry`,
installing nothing. The projections read them. The one exception is `@Optional`, which — as designed below —
must also be honoured by enforcement, or it introduces the very drift the thesis forbids.

### 3.1 `@Optional` (Q-28) — and why "record-only" is not enough

**The naive design is drift.** `required = carries ≥1 constraint` is sound *because total predicates reject
`undefined`* (Q-7): a constrained param already throws when omitted. So if `@Optional` merely drops the param
from the tool schema's `required` list but leaves enforcement unchanged, the schema says "you may omit this"
while the installed `@Contract` **throws** when the model omits it — two artifacts from one declaration
disagreeing, the exact DEC-006 failure. Optionality therefore must be honoured on *both* sides.

**Design — an enforcement-aware marker.**

- **Records:** `parameterOptionalByTarget: WeakMap<target, Map<key, Set<index>>>` (own-scoped, index-keyed →
  minification-safe), via `recordParameterOptional(target,key,index)` / `getParameterOptional(...)`. The twin
  of the sensitivity/telemetry bands; wired into `resetRegistry`. Decorator: `@Optional()` (a bare
  `ParameterDecorator` resolving its target like `@Sensitive`).
- **Meaning: "absent, OR satisfies the constraint when present."** The enforcement installer, when building a
  param's check, consults the band and wraps it: `value === undefined ? skip : check(value)`. This is the one
  place `@Optional` reaches past record-only — but it reaches only into the *installer's* per-param check
  assembly (plain registry data in, exactly as the pre-resolved `disclose` boolean already flows into the
  message layer), never into `Contracts/`. `null` is deliberately **not** treated as absent — absence is
  `undefined`; `null` present must satisfy (or be separately `@Nullable`, §5.3).
- **Tool schema (`toolSchemaForMethod`):** `required = params with ≥1 constraint AND not @Optional`. The
  param still appears in `properties` with its full fragment (so when present it is steered).
- **Descriptive schema (`schemaForClass`):** **no change** — it never emits `required` (DEC-029), so
  `@Optional` is a no-op there. Worth stating so nobody wires it in redundantly.
- **Docs:** render an "optional" tag on the parameter row.
- **Generator (`@adorn/test`):** an optional param becomes `fc.option(paramArb, {nil: undefined})` at the
  method-composer level — sometimes present-and-valid, sometimes absent — which is exactly the two-branch
  behaviour enforcement now allows, so generation stays sound.

**Core, not edge** — it is the gate on every tool with an optional argument, and the drift analysis makes it
load-bearing rather than cosmetic. It is also the meatiest of the three markers (touches the installer),
which is why it is Q-28 and not already shipped.

### 3.2 `@Describe('…')` and `@Tool('…')` (Q-30) — semantic descriptions

Pure annotation; touches nothing but the schema/docs projections. Never rejects a value, so it is
posture-neutral (safe in both descriptive and prescriptive schemas).

- **`@Describe(text)`** — parameter marker. Records `parameterDescriptionByTarget: WeakMap<target, Map<key,
  Map<index, string>>>` via `recordParameterDescription`/`getParameterDescription`. Reset-wired.
- **`@Tool(text)`** — method marker (the `@Returns`/`@Telemetry.result()` shape: validates it is on a method,
  writes `methodDescriptionByTarget: WeakMap<target, Map<key,string>>`). It is the recorded twin of the
  existing `toolSchemaForMethod(C, m, {description})` option — the option stays as an override; `@Tool` is the
  co-located declaration.
- **Flow into the tool schema:**
  - tool-level `description` ← `options.description` ?? `@Tool` text (option wins, for call-site override).
  - per-property `description` ← `@Describe` text when present, **else omitted**. Recommendation: do *not*
    fall back to the constraint `describe()` prose ("a non-empty string") as the property description — the
    fragment keywords already encode the bound for the model, and the prose is semantically empty. `describe()`
    remains the honest *docs* rendering; `@Describe` supplies the *meaning* the model actually needs. (This is
    a slight, deliberate narrowing of DEC-048's "describe() is the free param default" — that default is
    redundant with the emitted keywords, so it is worth dropping from the tool schema rather than emitting
    noise.)
- **Docs:** `@Describe` becomes a "Description" column; `@Tool` heads the method section.
- **JSDoc stays rejected** (DEC-007, runtime-only): the meaning must be a decorator argument, erased comments
  cannot reach a runtime projection.

**Core** for tool-calling (`@Describe`), **small**. `@Tool` is trivial.

### 3.3 `@Shape(FieldClass)` (Q-29) — nested object parameters

A tool arg that is a structured object. Since param *types* are advisory (DEC-004 — `design:paramtypes`
erases to `Object`), the class **must be named explicitly**; adorn cannot infer "this param is a `WeatherQuery`".

**A compositional descriptor over another class's field contracts (DEC-050).** It is *not* a record-only
marker — it validates the object and emits a fragment — so it is a descriptor in `Contracts/object.ts`, with
the `@Shape` *decorator* doing the registry read (keeping `Contracts/` from importing enforcement concerns
beyond the registry read, which is Core and DEC-012-clean):

- **Authoring:** `@Shape(FieldClass)` calls `getFieldContractsForClass(FieldClass)`, flattens each field to
  its serialised constraints, and constructs `ObjectContracts.shape({fields: {name: SerializedConstraint[]}})`.
  **Timing caveat (DEC-007):** `FieldClass` must be fully decorated *before* the consuming class is defined
  (earlier in module order) — its field contracts are read at decoration time. State it; it is the same
  runtime-introspection ordering constraint the whole library lives under.
- **Params:** `{fields: {<name>: SerializedConstraint[]}}` — pure JSON.
- **`derive`:** rebuild each field's predicate stack once (DEC-050); predicate = plain-object gate (total:
  reject `null`/array/non-object) ∧ every field's rebuilt conjunction holds on `value[name]`.
- **`describe`:** `"an object with fields x, y, z"`.
- **`schema` (descriptive, under-claim):** `{type:'object', properties:{<name>: allOf-of-field-fragments}}`.
  **No `required`, no `additionalProperties`** — DEC-029: a field constraint bounds a value-when-assigned,
  not presence or closure. This is the honest fragment the hook emits.
- **Prescriptive tightening (`toolSchemaForMethod`):** here is the subtlety worth getting right. The hook
  can only emit *one* fragment, and the two postures want different object-closure keywords. Resolution,
  consistent with how the top level already works: **the hook emits the descriptive object; the tool
  projection tightens recursively.** `toolSchemaForMethod` already adds `required`+`additionalProperties:false`
  at the top level; extend it with a general rule — *for any property whose merged fragment is
  `{type:'object', properties}`, recurse: `additionalProperties:false`, and `required` = sub-properties whose
  fragment is non-empty (not `{}`)*. That is the identical top-level rule applied one level down, needs no
  extra data, and also descends through an array's `items`. So a `@Shape` param is inline-expanded and tight
  in the tool schema, honestly under-claimed in `schemaForClass`, with one `schema()` hook. **Never `$ref`**
  (DEC-048 — many function-calling endpoints do not resolve it); the inline duplication is the right price.
- **Generator:** `fc.record({<name>: fieldArb}, {requiredKeys})` — sound if each field arb is sound
  (recursion, again DEC-050). Optional fields → not in `requiredKeys`.

**Medium effort, medium value** — real for tool-calling but behind arrays and the markers. It is the second
consumer of DEC-050, so it lands cheaply *after* `@ArrayOf` proves the pattern.

---

## 4. Part B — `@ArrayOf`: the #1 gap and the meatiest design

`@ArrayOf(item, {minItems?, maxItems?})` — the compositional descriptor DEC-050 exists for, and the single
highest-value addition. The probe implemented and verified exactly this.

- **Kind:** `generic` (an array of whatever the item constrains).
- **Params (JSON):** `{item: SerializedConstraint, minItems?: number, maxItems?: number}`. `item` is
  `itemDescriptor.toJSON()`. (v1 = a single item descriptor — the 90% case: `string[]`, `number[]`,
  `OneOf[]`. A *stacked* item contract, `@ArrayOf([GreaterThanEqual(0), Integer()])`, stores
  `SerializedConstraint[]` and is a clean v1.1 increment.)
- **`derive` (total, BUG-4):** rebuild the item predicate once via `constraintFromJSON(params.item)`;
  return `v => Array.isArray(v) && lengthOk(v) && v.every(itemPredicate)`. Rejects `null`/`undefined`/non-array.
- **`describe`:** `` `an array of ${item.describe()}${bounds}` `` — reuses the item's own prose.
- **`schema` (exact when the item is exact, else inherits the item's under-claim):**
  `{type:'array', items:<item.schema() or {}>, minItems?, maxItems?}`. Probed output for
  `@ArrayOf(GreaterThanEqual(0), {minItems:1})`: `{"type":"array","items":{"type":"number","minimum":0},"minItems":1}`.
  If the item supplies no `schema()` hook, `items:{}` — honest floor, accept-any element. `allOf` in `items`
  for the stacked case.
- **Generator (`@adorn/test`, sound):** `case 'arrayOf'` in `arbitraryForConstraint` — rebuild the item
  descriptor, recurse (`arbitraryForConstraint`/`arbitraryForParameter`) to get `itemArb`, then
  `fc.array(itemArb, {minLength: minItems, maxLength: maxItems})`. Sound because `fc.array` of a sound
  element arb produces only valid arrays. **If the item arb *declines*** (an unknown item identity, a
  hand-written predicate), the array declines too — or, when `minItems` is 0, may still offer the empty array
  — reported honestly, never a pretence. This element-arb recursion is the add-on's crux, the twin of the
  `derive`/`schema` recursion in core.
- **Posture:** array keywords (`type:'array'`, `items`, `minItems`, `maxItems`) are disjoint from
  number/string keywords, so they coexist in `mergeFragments` with no reconciliation; `minItems`/`maxItems`
  join the tighter-bound families if two `@ArrayOf` ever stack (rare). Fits both the descriptive and
  prescriptive postures cleanly.

**Core, meaty, ships first** — it is the gap and it proves DEC-050 for the rest of the compositional family.

### 4.1 String formats — `@Uuid()` / `@DateTime()` / `@Ipv4()` (and a `@Format` escape hatch)

Ordinary `kind:'string'` descriptors — no composition. High value (uuid/date-time are everywhere in tool args)
and cheap, with **sound generators for free** from fast-check.

- **Recommendation: a small set of distinct identities**, not one generic `@Format(name)`, because the
  predicate *and* the generator differ per format and a generic form just rebuilds a mini-registry that
  duplicates `defineConstraint`. Ship `uuid`, `dateTime`, `date`, `ipv4` (email/url already exist). Keep a
  `@Format(name)` thin alias available for less-common IANA formats that emit `{type:'string', format:name}`
  as a pure annotation with a *generate-and-filter* or declined generator.
- **Descriptor (e.g. `uuid`):** predicate = total string gate ∧ a real RFC-4122 regex test;
  `describe` = "a UUID"; `schema` = `{type:'string', format:'uuid'}`.
- **The posture nuance, stated:** JSON Schema `format` is an **annotation, not an assertion** by default — a
  validator that ignores `format` accepts more than the predicate. So the fragment **under-claims**, which is
  exactly DEC-029-safe for `schemaForClass` (never falsely rejects). In the **prescriptive** tool schema the
  same `format` is a *hint the model reads and several providers honour* — so the one keyword serves both
  postures without contradiction, and the runtime predicate is the real backstop (the `url` precedent, which
  already emits `format:'uri'` while enforcing a stricter protocol allowlist). Emit `format` *and* a `pattern`
  only where the pattern is faithful and flag-free (the `email` precedent); otherwise `format` alone.
- **Generators (sound, parametric/delegation):** `uuid → fc.uuid()`; `dateTime → fc.date({noInvalidDate:true})
  .map(d => d.toISOString())`; `date → …map(d => d.toISOString().slice(0,10))`; `ipv4 → fc.ipV4()`. Each
  guarded by the descriptor's own predicate (near-free), per the add-on's soundness discipline.

**Core-ish, small.** Third in the build order.

### 4.2 `@Const(value)` and nullable

- **`@Const(value)` — is it just `@OneOf([value])`?** Semantically yes (`{enum:[v]}` ≡ `{const:v}`, predicate
  `=== v`). Recommendation: ship it as a **distinct identity** anyway, sharing the membership derivation with
  a single-member set, because it reads better in both artifacts: `describe` = "exactly `v`", `schema` =
  `{const: value}` (the natural single-literal keyword), generator = `fc.constant(value)`. It is a two-line
  addition over the enum machinery. **Edge/polish**, but nearly free.
- **Explicit nullable — `@Nullable(item)`** (compositional, DEC-050): predicate = `v === null ||
  item.predicate(v)`; `schema` merges the inner fragment's `type` into a union (`type:['string','null']`) or,
  where the inner has no single `type`, `{anyOf:[<inner>, {type:'null'}]}` — exact. Generator =
  `fc.option(itemArb, {nil: null})` — sound. This is the principled home for "may be null" (distinct from
  `@Optional`'s "may be absent"). **Edge**, small; bundle with `@Const`.

### 4.3 `@Default(value)`

`{default: value}` is a JSON Schema **annotation** (never rejects), and in a tool schema it *guides* the model
(some providers surface it). It has **no predicate**, so it is *not* a descriptor (`derive` is mandatory) — it
is a **record-only marker** (the `@Describe` shape): `recordParameterDefault`/`getParameterDefault` storing a
`JsonValue`, read by the schema/tool-schema projection to add `default` to the property fragment.

**Does it belong? Yes, but folded into optionality.** A param with a default is, by definition, optional — so
`@Default(v)` should *imply* `@Optional` (drop from `required`) *and* emit `{default:v}`. That synergy is its
whole value; shipping it standalone is lower priority. **Edge**, ships with or just after `@Optional`.

### 4.4 Cross-parameter contracts (IDEA-6) — the highest marginal value, and the hardest

`start < end`; "if mode=custom then config required". These **relate multiple parameters**, so they are *not*
a per-position descriptor and do not fit the tuple/object-property model — a `ConstraintDescriptor` tests one
value. Feasibility splits cleanly:

- **Enforcement + fuzzing: feasible now, via the reserved `pre` band.** `MethodContract.pre` has been reserved
  since P1.1 and still has no writer — this is its `@Ensures`-shaped first writer. `@Requires((args) =>
  boolean, description?)` records a **closure** into a `pre` closure-band (the exact twin of the `@Ensures`
  post closure-band), the installer checks it before `proceed()`, and the fuzzer consumes it as a whole-args
  **oracle/filter** (Phase B already does this for postconditions — the same `evaluate*` seam). Fully general;
  `start < end` works.
- **Projection: mostly *not* possible — and that is the honest verdict.** A closure carries no identity or
  params (Q-3/SMELL-14), so like `@Ensures` it is **enforced-but-unprojectable**: it emits nothing into the
  tool schema. JSON Schema also simply *cannot* express `start < end` (it has no cross-property comparison).
  What it *can* express is a narrow structured subset:
  - **`dependentRequired`** — "if `mode` is present, `config` is required" → a reified
    `@DependentRequired('config', {on:'mode'})` marker emitting `{dependentRequired:{mode:['config']}}`.
  - **`if/then`** — "if `mode` = `custom` then `config` required" → emits `{if:{properties:{mode:{const:
    'custom'}}}, then:{required:['config']}}`.
  These are *reified structured* forms (data, projectable), distinct from the general `@Requires` closure.
- **Recommendation:** ship `@Requires` (enforcement + fuzzing) as the general tool and **explicitly accept it
  does not project** — documenting the gap exactly as `@Ensures` is documented, so a `@Requires`-only method
  is never silently reported as unconstrained. The reified `dependentRequired`/`if-then` subset is a *later,
  separate, lower-ROI* item (few real tools need it, and providers vary in honouring `if/then`). **Last in the
  roadmap**; high value as *enforcement*, low as *schema*.

---

## 5. Posture reconciliation (DEC-029 descriptive vs DEC-048 prescriptive)

Which posture each new keyword belongs to, so no addition quietly reopens the under-claim/tight tension:

| Addition | `schemaForClass` (descriptive) | `toolSchemaForMethod` (prescriptive) | Fragment is |
|---|---|---|---|
| `@ArrayOf` | `{type:'array',items,minItems,maxItems}` | same + recurse-tighten object `items` | exact (item-inherited) |
| `@Const` | `{const}` | `{const}` | exact |
| `@Nullable` | `type` union / `anyOf` | same | exact |
| formats | `{type:'string',format}` | same (`format` = model hint) | under-claims (annotation-safe) |
| `@Shape` | `{type:'object',properties}` **no required/addl** | + recursive `required`+`additionalProperties:false` | descriptive; tightened by the projection |
| `@Optional` | no-op (never emits `required`) | **drops** the param from `required` | — (list modifier) + enforcement-aware |
| `@Describe`/`@Tool` | (docs only) | property/tool `description` | annotation (never rejects) |
| `@Default` | `{default}` | `{default}` + implies not-required | annotation |
| `@Requires` (closure) | nothing (unprojectable) | nothing (unprojectable) | enforcement/fuzz only |
| `dependentRequired`/`if-then` | — | structured cross-field keywords | exact subset |

The governing move throughout (DEC-048): a fragment's `schema()` hook emits the **descriptive/under-claim**
shape; the **prescriptive** posture is applied by `toolSchemaForMethod` at projection time (top-level today,
recursively into `properties`/`items` once `@Shape`/`@ArrayOf` land). One hook, two consumers, no drift.

---

## 6. Prioritized roadmap and effort

Ordered by value to the LLM-tool use case **and** general robustness, with DEC-050 front-loaded because the
compositional family depends on it.

| # | Item | Trackers | Effort | Why here |
|---|---|---|---|---|
| 1 | **`@ArrayOf`** + establish **DEC-050** | IDEA-22, GAP-15, DEC-050 | **M** | The #1 gap; proves the compositional pattern the rest reuses. Core, meaty, self-contained. |
| 2 | **`@Optional`** (enforcement-aware) + **`@Default`** | Q-28, (Q-30) | **S–M** | Closes a real drift; gate on every optional-arg tool. Touches the installer, so slightly bigger than a pure marker. |
| 3 | **`@Describe`** + **`@Tool`** | Q-30 | **S** | Pure markers; the semantic meaning the model actually reads. High value, trivial. |
| 4 | **String formats** (`@Uuid`/`@DateTime`/`@Ipv4`/`@Format`) | IDEA-23 | **S** | Ubiquitous, cheap, sound generators free, annotation-safe. |
| 5 | **`@Shape`** nested objects + recursive tool-tightening | Q-29, IDEA-25, GAP-16 | **M** | Second DEC-050 consumer; the tool-projection recursion. **Reprioritized ahead of `@Const`/`@Nullable`** — the highest-value remaining item per AiVoiceAgent-node round-2 §2 (the object shapes real tool args need). |
| 6 | **`@Const`** + **`@Nullable`** | IDEA-24 | **S (edge)** | Small polish over existing machinery. |
| 7 | **`@Requires`** cross-param (pre-band first writer) | IDEA-6, IDEA-26 | **M** | Highest marginal value as *enforcement*; unprojectable, so gated behind the schema-serving items. |
| 8 | **`dependentRequired`/`if-then`** structured subset | IDEA-6 (2nd half) | **M (defer)** | The only cross-param slice that projects; low real demand, provider-variable support. |

Recommended first wave: **1 → 2 → 3 → 4**. That is arrays + the three tool-schema deferrals + formats — which
covers essentially every tool people actually expose (primitives, enums, arrays, uuids/dates, optional args,
descriptions). 5–8 are the deliberate long tail.

**Update (2026-08, post-Wave-1):** items 1–4 are shipped (DEC-050/051/052). For the next wave, **`@Shape`
(now #5) moves ahead of `@Const`/`@Nullable` (now #6)** — AiVoiceAgent-node round-2 §2 ranks nested-object
support the single highest-value remaining contract item (an unconstrained object param projects to a
`description` with no `type`), ahead of the literal/nullable polish. `Verify.check` (DEC-053, the non-throwing
imperative entry) also landed from that round's §3.

**Update (2026-08, Wave-2 Slices 1–2 shipped):** the object vocabulary is BUILT as **two** kinds the review
(MAJOR-1) separated — **`@Dictionary`** (open `Record<string,V>`, DEC-054) and **`@Shape`** (closed DTO +
recursive tool-schema tightening, DEC-055). The consumer's `Record<string,string>` blocker is `@Dictionary`;
`@Shape` fills the general fixed-DTO GAP-16. Surface 85 → 88. **Next up: #6 `@Const` + `@Nullable`** (IDEA-24),
then `@Requires` (#7).

Every item, before merge, owes the same four things the existing built-ins do: the descriptor
(kind/params/derived-predicate/describe/schema), the schema fragment with its stated posture, a **sound**
`fast-check` generator in `addons/test/arbitraries.ts` (or an honest decline), and the public-surface count
tripwire updated (`test/public-surface.test.ts`, currently 75 — the DEC-039 deliberate-change signal).

---

## 7. Recommended trackers

Highest live before this plan: **DEC-049, IDEA-21, GAP-14, Q-30**. Proposed:

### New decisions
- **DEC-050 — Compositional descriptors carry their inner as serialised data.** A descriptor built over
  another (`@ArrayOf`, `@Shape`, `@Nullable`) stores the inner as its `SerializedConstraint` in `params`
  (JSON-safe), rebuilds predicate/schema/arbitrary from it **once** in `derive` via `constraintFromJSON`
  (predicate still derived-from-params → DEC-010, JSON-round-trips), and inherits the inner's fragment
  posture unchanged. `Contracts/` stays pure (`allOf` for multi-item fragments, no projection import).
  *(Empirically verified.)* Advances DEC-010; underpins IDEA-22/25/24.
- **DEC-051 — `@Optional` is enforcement-aware, not record-only.** To avoid schema/runtime drift under the
  `required = carries ≥1 constraint` rule, `@Optional` both drops the param from the tool schema's `required`
  **and** makes enforcement treat `undefined` as satisfying ("absent OR valid when present"). Resolves Q-28;
  advances DEC-048, DEC-006.
- *(Optional umbrella)* **DEC-052 — the shore-up vocabulary wave**: records the roadmap + the
  descriptive-hook / prescriptive-projection split extended recursively into `properties`/`items`.

### New ideas / gaps
- **IDEA-22 — `@ArrayOf(item,{minItems,maxItems})`**, the collection constraint. #1 gap. → GAP-15.
- **GAP-15 — No array/collection descriptor kind** (parallel to GAP-14's enum gap). Filled by IDEA-22.
- **IDEA-23 — String-format descriptors** (`@Uuid`/`@DateTime`/`@Date`/`@Ipv4`, + `@Format` hatch),
  `{type:'string',format}`, annotation-safe, sound generators.
- **IDEA-24 — `@Const(value)` + `@Nullable(item)`** — single-literal and null-union polish.
- **IDEA-25 — `@Shape(FieldClass)`** nested-object inline expansion (DEC-050 + registry read). → Q-29, GAP-16.
- **GAP-16 — No nested-object/compositional descriptor** (or fold into GAP-15). Filled by IDEA-25.
- **IDEA-26 — `@Requires((args)=>bool)`** cross-parameter preconditions, the reserved `pre` band's first
  writer; enforcement + fuzzing, explicitly unprojectable (the `@Ensures` trade). → IDEA-6.
- **Markers for the #3 deferrals** (record-only bands): `@Optional` (Q-28/DEC-051), `@Describe` + `@Tool`
  (Q-30), `@Default` (with Q-28).

### Existing trackers advanced
- **Q-28** (optional-but-constrained) → resolved by `@Optional`/DEC-051, with the drift analysis as the
  reason it is enforcement-aware.
- **Q-29** (nested object params) → resolved by `@Shape`/IDEA-25 (inline expansion, never `$ref`; the DEC-004
  advisory-type limiter is why the class is named explicitly).
- **Q-30** (param descriptions) → resolved by `@Describe`/`@Tool`; narrows the DEC-048 "describe() default" to
  "omit when no `@Describe`" (the keywords already carry the bound).
- **IDEA-6** (cross-parameter) → split into feasible-enforcement (IDEA-26 `@Requires`) + narrow-projectable
  (`dependentRequired`/`if-then`), with the honest "mostly unprojectable" verdict recorded.
- **Q-3 / SMELL-14** (closures unprojectable) → `@Requires` inherits and re-affirms the accepted trade.
- **Q-10** (arity) → `@Optional` is adjacent (optionality ≠ arity), and neither recovers TS `?`; note it does
  not fix arity, it declares optionality explicitly instead.
- **DEC-010 / DEC-029 / DEC-048 / DEC-031 / BUG-4** → every addition respects derived predicates, the
  under-claim vs prescriptive split, sound generation, and totality, by construction.

---

## Appendix — the crux, as verified

`spike/probe-compositional.ts` (throwaway, removed) built an `arrayOf` descriptor carrying
`GreaterThanEqual(0).toJSON()` and printed:

```
params survived + frozen: {"item":{"kind":"number","constraint":"min","params":{"min":0}},"minItems":1}
predicate [1,2,3]: true      predicate [-1]: false      predicate []: false
predicate null: false        predicate "x": false
schema: {"type":"array","items":{"type":"number","minimum":0},"minItems":1}
rehydrated predicate [5]: true      // via constraintFromJSON(arr.toJSON()) — full round-trip
```

That is DEC-050 working end to end: serialised-item params, a total predicate rebuilt once, an
item-inherited fragment, and a clean JSON round-trip — the whole compositional family stands on it.
