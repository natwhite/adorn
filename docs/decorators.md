# Decorators & contracts

[← README](../README.md) · [Schemas & projections](schemas.md) · [Functional API](functional-api.md) · [Observability & privacy](observability.md) · [Add-ons](add-ons.md)

adorn's decorators are the *ergonomic* adapter over a reified descriptor model. This guide is the full catalog:
how enforcement installs, every constraint decorator, the pre-/postcondition bands, and the
enforcement/disclosure configuration. For the decorator-free equivalent of everything here, see the
[functional (descriptor) API](functional-api.md).

## How enforcement installs (the core trick)

A standard TypeScript parameter decorator runs once, at class-definition time, and receives only `(target,
propertyKey, parameterIndex)` — it never sees actual argument values. adorn bridges that gap by splitting the
work in two:

1. **Parameter decorators record.** `@GreaterThanEqual(1)` files its constraint against `(prototype, method,
   parameterIndex)` in a contract registry. It writes nothing to the method itself.
2. **`@Contract()` installs.** A class decorator runs *after* every member decorator, so by then the registry
   holds the whole class. It replaces each contracted method with a wrapper that, on every call, checks the
   recorded constraints against the runtime arguments before delegating.

> ### ⚠ `@Contract()` is required
>
> Parameter constraints **do nothing on their own**. A class that declares them without `@Contract()` is not
> enforced, and is invisible to every projection. Because that failure is silent, adorn emits a
> development-mode warning naming the offending class and methods (off under `NODE_ENV=production`; routable via
> `setContractDiagnosticsSink` / `setContractDiagnosticsEnabled`). `@Validate()` is a per-method alternative
> that also registers the class for projection — adorn never enforces what it would omit from a generated
> artifact. Prefer class-level `@Contract()`: it installs **outermost**, so guard-before-flow and
> postcondition-on-final-result hold by construction; the per-method form is order-sensitive.

Constraints evaluate in **declaration order** — parameters left to right, stacked decorators top to bottom. When
several arguments are invalid, the first one in the signature is the one reported.

## Why a decorator becomes five artifacts: constraints are data

The load-bearing move is that a constraint is **not an opaque closure that throws** — it is a *reified
descriptor*: an identity plus JSON-serialisable params, with the predicate **derived** from those params.
`@GreaterThanEqual(1)` is literally a thin `@`-syntax adapter over that descriptor. Derivation is what lets one
decorator project into a schema keyword, a docs line, a fuzzer generator, and the runtime check — none of which
can disagree, because they are all read from the same recorded data. The paradigm rests on this: the decorator
is the ergonomic surface; the reified descriptor underneath is why it can be more than a check.

Those descriptors are a **first-class authoring path**, exported directly (`NumberContracts.Between(1, 10)`,
`Verify.check(...)`, `contract(spec, fn)`, `toolSchemaFrom({...})`) — the decorator is sugar over them, not the
other way round. See [the functional API](functional-api.md).

## Surprising shapes

adorn can't see two things at runtime — TypeScript's own **type** and **default** — and a few TS/decorator
interactions surprise newcomers.

**The two channels adorn can't reconcile.** The artifacts adorn derives can't drift from each other, but the
descriptor still has to be authored to match:

- the parameter's **TypeScript type** — `@GreaterThan(0) x: string` compiles, and adorn then enforces `number`
  while the type says `string`; and
- any **TypeScript default** — `@Default(10) x = 20` publishes `10` to the schema but runs with `20`.

A build-time linter that cross-checks the two is a plausible future, but is not shipped.

**Three shapes that surprise new consumers:**

- **A TypeScript default value is honoured.** `detect(@GreaterThanEqual(1000) timeoutMs = 30_000)` called as
  `detect()` uses the default rather than throwing — adorn treats any parameter at or after the first defaulted
  one as optional, so an omitted (or explicitly `undefined`) argument is not validated as `undefined` (a default
  is compiled into the body, which runs *after* the wrapper). The one exception is a *required* parameter placed
  **after** a defaulted one (`f(a, b = 1, c)`), a signature TS lint discourages; mark it `@Optional()` /
  `@Default()` explicitly if you must write it. `@Default(x)` is still worth reaching for — after this, its job
  is publishing the default into the generated **schema** (a TS default is invisible to projections), not
  enforcement, which a plain TS default now handles on its own.
