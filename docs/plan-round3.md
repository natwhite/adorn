# Round-3 feedback — implementation plan (design only)

Scope: the six buildable round-3 items plus the sequencing of GAP-17. Grounded in the code as it
stands at `a613fa8`. **Design only** — nothing here is implemented. Proposed decision ids (DEC-059…)
are suggestions for the reviewer; the latest shipped decision is DEC-058.

Naming key for the slices below: **A** GAP-22, **B** IDEA-28, **C** GAP-19, **D** IDEA-30,
**E** GAP-20, **F** GAP-21, **G** IDEA-31, **H** GAP-17 (sequenced, not detailed).

Surface fact used throughout: `test/public-surface.test.ts:159` pins `PINNED_VALUE_EXPORT_COUNT = 94`
and asserts `Object.keys(adorn).toHaveLength(94)` (line 162). **Type-only exports erase at runtime and
do not count** (stated at `public-surface.test.ts:116`). Only one slice (D) moves the number.

---

## 1. IDEA-28 + GAP-22 — a phantom OUTPUT type on descriptors (adoption-flipper #1)

### 1.1 The problem, in the current code

`Verify.check<T>` binds `T` to the **input**:

```ts
// src/Validation/Verify.ts:136
static check<T>(constraint: ConstraintDescriptor, keyName: string | symbol, value: T): CheckResult<T>
```

At a boundary the value is `unknown`, so `T = unknown` and `r.value` comes back `unknown` — the
consumer re-casts. `ConstraintDescriptor` already carries **one** type param, the params `P`
(`src/Core/Descriptor.ts:125`), threaded as `ConstraintDescriptor<ArrayOfParams>` etc. throughout.
The descriptor knows nothing about the type it *accepts/produces*.

### 1.2 Mechanism decision — a SECOND defaulted type param **plus** a phantom property

A bare second type param is not enough: TypeScript treats an **unused** type parameter as bivariant,
so `Descriptor<P, string>` and `Descriptor<P, number>` would be mutually assignable and no narrowing
survives. So bake in the exact shape the consumer proved (round-3 §2): a defaulted `Out` param **and**
a phantom property that references it in a covariant (return) position.

```ts
// src/Core/Descriptor.ts — ConstraintDescriptor (currently line 125)
export interface ConstraintDescriptor<P extends ConstraintParams = ConstraintParams, Out = unknown> {
    // …all existing members unchanged…
    /**
     * Phantom output tag (IDEA-28). Type-level ONLY — never assigned at runtime, so
     * `'__out' in descriptor` is false, `Object.keys`/`JSON.stringify`/spread/freeze are unaffected.
     * The `(value: never) => Out` form carries `Out` covariantly, so a `Descriptor<P, string>` is
     * assignable to a `Descriptor<P, unknown>` (widening still works) but not the reverse.
     */
    readonly __out?: (value: never) => Out;
}
```

