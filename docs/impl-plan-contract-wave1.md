# Implementation plan — contract offering, Wave 1

**Status:** BUILDABLE implementation plan. Refines `docs/plan-contract-offering.md` (the design) and
DEC-050/DEC-051 into exact files, signatures, shapes, edge cases, and tests. No production code changes
land with this doc.

**Wave 1 scope (roadmap items 1–4), depth concentrated on the two novel mechanisms:**

1. `@ArrayOf(item, {minItems?, maxItems?})` + the DEC-050 compositional mechanism — the centrepiece.
2. `@Optional` (DEC-051, enforcement-aware) + `@Default` — the drift-avoidance mechanism.
3. `@Describe('…')` + `@Tool('…')` — record-only description markers.
4. String formats (`@Uuid`/`@DateTime`/`@Ipv4` + `@Format`) → `{type:'string', format:'…'}`.

Out of scope (long tail, Wave 2+): `@Shape` nested objects, `@Const`, `@Nullable`, `@Requires`,
`dependentRequired`/`if-then`.

---

## 0. Empirical confirmation (probe run, then removed)

A throwaway `spike/probe-arrayof.ts` built an `arrayOf` descriptor against the **current** `Core`/`Contracts`
code and printed:

```
params frozen+survived: {"item":{"kind":"number","constraint":"min","params":{"min":0}},"minItems":1}
predicate [1,2,3]: true   predicate [-1]: false   predicate []: false (minItems:1)
predicate null: false     predicate undefined: false   predicate "x": false
describe: an array of a number greater than or equal to 0
schema: {"type":"array","items":{"type":"number","minimum":0},"minItems":1}
round-trip predicate [5]: true            round-trip schema equal: true
nested predicate [["a"],["b","a"]]: true  nested predicate [["a"],["z"]]: false
nested schema: {"type":"array","items":{"type":"array","items":{"enum":["a","b"]}}}
loose predicate []: true (no minItems)
```

So DEC-050 works verbatim against today's code: serialised-item params survive `normalizeParams` frozen,
the total predicate gates the container first, `schema()` inherits the item fragment, the whole thing
round-trips through `toJSON()`→`constraintFromJSON`, and nesting (array-of-array-of-enum) recurses cleanly.

**One load-bearing finding the probe forced (see §2.1):** `SerializedConstraint` is declared as an
`interface` in `Core/Descriptor.ts` (line 148), so it has **no implicit index signature** and is **not**
assignable to `JsonValue`/`JsonObject`. A descriptor that stores a serialised item in its `params`
(which must extend `JsonObject`) therefore does not type-check without a deliberate fix. This is exactly
the problem `PatternSpec` already solved in `Contracts/string.ts` by being a `type` alias.

---

## 1. What already exists (so the plan does not re-invent it)

- **`SerializedConstraint<P>`, `descriptor.toJSON()`, `constraintFromJSON(serialized)` already exist and are
  already exported** from `Core/Descriptor.ts` (lines 143–152, 253–267). DEC-050 does **not** need to add
  them. Wave 1's only Core-level question is the `interface`→`type` typing fix in §2.1; the rest is new
  `Contracts/*` descriptors, decorators, registry marker bands, and projection wiring.
- The descriptor authoring pattern to mirror: `Contracts/number.ts`, `Contracts/string.ts`,
  `Contracts/enum.ts` — a params interface, a derivation, a `defineConstraint({kind, constraint, derive,
  describe, schema})`, and an authoring factory with argument validation.
- The decorator adapter: `ParameterDecorators/Constraints.ts` wraps each descriptor with
  `constraintDecorator = ParameterDecoratorFactory.CreateConstraintDecorator`.
- The record-only marker pattern: `@Sensitive` (`src/Sensitive/Sensitive.ts`) and `@Telemetry`
  (`src/Telemetry/Telemetry.ts`) over own-scoped, index-keyed registry bands
  (`ContractRegistry.ts` §"sensitivity band" / "telemetry band"), wired into `resetRegistry`.
- The schema projection: `Projections/schema.ts` — `schemaFragmentsOf`, `mergeFragments`, `methodSchema`
  (descriptive), `toolSchemaForMethod` (prescriptive; `required` = "carries ≥1 constraint",
  `additionalProperties:false`, omits `$schema` per DEC-049), `canonicalize`/`KEY_ORDER`.
- The generator bridge: `addons/test/arbitraries.ts` — `arbitraryForConstraint` (per-kind switch),
  `arbitraryForParameter` (per-position conjunction).
- The surface tripwire: `test/public-surface.test.ts` pins **75** value exports and enumerates the internal
  registry writers.

## 1.1 Within-wave build sequence

1. **DEC-050 typing fix** (§2.1) — make `SerializedConstraint` a `type` alias. Foundational; unblocks 2.
2. **`@ArrayOf`** (§2) — `Contracts/array.ts` descriptor, `@ArrayOf` decorator, `ArrayContracts` namespace,
   `KEY_ORDER` additions, `arbitraries.ts` `arrayOf` case, tests. Proves DEC-050.
3. **Registry marker bands** (§3.1) — optional / param-description / method-description / default bands +
   writers + reads + `resetRegistry` wiring. Shared substrate for 4–6.
4. **`@Optional`** (§3) — decorator, installer skip, tool-schema `required` drop, arbitraries option-wrap.
5. **`@Default`** (§3.4) — record-only; implies optional; emits `{default}`; no runtime injection.
6. **`@Describe` / `@Tool`** (§4) — decorators, tool-schema description wiring, docs, precedence.
7. **String formats** (§5) — `Contracts/string.ts` (or `Contracts/format.ts`) descriptors, decorators,
   arbitraries cases.
8. **Surface + end-to-end** (§6) — `index.ts` exports, `public-surface.test.ts` count bump, the
   array+optional+described+formatted end-to-end tool-schema test.

---

## 2. `@ArrayOf` + DEC-050 (the crux)

### 2.1 The DEC-050 API and the one Core change

**`SerializedConstraint` — the exact type, and the fix.** Today:

```ts
// Core/Descriptor.ts (current)
export interface SerializedConstraint<P extends ConstraintParams = ConstraintParams> {
    readonly kind: ConstraintKind;
    readonly constraint: string;
    readonly params: P;
}
```

Change it to a **`type` alias** with identical members:

```ts
// Core/Descriptor.ts (proposed)
export type SerializedConstraint<P extends ConstraintParams = ConstraintParams> = {
    readonly kind: ConstraintKind;
    readonly constraint: string;
    readonly params: P;
};
```