- **adorn's parameter decorators don't apply to constructor parameters yet** — an adorn limitation, not a
  TypeScript one. Legacy TypeScript *does* allow constructor-parameter decorators; a constructor parameter's
  `propertyKey` is simply `undefined`. adorn's decorator signature types that key as `string | symbol` (and its
  registry keys off it), so applying one to a constructor parameter is a TS1239. Widening the signature and the
  registry key is a deferred feature; for now, validate at construction with a **static factory**: a
  `static of(...)` decorated with `@Validate()` that returns `new`; a private constructor then makes the
  validated path the only path.
- **A `static #private` member blocks a class decorator** (TS18036 — TypeScript's own limitation, though the
  error blames the decorator). Move the static private to module scope, or use `@Validate()` per method.
  Instance `#private` members are fine.

## Parameter constraints

Numeric: `GreaterThan` · `GreaterThanEqual` · `LessThan` · `LessThanEqual` · `Between` · `Integer` ·
`MultipleOf`. String length and pattern: `StringMinLength` · `MinLength` · `MaxLength` · `NotEmpty` ·
`Matches` · `Email` · `Url`. Every predicate is **total** (a `null`/`NaN`/wrong-type argument reports a contract
violation, never a bare `TypeError`) — which matters because a fuzzer feeds it those first and a schema claims a
`type` on the strength of it.

- **`@OneOf([...])`** — a reified enum/membership constraint, type-agnostic. Projects to `{enum: [...]}`, the
  LLM constrained-decoding target several providers honour; strict `===` membership.
- **`@Const(value)`** — the single-literal sibling of `@OneOf`: projects to `{const: value}`.
- **`@ArrayOf(item, {minItems?, maxItems?})`** — the first **compositional** constraint: a list whose every
  element satisfies an inner descriptor, carried as serialised data. Projects to `{type:'array', items: <item
  fragment>, …}`, nests, and round-trips through JSON.
- **`@Dictionary(value)`** — an **open** map (`Record<string, V>`): arbitrary string keys, every value
  satisfying an inner descriptor. Projects to `{type:'object', additionalProperties: <value fragment>}`.
- **`@Shape(FieldClass)`** — a **closed** DTO validated against another class's `@Contract`ed instance fields.
  `toolSchemaForMethod` tightens it recursively (`required` = every field, `additionalProperties: false`),
  descending array items and dictionary values.
- **`@Nullable(item)`** — a compositional combinator widening any constraint to also accept `null`, distinct
  from `@Optional`'s "may be absent". Stays *required* in a tool schema (the model must send a value or explicit
  `null`).
- **String formats** — `@Uuid` · `@DateTime` · `@Ipv4`, and `@Format(name)` as a keyed alias. Each is a
  **validating** descriptor whose predicate is at-least-as-strict as the `format` keyword it emits, so the schema
  never over-claims. `date-time` uses strict RFC-3339 with real-calendar validation, not `Date.parse`.

> `@Positive()` / `@Negative()` / `@NonNegative()` / `@NonPositive()` were **removed** — a name can't carry a
> boundary. Write the boundary you mean: `@GreaterThan(0)`, `@LessThan(0)`, etc.

## Field constraints

`Enforce` installs an accessor that validates on assignment (`Enforce.greaterThan(0)`);
`CreateFieldDecorator(descriptor)` builds a field decorator over any descriptor; `installFieldContracts(ctor)` is
the imperative installer. Field constraints are **inherited**: a subclass's field is checked against the union of
every declaration on its prototype chain, and may only *strengthen*, never weaken.

## Markers (record-only)