Rejected alternatives: a standalone exported `TypedConstraint<T>` alias (forces a second public name a
consumer must learn and the factories must return — more surface, not less); a phantom property with no
second param (can't be named by a consumer writing `Descriptor<P, string>`). The chosen form is exactly
what compiled clean in consumer-land under `strict` + `exactOptionalPropertyTypes` +
`noUncheckedIndexedAccess` (IDEA-28 note).

Thread `Out` through the factory plumbing so definitions can fix it **without a cast** where the output
is static:

```ts
// src/Core/Descriptor.ts:190 — ConstraintFactory
export interface ConstraintFactory<P extends ConstraintParams = ConstraintParams, Out = unknown> {
    (params: P): ConstraintDescriptor<P, Out>;
    readonly definition: ConstraintDefinition<P>;
}

// src/Core/Descriptor.ts:216 — defineConstraint (2nd defaulted type param; body unchanged)
export function defineConstraint<P extends ConstraintParams = ConstraintParams, Out = unknown>(
    definition: ConstraintDefinition<P>,
): ConstraintFactory<P, Out> {
    // …unchanged… the existing `as ConstraintFactory<P>` at line 241 widens to `as ConstraintFactory<P, Out>`.
}
```

`SerializedConstraint<P>` (line 159) and `ConstraintDefinition<P>` (line 172) are **not** touched —
`Out` is a property of an *applied* descriptor, not of the wire form or the rule.

### 1.3 Threading `Out` — the primitives (no cast) and the four compositional constructors (one cast each)

**Primitives / enum-with-fixed-Out — fix `Out` at definition time, zero casts.** Every numeric
descriptor produces a `number`, every string descriptor a `string`:

```ts
// src/Contracts/number.ts:242 — one representative; same edit on max/greaterThan/lessThan/between/integer/multipleOf
export const minConstraint = defineConstraint<MinParams, number>({ /* body unchanged */ });
// src/Contracts/number.ts:341 — factory return annotation made explicit (was inferred)
export function GreaterThanEqual(min: number): ConstraintDescriptor<MinParams, number> {
    return minConstraint({min: requireFiniteNumber('GreaterThanEqual', 'min', min)});
}
```

```ts
// src/Contracts/string.ts:249 etc. — each string descriptor fixes Out = string
export const minLengthConstraint = defineConstraint<MinLengthParams, string>({ /* unchanged */ });
export function MinLength(minLength: number): ConstraintDescriptor<MinLengthParams, string> { /* unchanged */ }
```

Because `minConstraint` is now `ConstraintFactory<MinParams, number>`, the factory body already returns
`ConstraintDescriptor<MinParams, number>` — the explicit return annotation type-checks with **no `as`**.

**`OneOf`/`Const` — the member type is per-call, so cast once** (the member set is `T`, unknown at
definition time):

```ts
// src/Contracts/enum.ts:131
export function OneOf<T extends JsonValue>(values: T[]): ConstraintDescriptor<OneOfParams, T> {
    // …existing validation unchanged…
    return oneOfConstraint({values: values.slice()}) as ConstraintDescriptor<OneOfParams, T>;
}
// src/Contracts/enum.ts:181
export function Const<T extends JsonValue>(value: T): ConstraintDescriptor<ConstParams, T> {
    // …unchanged… return constConstraint({value}) as ConstraintDescriptor<ConstParams, T>;
}
```

**The four compositional constructors — thread the inner `V`, cast once** (the current explicit return
annotations at `object.ts:87`, `array.ts:169`, `nullable.ts:65`, `object.ts:166` are widened to carry
`Out`):

```ts
// src/Contracts/object.ts:87  (Dictionary)
export function Dictionary<V>(
    value: ConstraintDescriptor<ConstraintParams, V>,
): ConstraintDescriptor<DictionaryParams, Record<string, V>> {
    // …existing runtime-guard + value.toJSON() unchanged…
    return dictionaryConstraint({value: value.toJSON()}) as ConstraintDescriptor<DictionaryParams, Record<string, V>>;
}

// src/Contracts/array.ts:169  (ArrayOf)
export function ArrayOf<V>(
    item: ConstraintDescriptor<ConstraintParams, V>,
    options?: {minItems?: number; maxItems?: number},
): ConstraintDescriptor<ArrayOfParams, V[]> {
    // …unchanged… return arrayOfConstraint(params) as ConstraintDescriptor<ArrayOfParams, V[]>;
}

// src/Contracts/nullable.ts:65  (Nullable)
export function Nullable<V>(
    item: ConstraintDescriptor<ConstraintParams, V>,
): ConstraintDescriptor<NullableParams, V | null> {
    // …unchanged… return nullableConstraint({item: item.toJSON()}) as ConstraintDescriptor<NullableParams, V | null>;
}

// src/Contracts/object.ts:166  (Shape) — see the open question in §7 about T's fidelity
export function Shape<T = unknown>(
    fieldClass: (abstract new (...args: any[]) => T) | Function,
): ConstraintDescriptor<ShapeParams, T> {
    // …unchanged… return shapeConstraint({fields}) as ConstraintDescriptor<ShapeParams, T>;
}
```

The single `as` per compositional wrapper is honest: the phantom is erased, the runtime object is
byte-identical, and the cast only *tags* the already-correct value with its output type. This is the
same "single `as`" the consumer proof carried, moved to the library so the consumer carries none.

### 1.4 `Verify.check` / `Verify.that` — bind `T` to OUTPUT

```ts
// src/Validation/Verify.ts:99
static that<T>(constraint: ConstraintDescriptor<ConstraintParams, T>, keyName: string | symbol, value: unknown): T {
    if (constraint.predicate(value)) return value as T;   // the single cast, right after predicate === true
    // …error construction unchanged…
}
// src/Validation/Verify.ts:136
static check<T>(
    constraint: ConstraintDescriptor<ConstraintParams, T>,
    keyName: string | symbol,
    value: unknown,
): CheckResult<T> {
    if (constraint.predicate(value)) return {ok: true, value: value as T};
    // …ok:false arm unchanged (plus the GAP-19 `path`, see §2)…
}
```

`T` now infers from the **constraint's `Out`**, not the input: `Verify.check(Dictionary(NotEmpty()), 'x', body)`
→ `NotEmpty` Out `string` → `Dictionary` Out `Record<string, string>` → `r.value: Record<string, string>`.
The `value` parameter becomes `unknown` because that is what the predicate honestly accepts.

Knock-on: the two dead helpers `Verify.lessThanEqual`/`greaterThanEqual` (`Verify.ts:163,172`; dead per
SMELL-8) currently declare `<T>(keyName, value: T, …): T`. `Verify.that(LessThanEqual(max), …)` now
returns `number`, so those helpers change to `(keyName: string | symbol, value: unknown, max: number): number`.
No callers exist, so this is free.

### 1.5 GAP-22 — export the `ConstraintDescriptor` **type**

`ConstraintDescriptor` is the declared parameter type of `@Dictionary`/`@ArrayOf`/`@Nullable`
(`Contracts/object.ts:87`, `array.ts:169`, `nullable.ts:65`) yet appears **0 times** in
`dist/index.d.ts` — a consumer cannot name what they must pass, and cannot name `Descriptor<P, Out>`
for IDEA-28. Add a type-only export to `index.ts` (near the other `export type` lines, e.g. beside
`CheckResult` at `index.ts:44`):

```ts
export type {ConstraintDescriptor, ConstraintParams} from './src/Core/Descriptor';
```

`ConstraintParams` is included so a consumer can spell the defaulted first arg when writing
`ConstraintDescriptor<ConstraintParams, string>`. **Type-only → value count stays 94.** This gates
IDEA-28's consumer-facing benefit (the export is what lets the consumer *name* the narrowed type), so
A sequences before the consumer sees any value from B — though B's internal edits do not depend on it.

### 1.6 Additive / no-break argument (for §7's reviewer)

- Every existing `ConstraintDescriptor<SomeParams>` becomes `<SomeParams, unknown>` via the default —
  no site respells. Same for bare `ConstraintDescriptor` (= `<ConstraintParams, unknown>`).
- `__out?` is **optional and never set at runtime**; `createDescriptor` (`Descriptor.ts:297`) is
  untouched, the frozen object is identical, so no runtime and no serialization change.
- Variance holds where it must: the parameter/field adapters accept a bare `ConstraintDescriptor`
  (`ParameterDecoratorFactory.CreateConstraintDecorator`, `ParameterDecoratorFactory.ts:170`;
  `CreateFieldDecorator`). A `Descriptor<MinParams, number>` is assignable to
  `Descriptor<ConstraintParams, unknown>` — `P` is covariant (appears only in `readonly params`/`toJSON`
  return), `Out` is covariant via the `(v: never) => Out` phantom — so every newly-typed descriptor still
  flows into those factories unchanged.
- The only value-visible change is `Verify.check`/`that`'s inferred return; runtime output (value,
  message, `constraint`, `kind`) is identical.

