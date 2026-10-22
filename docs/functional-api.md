# The functional (descriptor) API

[← README](../README.md) · [Decorators & contracts](decorators.md) · [Schemas & projections](schemas.md) · [Observability & privacy](observability.md) · [Add-ons](add-ons.md)

adorn has **one semantic core — the reified descriptor — and two syntaxes that produce it.** Everything the
decorators do is also available as plain functions over those descriptors, with **no classes and no compiler
flags**. Reach for this path whenever a decorator can't apply — a raw `unknown` arriving from `JSON.parse` at an
HTTP boundary, a tool schema whose enum is known only at session start, a codebase with no classes — or simply
**by preference**.

## Working with values directly

Each entry below is a decorator's job available as a plain function, producing the identical descriptor and
projections with no decorators and no compiler flags.

- **`Verify.that(descriptor, name, value)`** throws on a violation; **`Verify.check(...)`** returns a
  discriminated `CheckResult` instead — the non-throwing path for a boundary that needs the failure as a *value*
  (an HTTP 400) rather than an exception. Both **narrow** `unknown` to the constraint's output type, and
  `Verify.check` reports the failing key on `path`.
- **`contract(spec, fn)`** — the functional twin of `@Contract` / `@Requires` / `@Ensures` / `@Returns` /
  `@Observe`: wrap a plain function with `{params, requires, ensures, returns, observe}` from descriptors, no
  class or decoration point. It runs the *same* precondition/postcondition oracles the decorators do (no drift),
  settles an async result before the return band, and — with `observe` set — emits `completed` / `violation`
  events to the installed sink. A zero-class codebase can adopt the enforcement layer whole.
- **`contract.checked(spec, fn)`** — the non-throwing twin: each call returns a `ContractVerdict` — the per-call
  outcome *as data* (`{ok, value}` on success; `{ok:false, band, index, id?, facts, value?, message}` for a
  contract failure; `{ok:false, band:'body', error}` for a thrown body) — with no global state (never the
  violation policy, never the sink). The verdict carries the settled return, the localized `path`, and, with
  `{evaluate:'all'}`, every failure. Same bands, same oracles, same failure builders as `contract()`, so an
  evidence/verdict consumer and a thrown violation cannot disagree.
- **`violationFromCheck(result, {parameter?})`** — turn a failed `check` into `ViolationFacts`, so a functional
  refusal emits as a `violation` event on the same stream the decorator weave feeds (and that
  [`adorn/otel`](add-ons.md) maps). One observability stream, decorator or not.
- **`toolSchemaFrom({params: {...}})`** builds the same prescriptive schema from named descriptors rather than
  from a decorated method, for a per-session schema; it takes the same `{ provider, strict }` profile as the
  decorated flagship (see [OpenAI strict mode](schemas.md#openai-strict-mode)).
- **`defineConstraint({...})`** builds a first-class reified constraint from data, so a constraint you define
  yourself projects into schemas and `Verify` exactly like a built-in.
- The descriptor namespaces themselves — `NumberContracts` · `StringContracts` · `EnumContracts` ·
  `ArrayContracts` · `ObjectContracts` (incl. `ObjectContracts.Fields({...})`, the optional-aware object literal)
  · `NullableContracts` — feed all of the above. The fluent **`Contracts`** facade re-groups every one of them
  under a single entry object with lowercase, type-grouped names and no namespace stutter:
  `Contracts.number.between(1, 10)`, `Contracts.enum(['a', 'b'])`,
  `Contracts.array(Contracts.nullable(Contracts.string.uuid()))`, `Contracts.object({...})` — the identical
  descriptors, a second spelling.

A worked boundary-validation example:

```ts
import { Verify, Contracts } from 'adorn';
import { toolSchemaFrom } from 'adorn/schema';

// A per-session tool schema whose enum is known only now:
const params = {
    slotId: Contracts.enum(openSlotsForThisSession),   // runtime data — no decorator could express it
    partySize: Contracts.number.between(1, 8),
    name: Contracts.string.notEmpty(),
};
const schema = toolSchemaFrom({ name: 'book', description: 'Book an available slot.', params });

// The model replies; validate it against the SAME descriptors — a non-throwing verdict:
const verdict = Verify.check(Contracts.object(params), 'args', modelReply);
if (!verdict.ok) return http400({ path: verdict.path, expected: verdict.expected });
doBooking(verdict.value);   // `value` is narrowed, not `unknown`
```

## Two authoring paths

adorn has **one semantic core — the reified descriptor — and two syntaxes that produce it.** Choose either, per
file; they interoperate and project identically.

| Decorator syntax — needs `experimentalDecorators` | Descriptor syntax — no compiler flags |
| --- | --- |
| `@Contract()` on the class | `contract(spec, fn)` / `contract.checked(spec, fn)` |
| `@NotEmpty() name: string` | `StringContracts.NotEmpty()` |
| `@Between(1, 7) days: number` | `NumberContracts.Between(1, 7)` |
| `@OneOf(['a', 'b']) unit: string` | `EnumContracts.OneOf(['a', 'b'])` |
| `toolSchemaForMethod(C, 'm')` | `toolSchemaFrom({ params: { … } })` |
| validation via the installed `@Contract` wrapper | `Verify.check(descriptor, name, value)` |

Both forms reduce to the **same descriptors**, so both feed the same pipeline — these are two frontends onto one
semantic system, not two libraries bolted together:

```text
   decorator  ─┐
               ├─▶  one reified descriptor  ─▶  runtime enforcement
   descriptor ─┘                                + JSON Schema
                                                + LLM tool schema
                                                + documentation
                                                + property-based tests
                                                + observability
```

The decorator is the *ergonomic* frontend; the descriptor is the *foundation* every projection reads
([constraints are data](decorators.md#why-a-decorator-becomes-five-artifacts-constraints-are-data)). A codebase
that can't or won't enable `experimentalDecorators` — or has no classes at all — adopts the **identical**
enforcement and projections through the descriptor path, which needs no compiler flags.

The descriptor frontend also has the fluent **`Contracts`** facade — the same factories grouped under one entry
object with lowercase, type-grouped names (`Contracts.number.between(1, 10)`, `Contracts.nullable(item)`,
`Contracts.object({...})`), so it reads as one algebra rather than seven namespaces.