- **`@Optional` / `@Default(value)`** — enforcement-aware. `@Optional` makes an *absent* (`undefined`) argument
  satisfy the position (dropped from the tool schema's `required`); `@Default` annotates a JSON default and
  implies `@Optional`. Inheritance is **required-wins**.
- **`@Describe('…')` / `@Tool('…')`** — pure annotation. `@Describe` is the sole source of a property's
  `description`; `@Tool` is the method/tool description. Both flow into docs.

## Contracts, pre- and postconditions

`Contract()` (class) / `Validate()` (method) install enforcement and register for projection.

- **`@Ensures((result, ...args) => boolean, description?)`** — a **closure** postcondition: fully general, but
  enforced-but-unprojectable (a closure carries no identity). An options form
  **`@Ensures({predicate, capture?, description?, id?})`** adds pre-state: `capture(...args)` runs at call entry
  and its deep-cloned, frozen result is passed to the predicate as `old` (`(result, old, ...args)`), so a body
  that mutates an argument can't mask its own violation. The same `capture` form is available on `contract()` /
  `contract.checked`'s `ensures`.
- **`@Returns(<descriptor>)`** — a **reified** postcondition: checked by the same predicate machinery
  preconditions use *and* emitted into docs and schema. Coexists with `@Ensures`.
- **`@Requires((...args) => boolean, description?)`** — the input-side twin: a **closure** cross-parameter
  precondition (`start < end`) checked before the call, blaming the caller. Like `@Ensures`,
  enforced-but-unprojectable.
- **`@EnabledWhen((self, ...args) => boolean, description?)`** — a **state-reading** precondition: the
  receiver-aware sibling of `@Requires`, for "`withdraw` is enabled only while `balance >= amount`".
  Caller-blamed ("not enabled in this state"), never projected into a schema (no argument choice satisfies it),
  and the hook [`fuzzSequence`](add-ons.md) uses to skip calls that are legitimately not enabled yet.

All four stack on one signature — parameter constraints, a cross-parameter precondition, and both postcondition
bands:

```ts
import {Contract, Requires, Returns, Ensures, GreaterThanEqual, NumberContracts} from 'adorn';

@Contract()
class Bank {
    @Requires((amount: number, balance: number) => amount <= balance, 'cannot overdraw')
    @Returns(NumberContracts.GreaterThanEqual(0))   // reified postcondition: the new balance is never negative
    @Ensures(                                        // closure postcondition (`result` is typed `unknown`, so narrow it)
        (result: unknown, amount: number, balance: number) => (result as number) === balance - amount,
        'balance drops by exactly the amount',
    )
    withdraw(@GreaterThanEqual(1) amount: number, @GreaterThanEqual(0) balance: number): number {
        return balance - amount;
    }
}

const bank = new Bank();
bank.withdraw(30, 100);    // → 70
bank.withdraw(150, 100);   // throws @Requires — the CALLER overdrew (checked before the body runs)
bank.withdraw(0, 100);     // throws @GreaterThanEqual(1) on `amount` (a parameter constraint)
// A body that returned a negative balance would throw @Returns — blaming the CALLEE, on the settled result.
```

`@Requires` runs before the call (caller-blamed); `@Returns` / `@Ensures` run on the settled result
(callee-blamed). Only `@Returns` is reified, so only it projects into the generated docs and schema (as the
return type). Runnable as [`examples/05-pre-post-conditions.ts`](../examples/05-pre-post-conditions.ts), which
also shows `@Returns` catching a buggy return value.

`evaluatePostconditions` / `evaluatePreconditions` are exported (from [`adorn/introspection`](schemas.md#registry-introspection)) because they are the *same* oracles the runtime wrapper
runs — a fuzzer checking them checks exactly what enforcement enforces, with no drift.

## Method decorators

`Log()` logs each call (safe-by-default redaction — see [Observability & privacy](observability.md)). `Time()`
measures duration, including async and Observable-like returns (`setTimingSink(fn)` routes it). `Observe()` opens
an observation span over the observation seam carrying a declared `SpanKind`.

`@Sensitive` / `@Telemetry` and the safe-by-default redaction runtime are covered in
[Observability & privacy](observability.md).

## Enable decorators

Decorator **syntax** needs exactly one TypeScript flag, `experimentalDecorators`:

```jsonc
// tsconfig.json
{ "compilerOptions": { "experimentalDecorators": true } }
```

That is the whole requirement. Enforcement, every projection, and the tool schemas read the **reified
descriptor** — not reflected type metadata — so none of them depend on `emitDecoratorMetadata` or on
`reflect-metadata`. The second flag is **optional and purely cosmetic**: `emitDecoratorMetadata: true` *together
with* an imported `Reflect.metadata` implementation (`reflect-metadata`) fills the inferred **`Type` column** in
generated docs from `design:paramtypes`, and nothing else — with either absent, adorn feature-detects that and
simply omits the column. Node.js 20.19+ is supported (CI runs on 20.19 / 22 / 24).

> **Toolchains.** Because only decorator *syntax* is required, any `experimentalDecorators`-capable compiler
> works — `tsc`, ts-jest, ts-node, SWC, esbuild, Vite, Bun. The optional `Type`-column metadata is the one place
> they differ: `tsc` / ts-jest / ts-node and **SWC** (`jsc.transform.legacyDecorator` + `decoratorMetadata`)
> emit it; **esbuild** (and Vite, which transpiles with it) and **Bun** do not. Since adorn never needs that
> metadata to run, the choice affects only whether generated docs can show an inferred `Type` column — never
> whether a contract is enforced or a schema is produced.

The descriptor API ([functional-api.md](functional-api.md)) needs none of this — just the import.

## Enforcement and disclosure configuration

Each contract is classified by **trust**: `guard` (default) validates untrusted input and survives production
(only `disableGuardEnforcement({confirm, reason})` strips it); `assert` is an internal self-check, stripped in
production. `setEnforcementMode` · `setAssertEnforcement` · `setDefaultTrust` · `enableGuardEnforcement` ·
`disableGuardEnforcement` tune the gate; `setViolationPolicy('throw' | 'warn' | handler)` routes what happens on
a violation (`'warn'` proceeds into the method, which is what makes staging a new contract over live traffic
possible); `setObservationVerbosity`, `setValueDisclosure` / `getValueDisclosure`, and
`setContractDiagnosticsEnabled` / `setContractDiagnosticsSink` / `flushContractDiagnostics` round it out.

> **This family is process-level, set-once-at-startup configuration** — not per-request state. Set at boot, it is
> safe under concurrency; mutating it per request in a shared process would change other in-flight calls, so
> don't. If you need *divergent policy per concurrent context* (one request `throw`, another `warn`), that is not
> expressible today — a known limitation. The data-first core you'll reach for most — the constraint decorators,
> the `*Contracts` descriptors, and `Verify.check` — is pure and carries no ambient state, so it is
> concurrency-safe regardless.

## Known limitations

- **Parameter names come from `Function.prototype.toString()`.** Minification degrades them (`message` → `s`),
  and that propagates into generated documents and schemas. Enforcement and every projection degrade *together* —
  a schema saying `s` about a check saying `s` beats one saying `arg0` about a check saying `sku`.
- **Arity is lost.** A wrapped method reports `length === 0` (its `.name` is correct); destructured/rest
  signatures can misalign recovered names — which is why a faithful OpenAPI path emitter is still blocked.
- **Closures can't be projected.** `@Ensures` / `@Requires` are enforced but invisible to docs, schema, and
  fuzzing (a `@Requires`-only method emits an empty tool schema). `@Ensures` types its `result` as `unknown`, so
  under `strict` the author must annotate.
- **Constructor-parameter decorators are not supported yet** (see [Surprising shapes](#surprising-shapes) for the
  static-factory workaround).
- **The `@Sensitive` primitive-parameter gap is permanent.** `transfer(ssn: string)` must be marked on the
  parameter; JavaScript's value semantics destroy the link to a `@Sensitive` field. A method *return* likewise
  can't be directly `@Sensitive`; `@Telemetry.result()` gives the opt-in half, the veto half needs class-level
  `@Sensitive`. See [Observability & privacy](observability.md).