---

## 2. GAP-19 — a failing-key `path` on a compositional `Verify.check` failure (adoption-flipper #2)

### 2.1 The lost information

`Predicate` returns bare `boolean` (`Descriptor.ts:72`) and `message()` renders from `params` only, so
`Dictionary`/`Shape`/`ArrayOf` collapse a per-key failure to one string. The failing key/index is known
*inside* the `every`:

- `isDictionary` — `Object.keys(value).every(key => valuePredicate(value[key]))` (`object.ts:59`)
- `isShape` — `fieldPredicates.every(([name, predicates]) => predicates.every(p => p(value[name])))` (`object.ts:120`)
- `isArrayOf` — `value.every(itemPredicate)` (`array.ts:92`)
- `isNullable` — `value === null || itemPredicate(value)` (`nullable.ts:32`)

### 2.2 Decision — a **full recursive** path, via an optional `locate` hook

Shallow (first level only) would report `["slotInput"]` for a bad `slotInput.when`; the consumer needs
`["slotInput", "when"]`. So **full recursion**: each compositional descriptor delegates into its inner
descriptor's `locate`, and a nested `@Shape`-inside-`@Dictionary` yields the deep path. This is achieved
without any new machinery beyond one optional hook that mirrors `schema`/`arbitrary` exactly
(`Descriptor.ts:139-145`, wired at `Descriptor.ts:313-326`).

**Descriptor.ts additions** (both optional → additive; `Predicate`/DEC-010 untouched):

```ts
type LocatePath = ReadonlyArray<string | number>;

// on ConstraintDescriptor (beside `schema?` at line 141)
readonly locate?: (value: unknown) => LocatePath | undefined;

// on ConstraintDefinition (beside `schema?` at line 183)
readonly locate?: (params: Readonly<P>) => (value: unknown) => LocatePath | undefined;
```

Wire it in `createDescriptor`, mirroring the `schemaOf` block (`Descriptor.ts:320-326`) so the inner
predicates are rebuilt **once per descriptor**, not per call:

```ts
const locateOf = definition.locate;
if (locateOf) {
    Object.defineProperty(descriptor, 'locate', {value: locateOf(params), enumerable: true});
}
```

**Contract of `locate`:** it is called by `Verify.check` **only after the predicate has already returned
false**. It returns the path to the first failing **sub-location**, or `undefined` when the failure is at
this value's own level (the container gate / a length bound) — there the top-level `describe()` already
says everything and there is no key to point at. Primitives supply no `locate` (absent), so
`'locate' in descriptor` is an honest "can this failure be localized?".

### 2.3 The four implementations (each supplied as the definition's `locate`)

Iteration order in each matches the corresponding `every`/`some`, so `locate` reports the **same
first failure** enforcement does.

