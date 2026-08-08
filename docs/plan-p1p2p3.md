# Plan — P1 (`Fields`) + P2 (`expected`) + P3 (detector-in-`toolSchemaFrom` + `defineConstraint`) + Slice D (Q-32b)

**Status:** proposed, pre-adversarial-review. Grounded against the code (line cites below).
**DoD per slice:** `npx tsc --noEmit -p tsconfig.test.json` clean + `npx jest` green, run twice; public-surface tripwire updated in the same commit.
**Source of asks:** `feedback/2026-08-07-round-4.md` §2.1/§2.2/§2.3, plus Q-32(b) (user chose option b, opt-in per the on-by-default analysis).

Build order: **B → C → A → D** (B and C are small and independent; A is the large one; D depends on A's optional semantics). Each slice is independently green.

---

## Slice B — `expected?: string` on a failing `CheckResult` (P2)

### Problem (verified)
`CheckResult` `ok:false` carries `message/constraint/kind/path` but no `expected` (`Verify.ts:82-97`). Live evidence from the Q-31 harness: `ArrayOf(OneOf([...]))` on `['alice','zzz']` returns `path:[1]` with a message saying *"expected an **array** of one of …"* — the container-level message contradicting the element-level path. The consumer wants `expected` = the `describe()` of the **innermost descriptor whose predicate failed at that path** (here the inner `OneOf`), so a caller composes `subjects[1]: expected one of "alice","bob"`.

### Design — widen the DEC-060 `locate` hook to also carry the innermost `describe()`
The innermost failing descriptor is already reached inside every `locate` closure (`array.ts:121-138`, `object.ts:70-84,170-186` — each walks into inner descriptors via `deeper = inner.locate`). We surface it from the same single walk. `locate` is new (DEC-060, this consumer's round-3 ask) and internal (consumers read `CheckResult.path`, never `descriptor.locate`), so widening its return now — before more descriptors implement it — is the low-cost moment.

Change the hook's return type from `ReadonlyArray<string|number> | undefined` to a small record:

```ts
// Descriptor.ts — the DEC-060 hook, widened (both fields optional; undefined = "not localizable")
export interface Localization {
    readonly path?: ReadonlyArray<string | number>;
    readonly expected?: string; // describe() of the innermost descriptor that actually rejected
}
readonly locate?: (value: unknown) => Localization | undefined;   // ConstraintDescriptor
locate?: (params) => (value: unknown) => Localization | undefined; // ConstraintDefinition
```

Each compositional `locate` returns both in one pass. `array.ts` becomes:

```ts
locate: params => {
    const inner = constraintFromJSON(params.item);
    const pred = inner.predicate, deeper = inner.locate;
    const {minItems, maxItems} = params;
    return (value) => {
        if (!Array.isArray(value)) return undefined;
        if (minItems !== undefined && value.length < minItems) return undefined;
        if (maxItems !== undefined && value.length > maxItems) return undefined;
        for (let i = 0; i < value.length; i++) {
            if (!pred(value[i])) {
                const sub = deeper ? deeper(value[i]) : undefined;
                return sub
                    ? {path: [i, ...(sub.path ?? [])], expected: sub.expected ?? inner.describe()}
                    : {path: [i], expected: inner.describe()};
            }
        }
        return undefined;
    };
},
```

`object.ts` `dictionaryConstraint`/`shapeConstraint` `locate` change identically (delegating `sub.expected ?? inner.describe()`). `nullable.ts` `locate` is transparent — forward the inner `Localization` unchanged.

`Verify.check` (`Verify.ts:~167`) consumes it once on the failure path and spreads both fields onto the result:

```ts
const loc = constraint.locate ? constraint.locate(value) : undefined;
return {
    ok: false, message, constraint: constraint.constraint, kind: constraint.kind,
    ...(loc?.path && loc.path.length ? {path: loc.path} : {}),
    ...(loc?.expected ? {expected: loc.expected} : {}),
};
```

**Flat/primitive failure** (`locate` absent → `loc` undefined): `expected` is omitted. The top-level `message` already reads `<key> expected <describe> but received …`, so a flat failure loses nothing. (Open question for review: also set `expected = constraint.describe()` on the flat case for a uniform always-present field? Leaning **no** — keep `expected` meaning "the localized inner expectation," present iff `path` is.)

### Redaction safety
`describe()` is a function of the **constraint params**, never the value (e.g. `array.ts:139-141`, `enum` `describe`), so `expected` cannot leak a received value (DEC-030 holds). Add a test asserting `expected` for a `@Const`/`@OneOf` inner contains only the literal set (author-declared), which is already public in the schema.

### Surface / tests
- `CheckResult` gains an optional `expected?: string` — type-only, count unchanged.
- `ConstraintDescriptor.locate` return type changes — type-only (advanced surface), count unchanged; note it in the DEC entry as a deliberate widening while the hook is new.
- Tests: extend `locate-path.test.ts` — assert `{path, expected}` for `ArrayOf(OneOf)`, `Dictionary(Shape)`, `Shape` nested, `Nullable` transparency; assert `expected` absent on a flat `Between` failure; assert `expected` carries no received value.

---

## Slice C — run the unsatisfiable-stack detector in `toolSchemaFrom`, and export `defineConstraint` (P3)

### C1 — the detector on the descriptor path
`detectUnsatisfiableStack(constraints)` (`ContractInstaller.ts:383-395`) is already **pure and decorator-free** — it reads only `constraint.schema()` and returns `[containerId, memberId] | undefined`. But it lives in an adapter, and only `warnUnsatisfiableStacks` (the installer wrapper, `:356-374`) calls it. `toolSchemaFrom` (`schema.ts:440-465`) never routes through the installer, so a `{descriptor: [ArrayOf(NotEmpty()), OneOf(ROSTER)]}` stack emits a silently-unsatisfiable schema — on the README-recommended path.

**Hoist** `detectUnsatisfiableStack` to Core so both callers share one copy (DEC-010, and `schema.ts`→`Adapters/legacy` would violate the projection layering, `schema.ts:10-17`):
- New `src/Core/unsatisfiable.ts` exporting `detectUnsatisfiableStack(constraints): [string,string] | undefined` (moved verbatim; it already imports only `ConstraintDescriptor`).
- `ContractInstaller.ts` imports it from Core (its `warnUnsatisfiableStacks` wrapper stays put — it owns the `getEffectiveContract` read and the decorator-flavored message).
- `toolSchemaFrom` calls it per param inside the existing loop (it already has `descriptors`, `schema.ts:451`), emitting via the same `reportDiagnostic` channel with a projection-appropriate message:

```ts
const pair = detectUnsatisfiableStack(descriptors);
if (pair) reportDiagnostic(
    `[adorn] toolSchemaFrom: parameter '${paramName}' stacks \`${pair[0]}\` (a container) with ` +
    `\`${pair[1]}\` (a primitive enum/const) — an always-false conjunction; the emitted schema is ` +
    `unsatisfiable. Fix: put the enum INSIDE the container, e.g. ArrayOf(OneOf([...])).`);
```

Check `reportDiagnostic`'s home (dev-gated, `setContractDiagnosticsEnabled`) — if it lives under `Adapters/legacy`, hoist it to Core alongside, or confirm it is already Core-importable. **Open for review:** exact module for `reportDiagnostic` and whether `toolSchemaForMethod` should also run the detector (it currently doesn't — it goes through the installer only when `@Contract()` runs; a raw `toolSchemaForMethod` call on an installed class already got the install-time warning, but an *uninstalled* class projected directly would not — decide whether to add it there too for symmetry).

### C2 — export `defineConstraint`
`ConstraintDescriptor` the **type** is exported (`index.ts:48`) but the factory that builds a custom constraint is not, so a consumer can name one but not make one. Add `defineConstraint` (`Descriptor.ts:241`) to the barrel. A consumer authoring a real constraint also needs the **types** `ConstraintDefinition`, `ConstraintKind`, `Predicate`, `ViolationContext`, `JsonObject` — export those as types too (all type-only, count-neutral). Note the `getConstraintDefinition(): ConstraintDefinition<any>` (`Descriptor.ts:272`) `any` is not exported and stays internal (round-4 §"Six for six" confirmed no `any` reaches a consumer) — keep it that way.

### Surface / tests
- **+1 value export:** `defineConstraint` → **95 → 96**. Types are count-neutral.
- Tests: a `toolSchemaFrom.test.ts` case asserting `reportDiagnostic` fires for the stacked `[ArrayOf, OneOf]` param (spy on the diagnostic sink, as the installer test does); a `defineConstraint` round-trip test building a custom constraint, using it in `Verify.check` and `toolSchemaFrom`, and rehydrating it via `constraintFromJSON`.

---

## Slice A — `ObjectContracts.Fields({...})`: the descriptor-first, optional-aware object (P1)

### API
```ts
ObjectContracts.Fields({
    seq: NumberContracts.Integer(),
    slotInput: {descriptor: SLOT_INPUT, optional: true},
});
```
Field spec value = a descriptor, a descriptor **stack** (array, conjunction — as `ToolParamSpec.descriptor`), or a `ToolParamSpec`-shaped `{descriptor, optional?, description?, default?}` (`schema.ts:405-414`). No new vocabulary. Ships as an `ObjectContracts` namespace member — **rides the existing namespace, +0 top-level exports** (like `Shape` on the same namespace). No `@Fields` decorator in this slice (the consumer's need is descriptor-first: `Verify.check` + `toolSchemaFrom`); flag whether a `@Fields` decorator (+1) is wanted.

### Type-level design (phantom `__out`, DEC-059)
```ts
type FieldSpec =
    | ConstraintDescriptor
    | ReadonlyArray<ConstraintDescriptor>
    | {descriptor: ConstraintDescriptor | ReadonlyArray<ConstraintDescriptor>;
       optional?: boolean; description?: string; default?: JsonValue};
type FieldsInput = {readonly [name: string]: FieldSpec};

type OutOf<D> = D extends ConstraintDescriptor<ConstraintParams, infer O> ? O : unknown;
type SpecOut<S> =
    S extends ConstraintDescriptor<ConstraintParams, infer O> ? O
  : S extends ReadonlyArray<ConstraintDescriptor> ? OutOf<S[number]>       // stack: see caveat
  : S extends {descriptor: infer D} ? SpecOut<D>
  : unknown;
type IsOpt<S> = S extends {optional: true} ? true : false;
type ReqK<T extends FieldsInput> = {[K in keyof T]-?: IsOpt<T[K]> extends true ? never : K}[keyof T];
type OptK<T extends FieldsInput> = {[K in keyof T]-?: IsOpt<T[K]> extends true ? K : never}[keyof T];
type FieldsOut<T extends FieldsInput> =
    {[K in ReqK<T>]: SpecOut<T[K]>} & {[K in OptK<T>]?: SpecOut<T[K]>};

export function Fields<T extends FieldsInput>(fields: T): ConstraintDescriptor<FieldsParams, FieldsOut<T>>;
```
So `Verify.check(Fields({seq: Integer(), slotInput: {descriptor: SLOT, optional: true}}), 'body', x)` narrows `x` to `{seq: number; slotInput?: SlotOut}`. **Caveat (open for review):** a *stack* field's `OutOf<S[number]>` is a union of the members' Outs, not their intersection (the runtime conjoins → the true type is the intersection). Runtime validation is exact; only the static Out for multi-descriptor stacks is imprecise. Single-descriptor fields (the common case, and every field in the consumer's examples) are exact. Decide: accept the imprecision, or compute the intersection via a `UnionToIntersection` helper.

### Runtime — `FieldsParams`, predicate, `locate`
```ts
interface FieldsParams extends JsonObject {
    fields: {[name: string]: {stack: SerializedConstraint[]; optional?: boolean;
                              description?: string; default?: JsonValue}};
}
```
`Fields(input)` normalizes each spec to `{stack: descriptors.map(d => d.toJSON()), optional, description, default}` — rejecting a non-descriptor (no `toJSON`) loudly, exactly as `ArrayOf`/`Dictionary`/`Shape` do (`array.ts:194-199`, `object.ts:108-113`).

`isFields` (mirrors `isShape` `object.ts:132-147`, but optional-aware): compile each field's predicate stack once (DEC-050); per value — reject a non-plain-object; a **missing required** field → reject; a **missing optional** field → skip; a **present** field must satisfy its whole stack. Extra keys pass (no enumeration — same under-claim posture as `isShape`; `additionalProperties:false` stays prescriptive-only, DEC-055).

`locate` (widened per Slice B): first failing field → `{path:[name, ...sub], expected}`; a missing required field → `{path:[name], expected: 'present'}` (wording TBD). Same field-then-stack order as `isFields`.

### Schema + the non-drift crux (the headline risk)
`Fields.schema()` composes each field's fragment **locally** — `descriptor.schema()` per constraint, single→fragment / multiple→`{allOf}` — exactly like `Shape`'s `fieldFragment` (`object.ts:155-162`). It **cannot** import `schema.ts`'s `mergeFragments` (Contracts→Projections is the wrong layering direction), and doesn't need to — `allOf` is exact. It emits its **own** `required` = the non-optional subset:

```ts
schema: params => {
    const properties: JsonObject = {}; const required: string[] = [];
    Object.keys(params.fields).forEach(name => {
        const f = params.fields[name];
        const frag = fieldFragment(f.stack);        // local, like Shape
        if (f.description) frag.description = f.description;
        if (f.default !== undefined) frag.default = f.default;
        properties[name] = frag;
        if (!f.optional) required.push(name);
    });
    return {type: 'object', properties, required};  // required = non-optional subset
},
```

**The crux:** `tightenObjects` (`schema.ts:676-706`) currently force-sets `required = every property` on a fixed-key object with no `additionalProperties` (correct for all-required `Shape`, **wrong for an optional `Fields` field**). Change it to **respect a pre-existing `required`**:

```ts
if (isObjectFragment(properties) && !('additionalProperties' in fragment)) {
    const tightened: JsonObject = {};
    Object.keys(properties).forEach(name => tightened[name] = tightenObjects(properties[name]));
    const required = Array.isArray(fragment.required) ? fragment.required : Object.keys(properties);
    return {...fragment, properties: tightened, required, additionalProperties: false};
}
```
`Shape` emits no `required` → still all-required (unchanged). `Fields` emits its subset → preserved. So `toolSchemaFrom({params:{x: Fields({...})}})` and `toolSchemaFrom({params:{seq, slotInput:{optional}}})` (flat) agree, because both drop optional from `required`. That structural agreement — same `{name: spec}` literal, same "required unless optional" rule on both the validate side (`Fields`) and the schema side (`toolSchemaFrom`) — is the "one declaration, cannot drift" property the consumer asked for.

**⚠ DEC-029 posture question (biggest risk — flag hard for review):** `Fields.schema()` emits `required` **unconditionally**, so a `Fields` used as a *class field* constraint would inject nested `required` into the **descriptive** `schemaForClass` output, which DEC-029 says never emits `required`. Argument that it is fine: a `Fields` value's predicate is **total** on its required sub-fields (rejects a missing one), so nested `required` is an honest *necessary condition* — it under-claims correctly (never rejects a value enforcement accepts). DEC-029's blanket "no required" is about the instance root not asserting a partial DTO is complete; a `Fields` *value* genuinely requires its sub-keys. **Proposed disposition:** a narrow, documented DEC exception — compositional object descriptors whose predicate is total on required sub-fields MAY emit nested `required` even descriptively. Reviewer must confirm this doesn't break a `schemaForClass` invariant/test.

### Relationship to `Shape`
Keep both; **do not** refactor `Shape` onto `Fields` in this slice (risk to its pinned all-required semantics/tests). `Shape` = class-sourced, all-required; `Fields` = object-literal, optional-aware. Note in docs that `Shape(C)` is ≈ `Fields` over `C`'s all-required instance fields; a future slice could delegate `Shape`→`Fields` once `Fields` is proven.

### Surface / tests
- `ObjectContracts.Fields` rides the existing namespace → **+0**. `FieldsParams` type-only. (Net count after all slices: **96**, from Slice C's `defineConstraint`.)
- Tests: new `Fields.test.ts` — predicate (required present/valid, optional absent OK, optional-present-invalid rejected, extra-keys pass, non-object reject); `locate`/`expected` deep paths; `typed-descriptors.test.ts` additions — `expectType<{seq:number; slotInput?:SlotOut}>` and `@ts-expect-error` negatives (optional key not required; wrong Out rejected). **The round-trip test that is the whole point:** one `Fields` literal drives `Verify.check` (narrowed) AND `toolSchemaFrom` (schema with the right `required`), and the emitted `required` equals the predicate's required-set. Extend `toolSchemaFrom.test.ts` for a nested `Fields` param (tightened, optional dropped from `required`).

---

## Slice D — `toolSchemaFrom(input, {providerStrict})`: OpenAI-strict-compatible emit (Q-32b, opt-in)

### Why opt-in, not default (settled)
On-by-default conflates *optional* (absent) with *nullable* (null), forces "optional⇒nullable" runtime semantics on every consumer, bakes an OpenAI-ism into the provider-neutral default, and is less honest about the contract. So: **default off**, one flag.

### Design (schema-emit)
Add `ToolSchemaFromOptions {providerStrict?: boolean}` (and the same on `ToolSchemaOptions` for `toolSchemaForMethod`). When `providerStrict` is on, an **optional** property is rewritten to OpenAI's encoding — kept in `required`, its type widened to include `"null"`:
```
{"type":"string"} (optional, dropped from required)   →   {"type":["string","null"]} (kept in required)
```
Implemented as a final transform over the assembled document: move every optional key into `required`, and null-union its `type` (handling a scalar `type`, an existing `type` array, and an `enum`/`const` fragment — for `enum`, add `null` to the members or wrap `anyOf:[{enum},{type:'null'}]`; decide the exact encoding per OpenAI's structured-output rules, and cover the nested `Fields`/`Shape` case recursively). `additionalProperties:false` is already emitted (Q-31 confirmed OpenAI accepts it), and Q-31 confirmed `format`/`minItems`/`minimum`/`maximum` pass strict — so **only** the required-completeness rewrite is needed.

### The validator-pairing caveat (flag for review)
`toolSchemaFrom` emits schema only; the consumer validates separately. Under `providerStrict` the model may send `note: null`, which a bare `NotEmpty()` rejects → the consumer must validate that param with a **null-accepting** descriptor (`NullableContracts.Nullable(NotEmpty())`). Document this. **The deeper coupling is with `Fields`:** a `Fields` whose `schema()` is emitted in strict form but whose predicate treats an optional field as absent-only would drift. Options for review: (a) keep Slice D scoped to the top-level `toolSchemaFrom` document only, document the `Nullable` pairing, and **defer** `Fields`+providerStrict; (b) make `providerStrict` also relax `Fields`' optional fields to accept `null`. Recommend **(a)** for this buildout — smallest honest increment — with (b) as a follow-up once `Fields` is in use.

### Surface / tests
- `ToolSchemaFromOptions`/the option is type-only → count-neutral (stays **96**).
- Tests: re-run the Q-31 `scheduleReminder` shape through a unit test asserting the `providerStrict` document lists `note` in `required` with `type:["string","null"]`; a default (off) test asserting the current honest shape is unchanged; a `Nullable`-paired `Verify.check` accepting `null`.

---

## Consolidated risks / open questions for the reviewer
1. **DEC-029 vs `Fields.schema()` emitting `required`** (Slice A) — the headline. Honest necessary-condition, or a posture violation needing a different mechanism? Does it break any `schemaForClass` test/invariant?
2. **`tightenObjects` respecting an existing `required`** (Slice A) — does any current fragment already carry `required` such that this change alters existing output? (Believed no — only `Fields` will emit one.) Confirm against `schema.test.ts`.
3. **Stack-field `Out` imprecision** (Slice A) — union vs intersection for multi-descriptor fields. Accept, or add `UnionToIntersection`?
4. **`locate` return widening** (Slice B) — one richer hook (proposed) vs a second parallel hook; and the flat-case `expected` decision.
5. **`reportDiagnostic` home + `toolSchemaForMethod` symmetry** (Slice C) — is it Core-importable; should the method projection also detect?
6. **`providerStrict` encoding of `enum`/nullable and the `Fields` coupling** (Slice D) — exact null-union for enum/const; defer `Fields` interaction (a) vs build it (b)?
7. **`defineConstraint` public-ness** (Slice C) — the factory is stable; confirm the type tail (`ConstraintDefinition` etc.) is what a custom-constraint author needs and nothing `any`-typed leaks.

---

## AMENDMENTS — post-adversarial-gate (2026-08-07)

The gate (`ab0…`) plus the empirical strict-fix probe (`docs/q32-results.md`) settle the following. Build to these, not the pre-gate Slice D text above.

### Slice D — REVISED (D-1 adopted): nullability lives in the declaration, not the emit flag
The original design (an emit-call flag that widens an optional's `type` to include `null`) manufactures schema/validator drift: `toolSchemaFrom` emits schema, `Verify.check` validates the descriptors separately, so the flag can't reach the validator — the model sends `note:null`, the schema allows it, `NotEmpty()` rejects it. Adopted redesign:
- **The single declaration carries nullability.** An optional field that must survive strict is declared `Nullable(...)`. Schema (Nullable's emit) and validator (Nullable's predicate) then derive from one declaration → no drift. (Optional ergonomic, deferrable: `nullable:true` on `ToolParamSpec`, which builds the stack *with* `Nullable`.)
- **`providerStrict` shrinks to one move:** keep a null-admitting optional field **in** `required` (instead of dropping it). No type-rewrite transform — `Nullable` already emits the null union / `anyOf`.
- **A bare non-nullable optional under `providerStrict` is a LOUD REFUSAL** (throw: "wrap in `Nullable(...)` to be strict-compatible"), never a silent widen.
- **Probe-verified** (`q32-results.md`): all five candidate encodings are accepted by OpenAI strict, including `anyOf:[{enum},{null}]` (exactly what `Nullable` emits for a typeless enum) and the nested nullable object — so this design needs *zero* new encoding logic, only the `required`-membership decision.
- The required-membership decision happens **inside the per-param loop, before `canonicalize`** (D-4 dissolves — no post-canonicalize transform).

### D-3 (now load-bearing for Slice D) — `tightenObjects` must close a null-unioned object/array
`tightenObjects` gates on `fragment.type === 'object'`/`=== 'array'` (string). A `Nullable(Shape(X))` emits `type:["object","null"]`, so it currently skips closing → no `additionalProperties:false`/nested `required` → OpenAI strict rejects the nested object (probe confirms strict needs both). Fix: recognize a `type` that is an **array containing** `'object'`/`'array'` and close it the same way. Add a test for `Nullable(Shape(...))` under `toolSchemaFrom`.

### C-1 — the `reportDiagnostic` hoist is bigger than "move it alongside"
`reportDiagnostic` shares module state (`sink`/`enabled`/`emit`) with the **public** setters `setContractDiagnosticsEnabled`/`setContractDiagnosticsSink` (in `Adapters/legacy/ContractDiagnostics.ts`, exported from `index.ts`). Move the sink+enabled+emit **primitive** to Core; have the Adapter setters **delegate** to it (the pending-`@Contract` machinery stays Adapter-side). Otherwise `toolSchemaFrom`'s diagnostic emits to a Core sink while the C test's spy (`setContractDiagnosticsSink`) sets the Adapter sink → the spy never fires and the test passes vacuously. `detectUnsatisfiableStack` itself is verified pure/Core-safe.

### B-1 — land the `locate` widening atomically
Changing the hook return `ReadonlyArray<string|number>|undefined` → `Localization|undefined` touches `Descriptor.ts` (×2 sigs), `array.ts`, `object.ts` (×2), `nullable.ts`, `Verify.check`, and `test/locate-path.test.ts` (asserts `.path` as a bare array) — all in one commit. `tsc` catches any missed site. Flat-case `expected`: omitted (keep `expected` present iff `path` is).

### A-1 — DEC-029 posture (Slice A) — DISPOSITION: amend narrowly
`Fields.schema()` emits `required` unconditionally, injecting nested `required` into the descriptive `schemaForClass` (which never emits it; `Shape` deliberately doesn't). It breaks **no test** (root-only assertions) and is **honest** (a `Fields` value's total predicate genuinely requires those sub-keys — an under-claim-safe necessary condition). **Disposition (proceeding unless overridden):** add a narrow, documented DEC-029 exception — *a compositional object descriptor whose predicate is total on its required sub-fields MAY emit nested `required`* — and accept the `Fields`-emits / `Shape`-doesn't asymmetry (Fields *must* emit `required` to express the optional subset; it is load-bearing, not cosmetic). `Shape` stays untouched (protects its pinned semantics; a future pass could make it emit `required` too for symmetry). Recorded as a new DEC entry at build time.

### Cleared by the gate (no action)
tightenObjects-respects-`required` is behavior-preserving (no current `schema()` hook emits `required`); `canonicalize` handles the `type` array; the detector is Core-safe to hoist; B's `expected` can't leak a value (DEC-030 holds); surface count 95→96 (`defineConstraint` +1; `Fields` rides `ObjectContracts`; types count-neutral).