- **Why:** an interface has no implicit index signature, so `SerializedConstraint` is not assignable to
  `JsonValue`/`JsonObject`; a compositional descriptor storing it in `params` (which must
  `extends JsonObject`) does not compile. A `type` alias whose every member type is JSON-compatible
  (`kind`/`constraint` are `string`, `params` is `P extends JsonObject`) **is** assignable to
  `JsonObject`. This is the exact precedent and rationale already recorded on `PatternSpec`
  (`Contracts/string.ts` line 70: *"A type alias rather than an interface so TypeScript gives it an
  implicit index signature and it satisfies `JsonValue`"*).
- **Compatibility:** members are unchanged, so `toJSON(): SerializedConstraint<P>` and
  `constraintFromJSON(serialized: SerializedConstraint<P>)` keep their signatures; every consumer keeps
  compiling. Pure widening, no runtime effect.
- **These stay public** (already exported from `index`? No — they are exported from `Core/Descriptor.ts`
  but **not re-exported from root `index.ts`**, and stay that way. `constraintFromJSON`/`toJSON` are Core
  primitives that `Contracts/*` import directly; they are not part of the pinned root surface count).

**`constraintFromJSON`/`toJSON` placement and interaction** (all unchanged, stated for the reviewer):
- `constraintFromJSON` lives in `Core/Descriptor.ts` and is imported by `Contracts/array.ts` — Contracts
  already import Core, so DEC-012 layering holds (no projection import, no `mergeFragments` reach).
- `toJSON()` returns `{kind, constraint, params}` where `params` is the descriptor's already
  deep-frozen clone. When that object is embedded as another descriptor's `params.item` and passed
  through `createDescriptor`→`normalizeParams`→`cloneSerializable`, it is deep-cloned and re-frozen
  again (confirmed by the probe: `params frozen+survived`). No live functions or class refs cross the
  boundary, so `normalizeParams`'s plain-JSON gate accepts it.
- `constraintFromJSON` requires the inner identity to be **registered** (its `defineConstraint` module
  imported). In-process this is automatic (the item was constructed live). The DEC-007 caveat only bites
  on a fresh-process JSON rehydrate, exactly as every rehydration already requires — state it, do not
  solve it.

### 2.2 The `arrayOf` descriptor — `src/Contracts/array.ts` (new file)

```ts
import {constraintFromJSON, defineConstraint, JsonObject, JsonValue, Predicate,
        SerializedConstraint, ConstraintDescriptor} from '../Core/Descriptor';

/** v1: a single item descriptor, carried as its serialised form. minItems/maxItems optional. */
export interface ArrayOfParams extends JsonObject {
    item: SerializedConstraint;   // assignable to JsonObject once SerializedConstraint is a type alias (§2.1)
    minItems?: number;
    maxItems?: number;
}

const arrayOfConstraint = defineConstraint<ArrayOfParams>({
    kind: 'generic',                       // arrays ride 'generic', as oneOf does (DEC-050; no widening load-bearing)
    constraint: 'arrayOf',
    derive: (params): Predicate => {
        const itemPredicate = constraintFromJSON(params.item).predicate;  // rebuilt ONCE (matches-RegExp discipline)
        const {minItems, maxItems} = params;
        return (value: unknown) => {
            if (!Array.isArray(value)) return false;                       // total (BUG-4): null/undefined/non-array → false
            if (minItems !== undefined && value.length < minItems) return false;
            if (maxItems !== undefined && value.length > maxItems) return false;
            return value.every(itemPredicate);
        };
    },
    describe: params => {
        const inner = constraintFromJSON(params.item).describe();
        const bounds = boundsPhrase(params.minItems, params.maxItems);     // "", " with at least 1 item", …
        return `an array of ${inner}${bounds}`;
    },
    schema: params => {
        const inner = constraintFromJSON(params.item);
        const items = inner.schema ? inner.schema() : {};                  // item's own under-claim inherited; {} floor
        const out: JsonObject = {type: 'array', items};
        if (params.minItems !== undefined) out.minItems = params.minItems;
        if (params.maxItems !== undefined) out.maxItems = params.maxItems;
        return out;
    },
});
```

**Authoring factory** (the `ArrayContracts.ArrayOf` descriptor form):

```ts
export function ArrayOf(
    item: ConstraintDescriptor,
    options?: {minItems?: number; maxItems?: number},
): ConstraintDescriptor<ArrayOfParams> {
    if (!item || typeof item.toJSON !== 'function' || typeof item.predicate !== 'function') {
        throw new TypeError('ArrayOf: `item` must be a ConstraintDescriptor (e.g. StringContracts.NotEmpty()).');
    }
    const min = requireCount('ArrayOf', 'minItems', options?.minItems);   // integer ≥ 0 or undefined
    const max = requireCount('ArrayOf', 'maxItems', options?.maxItems);
    if (min !== undefined && max !== undefined && min > max) {
        throw new RangeError(`ArrayOf: minItems (${min}) must not exceed maxItems (${max}).`);  // Between precedent
    }
    const params: ArrayOfParams = {item: item.toJSON()};
    if (min !== undefined) params.minItems = min;
    if (max !== undefined) params.maxItems = max;
    return arrayOfConstraint(params);
}
```

- `requireCount` rejects non-integer / negative / non-finite bounds at authoring time (mirrors
  `requireLength` in `string.ts`), so a bad bound throws with an author-facing origin, not at call time.
- **Empty array / `minItems:0`:** with no `minItems`, `[]` **passes** (probe: `loose predicate []: true`) —
  the honest reading of "an array of X". `minItems:1` rejects `[]`. `minItems:0` is allowed and equivalent
  to omitting it.
- **Nesting / recursion:** `@ArrayOf(ArrayContracts.ArrayOf(EnumContracts.OneOf(['a','b'])))` works
  (probe verified). There is **no cycle risk**: serialised data is acyclic and built bottom-up at
  authoring time; a descriptor cannot contain itself. Depth is bounded by the author's nesting — the only
  pathological case is a hand-built thousands-deep nest, which is an author error, not a runtime hazard.
- **Stacked item constraints** (`@ArrayOf([GreaterThanEqual(0), Integer()])`) are **v1.1**: `item` becomes
  `SerializedConstraint[]`, `derive` conjoins each rebuilt predicate, `schema` emits
  `items:{allOf:[…]}`. v1 ships the single-descriptor 90% case (`string[]`, `number[]`, `OneOf[]`).

### 2.3 The `@ArrayOf` decorator — `src/ParameterDecorators/Constraints.ts`

Add, mirroring the existing `OneOf` wrapper:

```ts
import * as Arrays from '../Contracts/array';
/** A list whose every element satisfies `item`. Projects to {type:'array', items:<item schema>, minItems?, maxItems?}. */
const ArrayOf = (item: ConstraintDescriptor, options?: {minItems?: number; maxItems?: number}) =>
    constraintDecorator(Arrays.ArrayOf(item, options));
```

Export `ArrayOf` from that module's `export {…}` block.

### 2.4 Schema projection touch-ups — `src/Projections/schema.ts`

The array fragment coexists with number/string keywords (disjoint), so `mergeFragments` needs **no**
reconciliation logic for the common single-`@ArrayOf` case. Two small edits for correctness:

- **`KEY_ORDER`:** insert `'minItems'`, `'maxItems'` immediately after `'items'`, and `'default'` after
  `'format'`. Without this, `minItems`/`maxItems`/`default` sort to the alphabetical tail, producing an
  unstable/ugly canonical order (`items` before `type`, etc.). `items` and `format` are already present.
- **`combineKeyword` (only if two `@ArrayOf` ever stack on one position — rare):** add `'minItems'` to
  `LOWER_BOUND_KEYWORDS` (tighter = higher) and `'maxItems'` to `UPPER_BOUND_KEYWORDS` (tighter = lower).
  This is a one-line-each addition; skippable in v1 with a note (two stacked array constraints fall back
  to `allOf`, which is exact).

No change to `methodSchema`/`toolSchemaForMethod` is needed for arrays themselves — they read
`descriptor.schema()` through `schemaFragmentsOf` and get the array fragment for free. (Recursive
object-tightening into `items` is a `@Shape` concern, Wave 2.)

### 2.5 The arbitrary — `addons/test/arbitraries.ts`

Add a `case 'arrayOf'` to `arbitraryForConstraint`, recursing on the item's own generator:

```ts
case 'arrayOf': {
    const p = descriptor.params as {item: SerializedConstraint; minItems?: number; maxItems?: number};
    const item = arbitraryForConstraint(constraintFromJSON(p.item));   // recurse — the add-on crux
    const opts: {minLength?: number; maxLength?: number} = {};
    if (p.minItems !== undefined) opts.minLength = p.minItems;
    if (p.maxItems !== undefined) opts.maxLength = p.maxItems;
    if (item.strategy === 'declined' || !item.arbitrary) {
        // Item cannot be generated. If the empty array is admissible, still offer it; else decline.
        if ((p.minItems ?? 0) === 0) {
            return {strategy: 'parametric', arbitrary: fc.constant([]), constraint: 'arrayOf',
                    note: 'item arbitrary declined; only the empty array is generated'};
        }
        return {strategy: 'declined', arbitrary: null, constraint: 'arrayOf',
                note: 'item arbitrary declined and a non-empty array is required'};
    }
    return {strategy: 'parametric',
            arbitrary: fc.array(item.arbitrary, opts).filter(descriptor.predicate),  // guard: sound by construction
            constraint: 'arrayOf', note: `fc.array over ${item.strategy} item arbitrary`};
}
```

- Import `constraintFromJSON`, `SerializedConstraint` from `../../src/Core/Descriptor`.
- **Soundness:** `fc.array` of a sound element arbitrary produces only valid arrays; the `.filter` guard is
  near-free and pins the invariant (identical discipline to `multipleOf`/`matches`). The recursion is the
  generation twin of `derive`/`schema`'s recursion — DEC-031's ideal.
- **Honest decline:** if the item declines (unknown identity / hand-written predicate), the array declines
  too — except when the empty array satisfies the bounds, then it offers `fc.constant([])` and says so.

---

## 3. `@Optional` (DEC-051) + `@Default`

### 3.1 The registry marker bands — `src/Core/ContractRegistry.ts`

Four new own-scoped, index-keyed bands, twins of the sensitivity/telemetry bands. All record-only; **none**
install anything or touch an enforcement band.

```ts
let parameterOptionalByTarget    = new WeakMap<ContractTarget, Map<MethodKey, Set<number>>>();
let parameterDescriptionByTarget = new WeakMap<ContractTarget, Map<MethodKey, Map<number, string>>>();
let methodDescriptionByTarget    = new WeakMap<ContractTarget, Map<MethodKey, string>>();
let parameterDefaultByTarget     = new WeakMap<ContractTarget, Map<MethodKey, Map<number, JsonValue>>>();
```

**Writers** (each validates target + index like `recordParameterSensitivity`):

```ts
export function recordParameterOptional(target, key: MethodKey, index: number): void
export function recordParameterDescription(target, key: MethodKey, index: number, text: string): void
export function recordMethodDescription(target, key: MethodKey, text: string): void
export function recordParameterDefault(target, key: MethodKey, index: number, value: JsonValue): void
```

**Reads** (own-scoped + inheritance-aware, twins of the telemetry reads — kept **internal**, i.e. **not**
re-exported from root `index.ts`, exactly as `getParameterSensitivity`/`getParameterTelemetry` are):

```ts
export function getParameterOptional(target, key, index): boolean            // own
export function getEffectiveParameterOptional(target, key, index): boolean   // "marked anywhere on chain" ⇒ true
export function getParameterDescription(target, key, index): string | undefined
export function getEffectiveParameterDescription(target, key, index): string | undefined  // nearest-wins
export function getMethodDescription(target, key): string | undefined
export function getEffectiveMethodDescription(target, key): string | undefined            // nearest-wins
export function getParameterDefault(target, key, index): JsonValue | undefined
export function getEffectiveParameterDefault(target, key, index): JsonValue | undefined    // nearest-wins
```

**Wire all four into `resetRegistry()`** (reassign to fresh `WeakMap`s), alongside the existing bands.

**Inheritance resolution rule (state it — the reviewer will probe it):** these markers resolve like the
telemetry marking, **not** like a conjoined precondition. `@Optional` uses the *over-marking* rule
("optional anywhere on the chain ⇒ optional", `getEffectiveParameterOptional`), matching how
`@Sensitive` over-marks; `@Describe`/`@Tool`/`@Default` use *nearest-declaration-wins*. This is a
deliberate departure from DEC-022's precondition conjunction — optionality is a **weakening**, and
conjoining weakenings is meaningless. See the edge-case note in §6.4.

### 3.2 The `@Optional` decorator — `src/Markers/Optional.ts` (new; or fold into a small markers module)

A bare `ParameterDecorator` resolving its target from argument shape, mirroring `@Sensitive`'s parameter
branch (including the constructor-parameter `propertyKey === undefined` handling):

```ts
export function Optional(): (target: object, propertyKey?: MethodKey, parameterIndex?: number) => void {
    return function (target, propertyKey, parameterIndex) {
        if (typeof parameterIndex !== 'number') {
            throw new TypeError('@Optional() must be applied to a parameter.');
        }
        const key = propertyKey ?? CONSTRUCTOR_PARAMETERS;   // same symbol trick as @Sensitive
        recordParameterOptional(target, key, parameterIndex);
    };
}
```

### 3.3 The EXACT installer change — `src/Adapters/legacy/ParameterDecoratorFactory.ts`

`@Optional` reaches past record-only into **only** the installer's per-parameter check assembly — plain
registry data in, exactly as the pre-resolved `sensitive` boolean already flows in — never into
`Contracts/`. The change is localized to `planChecks`, inside the existing
`for (const index of ordered)` loop, and does **not** disturb the positional param-check plan:

```ts
// once per position, resolved at install time (walks the prototype chain, mirroring isParameterSensitive)
const optional = isParameterOptional(target, propertyKey, index);
const guard: (c: PlannedCheck) => PlannedCheck = optional
    ? (check) => (args) => { if (args[index] === undefined) return; check(args); }   // absent ⇒ satisfied
    : (check) => check;

// existing descriptor-check push, now wrapped:
for (const constraint of parameter.constraints) {
    plan.push(guard(descriptorCheck(constraint, index, signatureFor, paramNames, sensitive, typeName)));
}
// existing staged-check push, also wrapped (so @Optional gates hand-written closures on the same position too):
for (const check of atIndex) {
    plan.push(guard(args => check.decorator(paramObjectFor(index, args))));
}
```

with the helper (twin of `isParameterSensitive`):

```ts
function isParameterOptional(target: object, key: MethodKey, index: number): boolean {
    for (let c: object | null = target; c !== null; c = Object.getPrototypeOf(c)) {
        if (getParameterOptional(c, key, index)) return true;
    }
    return false;
}
```

**Semantics, precisely:** "**absent, OR satisfies the constraint when present.**" The guard skips the
position's checks **iff `args[index] === undefined`**. `null` is **not** absent — a present `null` runs the
checks and (against a total predicate) is rejected, unless separately `@Nullable` (Wave 2). This wraps the
**whole position** (all stacked constraints together), so an optional-but-constrained param is either
wholly skipped (absent) or wholly checked (present) — no partial-satisfaction ambiguity.

### 3.4 `@Default(value)` — `src/Markers/Default.ts` (new)

- **Record-only marker**, the `@Describe` shape (no predicate → not a descriptor). A `ParameterDecorator`
  that stores a `JsonValue` via `recordParameterDefault(target, key, index, value)`.
- **A default implies optionality**, and that synergy is its whole value: `@Default` **also** calls
  `recordParameterOptional(target, key, index)`, so both the installer (skip-when-absent) and the tool
  schema (drop from `required`) treat a defaulted param as optional from the one declaration.
- **adorn does NOT inject the default at runtime — decided, and stated.** `@Default` annotates; the
  caller/framework applies the default. Injecting would be hidden argument mutation: it would rewrite the
  `args` tuple that enforcement, `@Observe`, and postconditions all see, turning a record-only marker into
  a behaviour change — precisely what the marker bands forbid. So at runtime an absent defaulted param is
  simply skipped by the `@Optional` mechanism and the method sees whatever JS/the framework supplies.
- **Authoring validation:** reject a non-JSON `value` (reuse the `isJsonPrimitive`/serialisable check
  spirit) so the emitted `{default}` is always valid JSON.

### 3.5 Projection wiring for `@Optional`/`@Default`

**`toolSchemaForMethod` (prescriptive)** — the only projection that changes. Inside the `params.forEach`:

```ts
const fragment = mergeFragments(schemaFragmentsOf(parameter.constraints));
const desc = getEffectiveParameterDescription(entry.target, method, parameter.index);
if (typeof desc === 'string') fragment.description = desc;                 // §4
const def = getEffectiveParameterDefault(entry.target, method, parameter.index);
if (def !== undefined) fragment.default = def;
properties[name] = fragment;

const optional = getEffectiveParameterOptional(entry.target, method, parameter.index);
if (parameter.constraints.length > 0 && !optional) required.push(name);   // ← the DEC-051 change
```

(`entry.target` is the `ClassMethodContract.target` — the prototype for instance methods, the constructor
for statics — the correct object to read markers from; the `getEffective*` reads walk its chain.)

**`schemaForClass` (descriptive)** — **no change.** It never emits `required` (DEC-029), so `@Optional`
is a no-op there. Stated explicitly so nobody wires it in redundantly. `@Default`'s `{default}` and
`@Describe`'s `description` are annotation-safe and *could* be added to the descriptive method
`prefixItems`, but that is deferred (safe, additive, low value); v1 wires the markers into the **tool**
schema and docs only. Their absence from `schemaForClass` under-claims nothing (annotations never reject).

**Arbitrary (`addons/test`)** — `@Optional` is a marker, not a kind, so it is handled at the **method-level
composer** (the caller of `arbitraryForParameter`, in `addons/test`), not in `arbitraryForConstraint`. The
composer reads the optional band and wraps an optional position's arbitrary as
`fc.option(paramArb, {nil: undefined})` — sometimes present-and-valid, sometimes `undefined` — which is
exactly the two-branch behaviour the installer now allows, so generation stays sound.

---

## 4. `@Describe('…')` + `@Tool('…')`

Pure annotation; never rejects a value, so posture-neutral (safe in both schema postures).

### 4.1 `@Describe(text)` — parameter marker (`src/Markers/Describe.ts`)

`ParameterDecorator` (argument-shape resolution like `@Sensitive`), records via
`recordParameterDescription(target, key, index, text)`. Validates a non-empty string argument.

### 4.2 `@Tool(text)` — method marker (`src/Markers/Tool.ts`)

`MethodDecorator` that validates it is on a method (the `@Returns`/`@Telemetry.result()` shape: throw if
`descriptor.value` is not a function), records via `recordMethodDescription(target, key, text)`. It is the
recorded twin of the existing `toolSchemaForMethod(C, m, {description})` option.

### 4.3 Flow into the tool schema (`toolSchemaForMethod`)

- **Tool-level `description`** ← `options.description` **??** `getEffectiveMethodDescription(entry.target,
  method)`. The **call-site option wins** (an override point); `@Tool` is the co-located default. Emitted
  only when one is present (adorn is runtime-only — no JSDoc source, DEC-007).

  ```ts
  const toolDesc = (options && typeof options.description === 'string')
      ? options.description
      : getEffectiveMethodDescription(entry.target, method);
  if (typeof toolDesc === 'string') document.description = toolDesc;   // replaces the current options-only block
  ```

- **Per-property `description`** ← `@Describe` text when present, **else omitted** (see §3.5 snippet).

**Precedence — `@Describe` vs the descriptor's own `describe()`:** the property description is `@Describe`
text or nothing. It **does not** fall back to the constraint `describe()` prose ("a non-empty string").
This is a deliberate, stated narrowing of DEC-048's "`describe()` is the free param default": the emitted
fragment keywords (`minLength`, `enum`, `format`, …) already encode the bound the model needs, so the prose
is semantically redundant there, while `@Describe` supplies the *meaning* ("the city to look up") the model
actually reads. `describe()` remains the honest **docs** rendering; it is not duplicated into the tool
schema as noise.

### 4.4 Flow into docs (`Projections/docs.ts`)

Additive model fields (optional to ship in v1, recommended for completeness):
- `ParameterDoc.description?: string` ← `getEffectiveParameterDescription(...)`; rendered as a
  "Description" column, and an "optional" tag when `getEffectiveParameterOptional(...)` is true.
- `MethodDoc.description?: string` ← `getEffectiveMethodDescription(...)`; heads the method section.

These touch the docs *model* types, so if the wave is scoped tight, docs wiring can trail the schema
wiring by a follow-up — the schema + enforcement changes are the load-bearing ones. **JSDoc stays
rejected** (DEC-007): meaning must be a decorator argument, not an erased comment.

---

## 5. String formats

### 5.1 Recommendation: distinct validating identities, plus a keyed `@Format`

Ship a small set of **distinct `kind:'string'` identities** (not one generic mini-registry), because the
predicate *and* the generator differ per format: `@Uuid`, `@DateTime`, `@Ipv4` (email/url already exist).
Provide `@Format(name)` as a **keyed alias** over that same set. Descriptor factories live in
`Contracts/string.ts` (or a new `Contracts/format.ts` re-exported through `StringContracts`), so they ride
the already-exported `StringContracts` namespace — **no new descriptor namespace export**.

### 5.2 VALIDATE vs ANNOTATE — the decision, and the named drift

**Decision: the named formats VALIDATE.** Each descriptor's predicate is `typeof value === 'string'` **∧**
a real check (RFC-4122 regex for uuid, ISO-8601 parse for date-time, dotted-quad parse for ipv4). The
`schema()` fragment is `{type:'string', format:'<name>'}`.

- The `format` keyword is an **annotation, not an assertion** in JSON Schema by default, so the fragment
  **under-claims**: a validator that ignores `format` accepts a superset of what the predicate accepts —
  DEC-029-safe for `schemaForClass` (never a false rejection). In the **prescriptive** tool schema the same
  `format` is a hint the model reads and several providers honour, with the runtime predicate as the real
  backstop. One keyword serves both postures — the exact `url → format:'uri'` precedent
  (`Contracts/string.ts` line 256), which already enforces stricter than it publishes.
- Emit a `pattern` **alongside** `format` only where the pattern is faithful and flag-free (the `email`
  precedent). For uuid, a flag-free anchored pattern is faithful, so `{type:'string', format:'uuid',
  pattern:'^[0-9a-fA-F-]{36}$'}`-style is acceptable; for date-time, prefer `format` alone (the full
  ISO-8601 grammar is not a clean single pattern).

**The named drift the plan must own:** an **annotate-only** format (schema says `format:X`, runtime checks
only "is a string") would make enforcement *weaker* than the published format, so a validator treating
`format` as an assertion would reject strings enforcement accepts — an **over-claim in the descriptive
schema**, the one direction DEC-029 forbids. Therefore:

- **`@Uuid`/`@DateTime`/`@Ipv4` validate** — no drift; the `format` under-claim is safe in both postures.
- **`@Format(name)` accepts only the known, validating identities and refuses an unknown name loudly at
  decoration time** (the `@Telemetry.redact` precedent — an unbuilt/unknown strategy throws rather than
  silently doing the wrong thing). So `@Format('uuid') ≡ @Uuid()`, and `@Format('int32')` throws.
- **Annotate-only IANA formats are explicitly deferred** (a later, opt-in, *prescriptive-only* feature),
  because emitting an unbacked `format` into the descriptive schema is the over-claim above. This is the
  drift the design names and refuses to ship in Wave 1.

### 5.3 Descriptor shapes (e.g. uuid)

```ts
export const uuidConstraint = defineConstraint<JsonObject>({
    kind: 'string', constraint: 'uuid',
    derive: () => (v: unknown) => typeof v === 'string' && UUID_RE.test(v),
    describe: () => 'a UUID',
    schema: () => ({type: 'string', format: 'uuid'}),
});
export function Uuid() { return uuidConstraint({}); }
// dateTime → format:'date-time', ISO-8601 parse predicate;  ipv4 → format:'ipv4', dotted-quad predicate.
```

Naming note: **avoid a bare `@Date`** — it shadows the global `Date`. Ship `@DateTime` in v1; a date-only
variant, if wanted, is `@DateOnly`/`@IsoDate` (deferred).

### 5.4 Decorators + arbitraries

- Decorators in `ParameterDecorators/Constraints.ts`: `Uuid`, `DateTime`, `Ipv4`, `Format(name)`, each
  wrapping the descriptor via `constraintDecorator`.
- `addons/test/arbitraries.ts` cases (each guarded by the descriptor's own predicate, near-free):

  ```ts
  case 'uuid':     return parametric('uuid', fc.uuid());
  case 'ipv4':     return parametric('ipv4', fc.ipV4());
  case 'dateTime': return {strategy:'delegation', constraint:'dateTime',
      arbitrary: fc.date({noInvalidDate:true}).map(d => d.toISOString()).filter(descriptor.predicate),
      note:'fc.date().map(toISOString), guarded'};
  ```

  Sound by construction (fast-check's `uuid`/`ipV4`/`date` produce only valid values); the `.filter` pins it.

---

## 6. Consolidated

### 6.1 Exact new `index.ts` exports and the pinned count

New **value** exports (each a deliberate DEC-039 surface-change signal):

| Export | Kind | Source |
|---|---|---|
| `ArrayOf` | parameter decorator | `ParameterDecorators/Constraints.ts` |
| `Optional` | parameter decorator | `Markers/Optional.ts` |
| `Default` | parameter decorator | `Markers/Default.ts` |
| `Describe` | parameter decorator | `Markers/Describe.ts` |
| `Tool` | method decorator | `Markers/Tool.ts` |
| `Uuid` | parameter decorator | `ParameterDecorators/Constraints.ts` |
| `DateTime` | parameter decorator | `ParameterDecorators/Constraints.ts` |
| `Ipv4` | parameter decorator | `ParameterDecorators/Constraints.ts` |
| `Format` | parameter decorator | `ParameterDecorators/Constraints.ts` |
| `ArrayContracts` | descriptor namespace | `Contracts/array.ts` (`import * as ArrayContracts`) |

- Format descriptor factories (`Uuid`/`DateTime`/`Ipv4`) are added to the **existing** `StringContracts`
  namespace — **not** new top-level exports.
- **Count: 75 → 85 (+10).** Update `PINNED_VALUE_EXPORT_COUNT` in `test/public-surface.test.ts` to `85`
  **in the same commit**, with a comment naming the ten. Type-only exports (e.g. `ArrayOfParams`) do not
  count.
- **Trim option:** dropping the `@Format` keyed alias (redundant with the three named decorators) yields
  **84 (+9)**. Recommended to keep `@Format` for the string-keyed ergonomics; flagged so the count is a
  conscious choice.
- **`public-surface.test.ts` also gains internal writers:** add `recordParameterOptional`,
  `recordParameterDescription`, `recordMethodDescription`, `recordParameterDefault` to
  `INTERNAL_REGISTRY_WRITERS` (they are `export function` in the registry and must stay off the root
  surface, exactly as the sensitivity/telemetry writers are).

### 6.2 Tests per feature

**DEC-050 / `@ArrayOf`** (`test/contracts-array.test.ts`, `addons/test/arbitraries.test.ts`,
`test/schema.test.ts`):
- `params` survive `normalizeParams` frozen; `toJSON()`→`constraintFromJSON` round-trips to an identical
  enforceable + identical-schema descriptor.
- Predicate totality: rejects `null`/`undefined`/non-array/wrong-item; accepts valid; `minItems`/`maxItems`
  bounds (incl. `[]` passes with no bound, fails with `minItems:1`).
- `schema()` inheritance: `@ArrayOf(GreaterThanEqual(0),{minItems:1})` →
  `{type:'array',items:{type:'number',minimum:0},minItems:1}`; item with no `schema()` hook → `items:{}`.
- Nesting: array-of-array-of-`OneOf` predicate + schema.
- Arbitrary soundness: every generated array satisfies `descriptor.predicate` (`fc.assert`); item-declines
  → array declines (or `[]` when `minItems:0`).
- Authoring guards: non-descriptor item, negative/non-integer bounds, `minItems > maxItems` all throw.

**`@Optional` / `@Default`** (`test/optional.test.ts`):
- Enforcement: absent (`undefined`) arg on an `@Optional @GreaterThanEqual(1) days` → **no throw**; present
  invalid (`0`) → throws; present valid → passes; present `null` → throws (null ≠ absent).
- Stacked constraints on the optional position are all skipped when absent, all checked when present.
- `toolSchemaForMethod`: the optional param appears in `properties` but is **absent from `required`**;
  a non-optional constrained sibling stays in `required`.
- `schemaForClass`: unchanged (no `required` emitted) — an explicit no-op assertion.
- Inheritance: base `@Optional` honoured for an undecorated subclass override (`getEffectiveParameterOptional`).
- `@Default`: `properties.<p>.default === value`; the param is dropped from `required`; **runtime args are
  not mutated** (a spy on the method sees `undefined`, not the default, when the arg is omitted).
- Arbitrary: an optional position generates both present-valid and `undefined` (via `fc.option`).

**`@Describe` / `@Tool`** (`test/describe-tool.test.ts`):
- `toolSchemaForMethod`: per-property `description` present iff `@Describe`; **no** fallback to
  `describe()` prose when absent; tool-level `description` = `options.description ?? @Tool text` (option
  wins when both present).
- `@Tool` on a non-method throws; `@Describe` on a non-parameter throws.
- Docs (if shipped): parameter Description column + optional tag; `@Tool` heads the method section.

**String formats** (`test/formats.test.ts`, `addons/test/arbitraries.test.ts`):
- Predicate validates (uuid/date-time/ipv4 accept/reject samples); non-string → false (total).
- `schema()` → `{type:'string', format:'<name>'}` (+ `pattern` for uuid); under-claim asserted (a value the
  predicate rejects that a format-ignoring validator would accept — documents the direction).
- `@Format('uuid')` ≡ `@Uuid()`; `@Format('bogus')` throws at decoration.
- Arbitrary soundness for each format.

### 6.3 The end-to-end tool-schema test (array + optional + described + formatted)

`test/tool-schema-e2e.test.ts` — one method exercising all four features, asserting the **exact** emitted
schema **and** that enforcement agrees:

```ts
@Contract()
class Weather {
    @Tool('Look up a forecast')
    lookup(
        @ArrayOf(StringContracts.NotEmpty(), {minItems: 1}) tags: string[],
        @Optional() @GreaterThanEqual(1)                    days: number,
        @Describe('The city to look up') @NotEmpty()        city: string,
        @Uuid()                                             requestId: string,
    ) {}
}
```

Expected `toolSchemaForMethod(Weather, 'lookup')` (property keys alphabetised by `canonicalize`; `required`
array in param-index order; `$schema` omitted per DEC-049):

```json
{
  "title": "Weather.lookup",
  "description": "Look up a forecast",
  "type": "object",
  "properties": {
    "city":      { "description": "The city to look up", "type": "string", "minLength": 1 },
    "days":      { "type": "number", "minimum": 1 },
    "requestId": { "type": "string", "format": "uuid" },
    "tags":      { "type": "array", "items": { "type": "string", "minLength": 1 }, "minItems": 1 }
  },
  "required": ["tags", "city", "requestId"],
  "additionalProperties": false
}
```

Enforcement-agreement half (same class, installed `@Contract`):
- `lookup(['x'], undefined, 'NYC', <uuid>)` → OK (`days` absent, optional).
- `lookup([], 5, 'NYC', <uuid>)` → throws (`tags` violates `minItems:1`).
- `lookup(['x'], 0, 'NYC', <uuid>)` → throws (`days` present, violates `minimum:1`).
- `lookup(['x'], 2, '', <uuid>)` → throws (`city` empty).
- `lookup(['x'], 2, 'NYC', 'not-a-uuid')` → throws (`requestId` not a uuid).

This is the executable no-drift pin: every value the schema marks invalid is one the installed contract
throws on, and the one value the schema marks omittable (`days`) is one enforcement accepts absent.

### 6.4 Risks & edge cases (the adversarial-review surface)

1. **DEC-050 round-trip fidelity / the `interface`→`type` fix.** The whole family compiles only after
   `SerializedConstraint` becomes a `type` alias (§2.1) — empirically forced by the probe (`TS2411`/`TS2322`).
   If a reviewer rejects changing Core, the fallback is to type `params.item` as `JsonObject` and cast to
   `SerializedConstraint` at the two `constraintFromJSON` call sites (probe-verified to work at runtime) —
   uglier, zero Core change. Recommended path is the type alias (matches `PatternSpec`, makes the whole
   compositional family clean). Cross-process rehydration still requires the item's module imported
   (DEC-007) — inherent, stated, not solved.
2. **`@Optional` × positional-plan interaction.** The guard wraps the **whole position** and skips **iff
   `args[index] === undefined`**; `null` is not absent; stacked constraints skip/run together. It lives in
   `planChecks` only, leaving `Contracts/` untouched and the `descriptorCheck`/staged-check machinery
   intact. Sharp corner: **inheritance semantics of optionality.** Optional is resolved *over-marking*
   (`getEffectiveParameterOptional`: marked anywhere ⇒ optional), which propagates a base's optionality
   down to subclasses and means a subclass **cannot** re-tighten an inherited-optional param to required.
   That is a *weakening that flows downward*, the mirror image of DEC-022's *strengthening-only* for
   constraints — an intentional asymmetry the plan states rather than hides. (If a reviewer wants
   optionality to be own-scoped/nearest-wins instead, the only change is `getParameterOptional` vs
   `getEffectiveParameterOptional` at the two read sites; flagged as the one open policy knob.)
3. **`@Default` non-injection.** adorn annotates, never injects — no hidden `args` mutation. A reviewer
   expecting runtime defaulting is answered: injection would corrupt the args tuple enforcement/observation
   see, violating the record-only-marker contract. The default reaches the caller only via the schema/the
   framework.
4. **Format annotate-vs-validate drift.** Named formats validate (no drift; `format` under-claims safely).
   `@Format` refuses unknown names loudly (no silent over-claim). Annotate-only IANA formats are deferred
   precisely because emitting an unbacked `format` into the **descriptive** schema is the DEC-029 over-claim.
   This is the one place the design says "not yet, and here is exactly why."
5. **Recursion / nesting.** No cycles are possible (serialised data is acyclic, built bottom-up); depth is
   author-bounded; the predicate rebuilds each level's item predicate **once** in `derive`, not per call.
   Pathological hand-built deep nesting is an author error, not a runtime hazard.
6. **Canonicalization stability.** `minItems`/`maxItems`/`default` must be added to `KEY_ORDER` or
   regenerated schemas produce spurious diffs (they'd sort to the alphabetical tail). One-line fix, easy to
   forget — called out.
7. **Surface growth.** +10 (75→85), or +9 (84) without `@Format`. Each export is a deliberate,
   semver-relevant DEC-039 signal; the pinned count and the internal-writers list both move in the same
   commit. No incidental leakage: the new registry *reads* stay internal (like the sensitivity/telemetry
   reads), only the four writers join `INTERNAL_REGISTRY_WRITERS`.
8. **Marker reads keyed to `entry.target`.** `toolSchemaForMethod` reads markers from the
   `ClassMethodContract.target` via `getEffective*` (chain-walking) reads, so inherited methods and
   statics resolve their markers correctly — the same object the contract itself resolved from.

---

## 7. Trackers this plan realises (no tracker edits made here)

DEC-050 (compositional descriptors), DEC-051 (`@Optional` enforcement-aware), advancing DEC-048/049
(tool-schema postures), DEC-010 (derived predicates), DEC-029 (descriptive under-claim), DEC-012
(decorator-agnostic Core/Contracts), DEC-031 (sound generation), BUG-4 (totality); IDEA-22/GAP-15
(arrays), IDEA-23 (formats), Q-28 (`@Optional`), Q-30 (`@Describe`/`@Tool`).

---

## Adversarial review

Reviewer: adversarial pass before build. Scope: `docs/impl-plan-contract-wave1.md` against the actual
code in `src/Core/Descriptor.ts`, `src/Contracts/*`, `src/Projections/schema.ts`,
`src/Core/ContractRegistry.ts`, `src/Adapters/legacy/{ParameterDecoratorFactory,ContractInstaller}.ts`,
`addons/test/{arbitraries,oracle,index}.ts`, `index.ts`, `test/public-surface.test.ts`. Two claims were
probed empirically against today's code (spike removed after).

**Verdict: BUILDABLE-WITH-FIXES.** The centrepiece (DEC-050 + the `interface`→`type` fix) is sound and
was confirmed by probe. But `@Describe`/`@Tool` (roadmap item 3) is under-built and will NPE for its
headline case; the `@Optional` inheritance policy is the wrong safety direction and its "one-knob"
escape hatch is understated; and the `@DateTime` predicate is under-specified in a way that reopens the
exact DEC-029 over-claim §5.2 forbids. None of these touch the crux, so no rework — but S1–S3 must be
resolved before item 3/4 ship.

### Empirically confirmed (probe run, then removed)

- **DEC-050 round-trip holds, including the cases §0's probe did not show.** A `matches`
  (RegExp/`PatternSpec`) item and a nested `arrayOf(arrayOf(oneOf))` both survive
  `toJSON()`→`JSON`→`constraintFromJSON` with identical predicate **and** identical `schema()`
  (`{"type":"array","items":{"type":"string","pattern":"^a+$"},"minItems":1}`; nested
  `items:{items:{enum:[…]}}`). `params.item` comes back deep-frozen. The `cloneSerializable` recursion
  in `normalizeParams` handles the nested `{source,flags}` object cleanly. **The crux is real.**
- **The `interface`→`type` fix (§2.1) is correctly diagnosed.** With `SerializedConstraint` an
  `interface`, `item: SerializedConstraint` in a `JsonObject`-extending params fails to compile with
  exactly **`TS2411` and `TS2322`** (as §6.4 pt 1 claims). A local `type`-alias mirror compiles and
  runs. No `extends`/`implements`/declaration-merging depends on it (grep-confirmed: only uses are
  `toJSON`'s return, `constraintFromJSON`'s param, and one `Descriptor.test.ts` literal), so the change
  is pure widening. **Not a blocker; the fallback cast is unnecessary — take the type alias.**
- **Closure-item rejection is handled.** A `CreateSimpleDecorator` closure is an
  `AdornParameterDecoratorFn`, not a descriptor; the `ArrayOf` factory's `typeof item.toJSON !==
  'function'` guard rejects it loudly at authoring (confirmed: a closure has no `toJSON`). SMELL-14
  does not leak in silently.

### BLOCKER

None. The novel mechanism works as claimed.

### SIGNIFICANT

**S1 — `@Describe`/`@Tool` are structurally invisible to `toolSchemaForMethod`, and `@Tool` will NPE
for its headline case.** `toolSchemaForMethod` pivots entirely on the contract band: it looks up
`entry = getContractsForClass(C).filter(key===method)[0]`, iterates params only `if (entry)`, and the
plan's §3.5/§4.3 wiring reads every marker off `entry.target`. But the four new bands
(optional/description/method-description/default) are keyed **independently** of `contractsByTarget`,
exactly as the sensitivity/telemetry bands are. **Probe result:** a class whose method carries no
parameter *constraint* yields `getContractsForClass(...).length === 0` — so `entry` is `undefined`.
Two concrete failures:
  - *Failure A (NPE, headline case).* `@Tool('Get the time') now(): string {}` — a tool with a
    description and no constrained params. `entry` is `undefined`, so the proposed
    `getEffectiveMethodDescription(entry.target, method)` throws `TypeError: cannot read 'target' of
    undefined`. The current code returns an empty schema here without throwing (probe-confirmed), so the
    plan's line *introduces* the crash.
  - *Failure B (silent drop).* `@Describe('the city') city: string` with no constraint on `city`, on a
    method that has *some other* constrained param: `city` never enters `entry.contract.params` (nothing
    records a param entry for it — `captureSignature` only names positions when an own contract already
    exists), so its `@Describe` is silently omitted from `properties`. The description the model is meant
    to read simply vanishes.

  This is the same "a marked position with no constraint must still appear" problem the **telemetry
  band already solved** — see `getTelemetryMethodKeysForClass` / `getTelemetryParameterIndices` and
  their registry comments (ContractRegistry.ts ~1462–1501), built precisely so a value that leaves the
  process is not dropped from a projection just because it carries no *constraint*. The plan reuses none
  of it.
  *Resolution (CLEAR):* resolve the marker-read target from the class (`C.prototype` for instance,
  `C` for static) rather than from a possibly-absent `entry`; and union the marker bands' method keys /
  parameter indices into `toolSchemaForMethod`'s iteration, mirroring the telemetry-band helpers. Add a
  test for a `@Tool`-only, zero-constraint method and a `@Describe`-only unconstrained param.

**S2 — `@Optional` inheritance picks the *unsafe* direction, and the "one-knob" escape is understated.**
The plan resolves optionality by *over-marking* (`getEffectiveParameterOptional`: marked anywhere on the
chain ⇒ optional), justified as "the mirror of DEC-022 / like `@Sensitive`." The analogy is backwards on
the safety argument. `@Sensitive` over-marks because *more* marking is *safer* (a spurious mark costs
nothing — DEC-PII-1). `@Optional` over-marking does the opposite: it *removes* a check and *drops* a
`required` entry, and it propagates that downward so a subclass **cannot re-require** an
inherited-optional param.
  - *Failure scenario.* A base library declares `handle(@Optional() @NotEmpty() name)`. A downstream
    subclass overrides `handle` and genuinely needs `name` (its stricter rule). Over-marking makes this
    inexpressible: enforcement skips `name` when absent, and `toolSchemaForMethod(Subclass,'handle')`
    omits `name` from `required`, so an LLM may omit it and the subclass runs with `name === undefined`
    **unchecked**. That is precisely the "enforce less than the artifact implies, silently" failure
    DEC-016 exists to reject — the opposite of the safe direction the over-marking analogy assumes.
  - *The escape hatch is understated.* §6.4 pt 2 says switching to own/nearest-wins is "the only change
    is `getParameterOptional` vs `getEffectiveParameterOptional` at the two read sites." Two problems:
    (a) the proposed band is a `Set<number>` (presence ⇒ optional), which **cannot express** "explicitly
    required here," so nearest-wins can't actually let a subclass re-require without a tri-state
    (boolean band, or a separate `@Required()` marker); (b) enforcement and schema **must** use the
    identical resolution or they drift (DEC-006) — but the installer helper `isParameterOptional` as
    written hard-walks the chain (over-mark), so flipping only the schema read silently desynchronises
    enforcement from the tool schema. Both read paths must move together.
  *Resolution (AMBIGUOUS — human call, but I lean own/nearest):* given DEC-016, the safe default is that
  optionality does **not** silently flow down into a subclass that would otherwise require the value.
  Recommend own-scoped-or-nearest-wins with a boolean band (so re-require is expressible), and pin
  enforcement + schema to the *same* helper. If over-marking is kept deliberately, state the DEC-016
  tension explicitly (it is the reverse of `@Sensitive`'s) rather than presenting it as the same move.

**S3 — the `@DateTime` predicate is under-specified in the one way that reopens the DEC-029 over-claim.**
§5.2 correctly refuses annotate-only formats because emitting an unbacked `format` into the *descriptive*
schema would reject strings enforcement accepts. But §5.3 pins the `@DateTime` predicate only as an
"ISO-8601 parse," and the arbitrary uses `fc.date().map(d => d.toISOString())`. If the predicate is
implemented with `Date.parse`/`new Date(v)` (the obvious reading of "parse"), it accepts a **superset**
of RFC-3339 `date-time` — e.g. `Date.parse('2020')`, `'Wed Jul 29 2026'` succeed. Then the emitted
`{type:'string', format:'date-time'}`, under a validator that *asserts* `format`, rejects `'2020'` while
the predicate accepts it — an **over-claim in the descriptive schema**, the exact direction §5.2 forbids,
now shipped by a validating format rather than an annotate-only one.
  *Resolution (CLEAR):* the predicate must be **at least as strict** as the `format` it emits — use a
  strict RFC-3339 regex (and a real octet-range check for `@Ipv4`), not `Date.parse`. Add an
  over-claim-direction test per format: assert a value the predicate *rejects* that a format-ignoring
  validator would accept (the safe under-claim), and assert there is **no** value the predicate accepts
  that the strict `format` rejects.

### MINOR

**M1 — `@Default` emits an unbacked behavioural default into the *prescriptive* schema.** The plan emits
`{default: value}` but does not inject at runtime (§3.4). In JSON Schema `default` is a non-asserting
annotation, so this never causes a false rejection — but the *tool* schema is prescriptive, and a
provider that lets the model omit a defaulted, non-required property expects the default applied
somewhere. For `days?: number` with no JS default, the method sees `undefined` while the schema promised
the value. This is the same "unbacked keyword in the emitted schema" shape §5.2 refuses for annotate-only
formats, applied to `@Default` — an inconsistency the plan does not reconcile. *Resolution (AMBIGUOUS):*
either document `@Default` as annotation-only (the framework/JS default applies it) *and* note the
parallel to the format stance, or scope `@Default` to pair with a real runtime default. At minimum, say
why the format over-claim argument does not apply here.

**M2 — the `@Optional` arbitrary wiring is asserted but not located.** §3.5 says the "method-level
composer" wraps an optional position in `fc.option(paramArb, {nil: undefined})`. That composer is
`buildCoverage` in `addons/test/oracle.ts`; it builds `ParameterArbitrary` from `entry.contract.params`
and has no optional concept today. It must read the optional band — which is kept off the root surface,
so the add-on has to import it from `src/Core/ContractRegistry` (it already reaches into `src/` for
`ClassFieldContract` etc., so this is fine, but the plan doesn't say it). Unspecified edges: a
`gap-fill`/`null`-arbitrary optional position (nothing to wrap), and an *optional + declined-generator*
position (today a declined position declines the whole method — but an optional one could just always
pass `undefined`). Name these or a fuzzing run will decline methods it could cover.

**M3 — installer guard placement.** §3.3's `guard` must be computed at the top of the
`for (const index of ordered)` loop (above `if (parameter)`), since it wraps both the descriptor push
*and* the staged-check push; the current code computes `sensitive`/`typeName` *inside* `if (parameter)`,
so a naive paste leaves the staged-only-position guard undefined. Also confirm (it holds): the guard is
per-position and only short-circuits its own index, so it does **not** change which violation other
positions report. Verified against `planChecks`.

**M4 — surface test completeness.** The +10 count (75→85) is correct and non-overlapping
(`Uuid`/`DateTime`/`Ipv4` factories ride the existing `StringContracts` namespace object, adding no root
export). But `public-surface.test.ts` also has a per-feature "these exact exports landed" block
(currently for the DEC-048 trio); the plan bumps the count and the writers list but doesn't add the
analogous presence assertions for the ten. Add them so the count move is pinned to *these* symbols, not
just a number.

### Confirmed sound (not findings — flagged so effort is not spent re-litigating them)

- `KEY_ORDER` additions as specified (`minItems`/`maxItems` after `items`, `default` after `format`)
  produce the e2e's exact canonical order; `description`(5) already sorts before `type`(6), matching the
  expected `{description,type,minLength}`.
- `@ArrayOf` arbitrary is sound: `fc.array(soundItem,{minLength,maxLength}).filter(predicate)` produces
  only valid arrays; `minItems`/`maxItems`→length bounds is exact (DEC-031); item-decline handling
  (offer `[]` iff `minItems:0`, else decline) is correct.
- `@Optional` `undefined`-only absence test is defensible for JSON/tool args (an omitted property maps to
  absent; explicit `null` is a present value the total predicates reject — correct until `@Nullable`).
- `uuid`/`date-time`/`ipv4` are all valid draft-2020-12 format names; the loose optional `uuid` pattern
  under-claims safely.