```ts
// object.ts — dictionaryConstraint.locate
locate: params => {
    const inner = constraintFromJSON(params.value);        // rebuilt ONCE, like derive
    const pred = inner.predicate;
    const deeper = inner.locate;
    return value => {
        if (!isPlainObjectValue(value)) return undefined;   // container gate → root, no sub-path
        for (const key of Object.keys(value)) {             // same order as isDictionary's every
            if (!pred(value[key])) {
                const sub = deeper ? deeper(value[key]) : undefined;
                return sub ? [key, ...sub] : [key];
            }
        }
        return undefined;
    };
}

// object.ts — shapeConstraint.locate
locate: params => {
    const fields = Object.keys(params.fields).map(
        name => [name, params.fields[name].map(s => constraintFromJSON(s))] as const,
    );
    return value => {
        if (!isPlainObjectValue(value)) return undefined;
        for (const [name, descriptors] of fields) {         // same order as isShape's outer every
            for (const d of descriptors) {                  // same order as the inner every (the stack)
                if (!d.predicate(value[name])) {
                    const sub = d.locate ? d.locate(value[name]) : undefined;
                    return sub ? [name, ...sub] : [name];    // stack index is NOT a path segment (same field)
                }
            }
        }
        return undefined;
    };
}

// array.ts — arrayOfConstraint.locate
locate: params => {
    const inner = constraintFromJSON(params.item);
    const pred = inner.predicate;
    const deeper = inner.locate;
    const {minItems, maxItems} = params;
    return value => {
        if (!Array.isArray(value)) return undefined;                       // container gate → root
        if (minItems !== undefined && value.length < minItems) return undefined;  // length → root
        if (maxItems !== undefined && value.length > maxItems) return undefined;
        for (let i = 0; i < value.length; i++) {            // same order as isArrayOf's every
            if (!pred(value[i])) {
                const sub = deeper ? deeper(value[i]) : undefined;
                return sub ? [i, ...sub] : [i];
            }
        }
        return undefined;
    };
}

// nullable.ts — nullableConstraint.locate  (transparent: adds NO segment of its own)
locate: params => {
    const inner = constraintFromJSON(params.item);
    const pred = inner.predicate;
    const deeper = inner.locate;
    return value => {
        if (value === null || pred(value)) return undefined; // passes
        return deeper ? deeper(value) : undefined;           // delegate — a Nullable(Dictionary(...)) points inside
    };
}
```

### 2.4 `Verify.check` populates `path`

`CheckResult`'s `ok:false` arm (`Verify.ts:82-89`) gains one optional field — additive, exactly like the
existing optional `schema`/`arbitrary` posture:

```ts
| {
      readonly ok: false;
      readonly message: string;
      readonly constraint: string;
      readonly kind: ConstraintKind;
      readonly path?: ReadonlyArray<string | number>;   // NEW — the first failing key/index chain
  };
```

```ts
// Verify.ts check(), the ok:false arm
const path = constraint.locate ? constraint.locate(value) : undefined;
return {
    ok: false,
    message: constraint.message({ /* unchanged */ }),
    constraint: constraint.constraint,
    kind: constraint.kind,
    ...(path && path.length > 0 ? {path} : {}),   // present only when a meaningful sub-path exists
};
```

Additive, no `Predicate`/DEC-010 change (the predicate is untouched; `locate` is a *separate* re-walk
that only runs on the failure path, once). `Verify.that` is left unchanged — a thrown error has no place
to carry a structured path today; that belongs with the future `ContractViolation` (BUG-19 note), out of
scope here.

---

## 3. IDEA-30 — a descriptor-first `toolSchemaFrom({name?, description?, params})`

### 3.1 Why it is only an envelope

`ArrayContracts.ArrayOf(EnumContracts.OneOf([...roster]))` already yields a `.schema()` fragment **and** a
`Verify.check` validator today (IDEA-27/§5). What is missing is the class-free wrapper that turns named
descriptors into the same `{type:'object', properties, required, additionalProperties:false}` envelope
`toolSchemaForMethod` emits — so a **per-session** enum (members unknown at module load) projects without
a decorated class.

### 3.2 Clean reuse, not a fork

`toolSchemaForMethod` builds each property with exactly these module-internal helpers, all of which stay
**unchanged**: `mergeFragments(schemaFragmentsOf(constraints))` (`schema.ts:354`), then `tightenObjects`
(`schema.ts:368`), then `canonicalize` (`schema.ts:398`). The per-parameter `description`/`default`
handling is `schema.ts:358-364`. `toolSchemaFrom` lives in **the same file** (`src/Projections/schema.ts`),
so it reaches those helpers directly — no exporting, no re-implementation of the DEC-029 merge (which is
the only thing DEC-010 forbids forking). The **only** new code is the envelope loop, which is inherent:
`toolSchemaForMethod` sources names/markers from the registry; `toolSchemaFrom` sources them from its
argument. Factor the 4 shared annotation lines into a tiny helper both call:

```ts
function applyParamAnnotations(fragment: JsonObject, description?: string, def?: JsonValue): void {
    if (typeof description === 'string') fragment.description = description;
    if (def !== undefined) fragment.default = def;
}
```

### 3.3 Signature and `required` semantics

`required` **mirrors the method rule** (`schema.ts:375`, DEC-048): a param carrying ≥1 constraint, minus a
way to mark it optional. Here every listed param *has* a descriptor (≥1 constraint by construction), so
`required` = "present and not marked optional". The params-map shape therefore carries the `@Optional` /
`@Describe` / `@Default` equivalents inline (mirroring the three effective reads the method version does
at `schema.ts:359/363/374`):

```ts
// src/Projections/schema.ts — new public types + function
export interface ToolParamSpec {
    /** One descriptor, or a stack conjoined exactly as stacked param decorators are (mergeFragments). */
    readonly descriptor: ConstraintDescriptor | ReadonlyArray<ConstraintDescriptor>;
    readonly optional?: boolean;       // @Optional equivalent — drops it from `required`, stays in `properties`
    readonly description?: string;     // @Describe equivalent — the property's `description`
    readonly default?: JsonValue;      // @Default equivalent — non-asserting {default}
}

export interface ToolSchemaFromInput {
    readonly name?: string;            // → `title` when present
    readonly description?: string;     // → top-level `description` when present
    readonly params: {readonly [paramName: string]: ConstraintDescriptor | ToolParamSpec};
}

export function toolSchemaFrom(input: ToolSchemaFromInput): ToolSchema {
    const properties: JsonObject = {};
    const required: string[] = [];
    for (const paramName of Object.keys(input.params)) {
        const spec = normalizeSpec(input.params[paramName]);              // bare descriptor → {descriptor}
        const descriptors = Array.isArray(spec.descriptor) ? spec.descriptor : [spec.descriptor];
        const fragment = mergeFragments(schemaFragmentsOf(descriptors));  // REUSED unchanged
        applyParamAnnotations(fragment, spec.description, spec.default);
        properties[paramName] = tightenObjects(fragment);                 // REUSED unchanged
        if (!spec.optional) required.push(paramName);
    }
    const document: JsonObject = {type: 'object', properties, required, additionalProperties: false};
    if (typeof input.name === 'string') document.title = input.name;
    if (typeof input.description === 'string') document.description = input.description;
    return canonicalize(document) as ToolSchema;                          // REUSED unchanged
}
```

Property/key order and `additionalProperties:false` come out identical to `toolSchemaForMethod` because
the same `tightenObjects`/`canonicalize` run. `ToolSchema` is the existing type alias (`schema.ts:140`).

### 3.4 Surface impact — the one slice that moves the count

`toolSchemaFrom` is a **new public value export** (add to the `schema` import group at `index.ts:126-128`
and the export block at `index.ts:352-358`). `ToolSchemaFromInput`/`ToolParamSpec` are **type-only**
(add beside the `ClassSchema`/`ToolSchema` type export at `index.ts:149`). So:

```
94 → 95   (only `toolSchemaFrom` is a value)
```

Update `public-surface.test.ts:159` to `PINNED_VALUE_EXPORT_COUNT = 95` in the same commit, add a
comment stanza in the same style as the existing ones ("94 → 95: IDEA-30 adds the descriptor-first
`toolSchemaFrom` entry point; `ToolSchemaFromInput`/`ToolParamSpec` are type-only"), and add a
`describe(...)` asserting `typeof toolSchemaFrom === 'function'` (mirroring the existing per-wave blocks).

---

## 4. GAP-20 — a decoration-time diagnostic for an unsatisfiable stacked constraint

### 4.1 The trap

`@ArrayOf(X) @OneOf(ROSTER)` conjoins two flat param decorators on one position. Predicate: array **and**
`=== ROSTER-member` → always false, `[]` included. Schema (via `mergeFragments`, `schema.ts:556`): `type`
and `enum` are disjoint keywords, so they coexist into a plausible-but-unsatisfiable
`{type:'array', enum:[…strings], items:…}`. The wrong spelling is the more natural one; the correct form
pushes the enum *inside* the container: `@ArrayOf(EnumContracts.OneOf(ROSTER))`.

### 4.2 The detectable case (undecidable in general — scope tightly)

The crisp, false-positive-free case: **a container-`type` fragment (`type` ∈ {`'array'`,`'object'`})
stacked with an `enum`/`const` whose members are all type-disjoint from that container.** This is
*always* decidable for `@OneOf`/`@Const` because their members are validated to be JSON **primitives** at
construction (`enum.ts:99 isJsonPrimitive`, enforced in `OneOf`/`Const`), and a primitive is never an
array or an object. So: **any `@OneOf`/`@Const` stacked with any `@ArrayOf`/`@Dictionary`/`@Shape` on the
same parameter is unsatisfiable** — no member could satisfy the container gate. (The symmetric
primitive-vs-enum case, e.g. `{type:'number'}` ∧ `enum:['a']`, is also detectable but out of scope;
container-vs-enum is the natural wrong spelling round-3 names.)

Detection reads only descriptor `schema()` fragments — pure, no decorator knowledge:

```
for each parameter's effective constraint stack:
    fragments = stack.map(d => d.schema?.()).filter(Boolean)
    containerTypes = fragments.filter(f => f.type === 'array' || f.type === 'object')
    memberSets    = fragments.filter(f => 'enum' in f || 'const' in f)
    if containerTypes.length and memberSets.length:  → warn (every member is a primitive ⊄ container)
```

### 4.3 Where it fires — **install time**, report-only

It **cannot** fire at decoration time: each `CreateConstraintDecorator` callback
(`ParameterDecoratorFactory.ts:178`) sees only its own constraint; the full per-parameter stack does not
exist until every param decorator has recorded and `@Contract()` runs (the same ordering the
missing-`@Contract` diagnostic is built around — `ContractDiagnostics.ts` module header). So the check
fires from the installer, per contracted method, at the deterministic class-evaluation point:

- Hook site: `installMethod(host, key, trust)` in `ContractInstaller.ts:309` (it already resolves the
  method and calls `buildParameterEnforcement` at line 321). Iterate `getEffectiveContract(host, key).params`,
  run §4.2 on each param's `constraints`, and on a hit call `reportDiagnostic(...)`
  (`ContractDiagnostics.ts:191`) — the existing sink that is already dev-mode-gated (`diagnosticsActive`)
  and guarded so a diagnostic never becomes the failure it reports.
- The message names `Class.method` parameter `name`, the two colliding constraint identities
  (`arrayOf` + `oneOf`), and the fix (`@ArrayOf(EnumContracts.OneOf([...]))`).

Placement of the pure analyzer: a small internal helper (e.g. `detectUnsatisfiableStack(constraints)`
returning the offending identity pair or `undefined`) can live in `schema.ts` beside the merge logic it
reasons about, or in a new `src/Adapters/legacy/` diagnostics helper; the **emission** stays in
`ContractDiagnostics`. No public export — surface unchanged.

---

## 5. GAP-21 — `Enforce.*` statics for the new descriptor kinds

`src/FieldDecorators/Enforce.ts` has 13 primitive statics, each `CreateFieldDecorator(<descriptor>)`
(e.g. `Enforce.greaterThan`, `Enforce.ts:78`). The pattern is one line per constraint; the descriptors
already exist. Add the ten missing kinds, importing the namespaces the file does not yet pull in.

```ts
// new imports at the top of Enforce.ts (it already has Numbers, Strings)
import type {ConstraintDescriptor, JsonValue} from '../Core/Descriptor';
import * as Enums from '../Contracts/enum';
import * as Arrays from '../Contracts/array';
import * as Objects from '../Contracts/object';
import * as Nullables from '../Contracts/nullable';

// new statics on class Enforce — same shape as the existing 13
static oneOf = (values: JsonValue[]) => CreateFieldDecorator(Enums.OneOf(values));
static const = (value: JsonValue) => CreateFieldDecorator(Enums.Const(value));   // `const` legal as a member name
static arrayOf = (item: ConstraintDescriptor, options?: {minItems?: number; maxItems?: number}) =>
    CreateFieldDecorator(Arrays.ArrayOf(item, options));
static dictionary = (value: ConstraintDescriptor) => CreateFieldDecorator(Objects.Dictionary(value));
static shape = (fieldClass: Function) => CreateFieldDecorator(Objects.Shape(fieldClass));
static nullable = (item: ConstraintDescriptor) => CreateFieldDecorator(Nullables.Nullable(item));
static uuid = () => CreateFieldDecorator(Strings.Uuid());
static dateTime = () => CreateFieldDecorator(Strings.DateTime());
static ipv4 = () => CreateFieldDecorator(Strings.Ipv4());
static format = (name: string) => CreateFieldDecorator(Strings.Format(name));
```

This unblocks the headline `@Shape` path (GAP-21): `@Shape(FieldClass)` reads *field* contracts, and
`Enforce.*` is where a consumer decorates fields — but a compositional field previously forced the
verbose `@CreateFieldDecorator(ArrayContracts.ArrayOf(...))`. Now `@Enforce.arrayOf(OneOf([...]))` is the
ergonomic path, so the headline feature's prerequisite is no longer the least ergonomic one.

**No new root export** — `Enforce` is already exported (`index.ts:235`); adding statics does not change
the export *count*. Surface unchanged. (`Enforce.const` is legal — reserved words are permitted as class
member names — and matches the `@Const` parameter decorator's name; note the mild readability oddity.)

---

## 6. IDEA-31 — README paragraph: the descriptor path needs no `experimentalDecorators`

Trivial, doc-only, no code. The `Verify.check` + `*Contracts` path (e.g.
`Verify.check(ObjectContracts.Dictionary(StringContracts.NotEmpty()), 'slots', body.slots)`) uses no
decorators, so it compiles with `experimentalDecorators`/`emitDecoratorMetadata` **off** (the reviewer
compiled it against the consumer tsconfig verbatim, exit 0). The README opens "TypeScript decorators…"
(`README.md:3`) and already mentions `Verify.check` (`README.md:40`) without saying it is decorator-free.

**Where it goes:** a short callout appended to the existing `Verify.check` sentence at `README.md:40`
(or a 3-line subsection immediately after it), stating that the `Verify.check` + `*Contracts` descriptor
half of the library needs neither compiler flag — refuting the decorator-tax objection (DEC-004) for that
half. After IDEA-28 lands (§1), the same paragraph should note that `Verify.check` now *narrows* `unknown`
to the constraint's output type. One paragraph; no surface, no test.

---

## 7. Sliced build order

| Slice | Item | Depends on | Touches | Surface | Independent? |
|---|---|---|---|---|---|
| **A** | GAP-22 export | — | `index.ts` | 94 (type-only) | yes; **gates B's consumer benefit** |
| **B** | IDEA-28 phantom `Out` | A (for the consumer to *name* it) | `Descriptor.ts`, `Contracts/{number,string,enum,array,object,nullable}.ts`, `Verify.ts` | 94 (type-only) | mostly; shares `Verify.ts`/`Descriptor.ts` with C |
| **C** | GAP-19 `locate`/`path` | — | `Descriptor.ts`, `Contracts/{object,array,nullable}.ts`, `Verify.ts` | 94 | yes; **coordinate the `Descriptor.ts`/`Verify.ts` edits with B** |
| **D** | IDEA-30 `toolSchemaFrom` | — | `schema.ts`, `index.ts`, `public-surface.test.ts` | **94 → 95** | yes |
| **E** | GAP-20 diagnostic | — | new analyzer, `ContractInstaller.ts`, `ContractDiagnostics.ts` | 94 | yes |
| **F** | GAP-21 `Enforce.*` | (better *with* B's typed descriptors, not required) | `Enforce.ts` | 94 | yes |
| **G** | IDEA-31 README | after B (to mention narrowing) | `README.md` | 94 | yes; doc-only |
| **H** | GAP-17 JSDoc pass | independent; do **last** | `src/Contracts/*`, `src/ParameterDecorators/*`, `src/Markers/*`, `src/FieldDecorators/*` | 94 | yes (see §9) |

**Dependency graph:** A → B (export-then-consume; B's *internals* don't need A). B and C both edit
`Descriptor.ts` and `Verify.ts` — land them in one branch or sequence B→C to avoid a merge on
`CheckResult`/the descriptor interface. D, E, F are fully parallelizable with each other and with B/C. G
follows B (so it can mention narrowing). H is a large mechanical slice, sequenced last so it rebases over
the small signature/JSDoc changes A–F introduce rather than the reverse.

**Recommended order:** A, then B‖C (same branch), then D, E, F in parallel, then G, then H.

**Surface-count impact per slice:** only **D** moves it (94 → 95). A and B are type-only; C adds an
optional field to a type; E and F add no export; G is docs; H is comments.

---

## 8. Tests each slice needs

- **A (GAP-22):** `public-surface.test.ts` stays green at 94 (proves the type export did not move the
  value count). A `.d.ts`-level assertion (a compile-only fixture, or a grep in the existing
  declaration-emit check) that `ConstraintDescriptor` now appears in `dist/index.d.ts`.
- **B (IDEA-28):** type-level fixtures (compile-only) asserting `Verify.check(Dictionary(NotEmpty()), …)`
  narrows to `Record<string, string>`, `ArrayOf(OneOf(['a','b']))` to `('a'|'b')[]`, `Nullable(Email())`
  to `string | null`, and a primitive to `number`/`string`; a negative fixture that a `Descriptor<P, string>`
  is still assignable where a bare `ConstraintDescriptor` is required (the adapter factories). Runtime
  regression: existing `Verify`/`Contracts` suites unchanged (no behavior change). Watch the `Verify`
  suite for the input-type→output-type return shift (§9).
- **C (GAP-19):** `Verify.check` returns `path:["slotInput","when"]` for a `Dictionary(Shape(...))` with a
  bad nested field; `["tags", 2]` for `ArrayOf(NotEmpty())` failing at index 2; `[]`-absent (no `path`) for
  a container-gate failure (`"nope"` to a `Dictionary`) and for a length-bound failure; a **parity test**
  that `locate`'s reported index equals the index at which the predicate's `every` first returns false
  (across dictionary/array/shape/nullable); primitives expose no `locate`. Additivity: `ok:false` results
  without a sub-path omit `path`.
- **D (IDEA-30):** `toolSchemaFrom({params:{roster: ArrayOf(OneOf([...]))}})` byte-equals the
  `toolSchemaForMethod` output for an equivalent decorated method (proves reuse, not divergence);
  `required` reflects the `optional` flag; `description`/`default` land on the property; `@Shape`-valued
  param is recursively tightened by the shared `tightenObjects`; `public-surface.test.ts` count 95 + the
  new per-item `describe` block.
- **E (GAP-20):** a routed `setContractDiagnosticsSink` captures the warning for
  `@ArrayOf(NotEmpty()) @OneOf([...])` and for `@Dictionary(...) @Const(...)`; **no** warning for the
  correct `@ArrayOf(OneOf([...]))`, for a plain primitive stack (`@GreaterThanEqual @LessThanEqual`), or
  for a container alone; silenced under `NODE_ENV=production` / `setContractDiagnosticsEnabled(false)`.
- **F (GAP-21):** each new static enforces on bad assignment and passes a good one, and the field stays
  readable/enumerable (BUG-1 storage); an end-to-end `@Shape` whose field class uses `@Enforce.arrayOf` /
  `@Enforce.dictionary`; `Enforce.const`/`Enforce.format('uuid')` behave as their descriptor twins.
- **G (IDEA-31):** none (doc).

---

## 9. Risks / open questions (for an adversarial reviewer)

1. **Does the phantom `Out` break any existing `ConstraintDescriptor<P>` usage or test?** The default
   `Out = unknown` makes every one-arg usage `<P, unknown>`, and `__out?` is optional and never set, so
   no *type* site and no *runtime* path changes. The one place to scrutinize is **`Verify.that`/`check`
   flipping `value: T` → `value: unknown`** and rebinding the return to the constraint's `Out`. For a
   caller who passed a typed value and relied on getting that exact input type back, the return is now the
   constraint's output type — usually *more* specific (good), but a widening for any descriptor whose `Out`
   is still `unknown` (a hand-built descriptor, or a composed one whose innermost `Out` is unknown). **Run
   the full `Verify` suite; expect type-only test adjustments, zero runtime diffs** (value, message,
   `constraint`, `kind` all identical). This is the single most likely place a test moves.
2. **Variance correctness.** The `(value: never) => Out` phantom must keep `Out` covariant so a typed
   descriptor still flows into `CreateConstraintDecorator`/`CreateFieldDecorator` (which take a bare
   `ConstraintDescriptor`). Verified by reasoning (§1.6) but pin it with a compile-only fixture — if a
   future edit makes the phantom `(value: Out) => void` (contravariant) instead, assignability silently
   inverts and every adapter call site breaks.
3. **The `as` casts.** Primitives avoid casts (Out fixed at `defineConstraint` time); the four
   compositional wrappers plus `OneOf`/`Const` each carry exactly one `as`. Each is justified (the phantom
   is erased; the runtime object is unchanged) but they are *unchecked* — a wrong cast would mistype the
   output with no compiler complaint. Keep them one-per-wrapper and pinned by the §8-B narrowing fixtures.
4. **`Shape<T>` fidelity (open question).** `Shape` takes a `Function`, so `T` can at best be the field
   class's *instance* type — which is a superset of the *validated* shape (only `@Contract`ed instance
   fields are checked). Options: (a) `Shape<T = unknown>` binding `T` to the instance type (convenient,
   slightly over-claims the output type); (b) leave `Shape` at `Out = unknown` (honest, no narrowing for
   shapes). Recommend (a) with a doc note; flag for the reviewer to choose. The other three compositional
   constructors have exact outputs (`Record<string,V>` / `V[]` / `V|null`).
5. **Does `locate` recursion terminate, and match `every`'s first failure?** Terminates: each descent
   follows the **descriptor** nesting (a fixed, finite, JSON structure built at authoring time), not the
   value graph — so even a cyclic runtime value cannot cause unbounded recursion; depth ≤ descriptor
   nesting depth. Matches `every`: each `locate` iterates in the identical order to its predicate's
   `every`/`some` and stops at the first failure, and both the predicate and `locate` rebuild the inner
   descriptor from the *same* `params` via `constraintFromJSON` (DEC-010), so they cannot disagree about
   *which* element fails. Cost: `locate` re-runs predicates (an O(n) re-walk) — acceptable because it runs
   only on the failure path, once, inside `Verify.check`.
6. **`locate`'s "root" convention.** Container-gate and length-bound failures return `undefined` (no
   sub-path), so `Verify.check` omits `path` and the top-level message stands alone. If the reviewer wants
   an explicit "the value itself" signal, `[]` is the alternative — but an empty path reads as noise on a
   `CheckResult`, so `undefined`/absent is recommended.
7. **Does `toolSchemaFrom` duplicate or cleanly reuse `toolSchemaForMethod`?** It reuses
   `schemaFragmentsOf` → `mergeFragments` → `tightenObjects` → `canonicalize` **unchanged** (living in the
   same module to reach them), plus a shared `applyParamAnnotations` helper — so the DEC-029 merge is not
   forked (the only fork DEC-010 forbids). The envelope loop is genuinely new but genuinely different
   (argument-sourced vs registry-sourced). The §8-D byte-equality test against a decorated equivalent is
   the guard that they cannot diverge.
8. **GAP-20 timing.** Firing at install means a class that authors the bad stack but *forgets*
   `@Contract()` gets the (louder) missing-`@Contract` warning instead of the unsatisfiable-stack one —
   acceptable, since the missing-`@Contract` case is the more urgent bug and the stack is unenforced
   anyway. A class that never installs (a pure `Verify.check` descriptor built by hand) is not reached by
   this diagnostic at all; that is by design — the trap is specific to *stacked flat param decorators*, and
   the descriptor path composes correctly by construction.
9. **Slice H (GAP-17) is large and out of scope here (sequencing only).** `index.ts` now carries **188**
   `//` guidance lines while `dist/index.d.ts` ships **1** — more written, none shipped, and now more
   urgent (round-3 update). The fix is **JSDoc on the source declarations** in `src/Contracts/*`,
   `src/ParameterDecorators/*`, `src/Markers/*`, `src/FieldDecorators/*` (what an editor shows on hover and
   what declaration emit preserves), plus selective promotion of the genuinely consumer-facing barrel
   notes — **not** a mechanical `//`→JSDoc rewrite of `index.ts` (the round-2 barrel-JSDoc approach was
   confirmed not to work). It is a pure documentation slice: no surface change, no runtime change, large
   diff. Do it **last** so it rebases over the small signature edits A–F make (e.g. the new
   `Verify.check`/factory return annotations should be documented *after* they exist), rather than forcing
   A–F to rebase over a giant comment diff.
