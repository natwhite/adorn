# Correction to rounds 2 and 3

**Date:** 2026-08-06
**From:** the `AiVoiceAgent-node` project
**Type:** a retraction and an update, not a new round

Two items in the previous feedback need correcting. **One of them is a mistake on my side that I
repeated twice**, including as a "highest leverage" recommendation. The other is a fix of yours that
round 3 missed.

Snapshot caveat, stated up front: `src/Validation/Verify.ts`, `src/Core/Configuration.ts` and
`src/FieldDecorators/Enforce.ts` were all modified within three hours of this being written. Anything
below is a reading of a moving target.

---

## Retraction — "adorn's best documentation does not ship" was wrong

Rounds 2 and 3 both claimed the documentation was lost in declaration emit, and round 2 made
converting `//` comments to JSDoc its number-one recommendation, priced at about an hour.

**The measurement behind that was invalid.** I counted `dist/index.d.ts` — 58 lines, one `//`
comment — and concluded consumers see almost nothing. But `dist/index.d.ts` is a **barrel**: it is a
list of `import … from './src/…'` specifiers. TypeScript resolves every symbol through it into the
per-module declaration files, and *those* are what a consumer's editor reads.

What actually ships:

```
56 .d.ts files · 6,143 lines · 5,099 JSDoc-ish lines (≈83%)
```

> **Verify:** `Get-ChildItem dist -Recurse -Filter *.d.ts | Get-Content | Measure-Object -Line`, then
> the same piped through `Select-String '^\s*(/\*\*|\*)'`.

And the specific symbol round 2 built its case on is documented. A consumer hovering `Between` sees,
from `dist/src/ParameterDecorators/Constraints.d.ts:56-57`:

```ts
/** Rejects values outside `[min, max]`. **Both bounds inclusive.** Throws at decoration if `min > max`. */
declare const Between: (min: number, max: number) => AdornParameterDecoratorFn;
```

The complaint was that guidance about `Between({min, max})` producing `TS2554` did not reach
consumers. It does not need to: **the signature is `(min: number, max: number)`, which states the
answer directly**, and the JSDoc above it ships. `Verify.check`'s declaration carries a full worked
example including the `if (!r.ok) return badRequest(r.message)` pattern.

**GAP-17 was right, and for a stronger reason than either of us gave.** You rejected my proposed fix
on the grounds that JSDoc on a re-export specifier cannot document the underlying symbol. That is
true. What neither of us said is that **it does not need to**, because the underlying symbol carries
its own doc and TypeScript follows the reference. The correct disposition for GAP-17 is not "won't
fix" but "not a defect".

If any residue remains it is narrow: whether the *narrative* guidance in `index.ts`'s `//` comments —
the material about how pieces relate, as opposed to what a single symbol does — has anywhere to live.
That is a README or a `docs/` question, not a declaration-emit one, and it is a much smaller item than
I made it.

---

## Update — R2-3 (no narrowing from `unknown`) is fixed, by a better route than I proposed

Round 3 scored this **NOT FIXED**, quoting `check<T>(…, value: T): CheckResult<T>` and noting that
`T` was inferred from the input, so the only unsound line — the cast — stayed the consumer's.

That is no longer the signature. Current `src/Validation/Verify.ts:158-162`:

```ts
static check<T>(
    constraint: ConstraintDescriptor<ConstraintParams, T>,
    keyName: string | symbol,
    value: unknown,
): CheckResult<T>
```

`ConstraintDescriptor` gained an output parameter — `ConstraintDescriptor<P extends ConstraintParams = ConstraintParams, Out = unknown>`
(`src/Core/Descriptor.ts:125`) — and the object contracts are generic over it: `Dictionary<V>`
(`src/Contracts/object.ts:105`) and `Shape<T = unknown>` (`:208`).

So `value` is now `unknown` and `T` comes from **the constraint**, not from the input. That is
genuine narrowing, and it is the blocker that stopped adoption.

**It is worth noting you did not take the fix I suggested.** I proposed making `Predicate` a type
predicate — `(value: unknown) => value is T`. `Predicate` is unchanged at `src/Core/Descriptor.ts:72`,
and threading the type through the descriptor instead is the better answer: it composes through
`Dictionary` and `Shape` without every predicate author having to write a guard, and it keeps the
runtime check and the static type derived from one declaration.

---

## What this does to the adoption verdict

Round 3 said "still do not adopt", on two blockers:

1. **Six `as` casts against the hand-written version's one**, because `check` proved the constraint
   and returned `unknown`. **This appears resolved.**
2. **The 400 response body degrades**, because a compositional descriptor collapses to a single
   boolean and one message covers several distinct failures. **Not re-checked.**

I am not claiming the verdict flips — I have not rewritten our validator against the current API, and
blocker 2 decides an endpoint whose error message is its contract. But the primary blocker is gone,
and **the verdict deserves re-running rather than being carried forward.** That is a different
position from where round 3 left it, and the change is yours, not a reinterpretation.

---

## The general lesson, which is mine

Two rounds of otherwise carefully-cited feedback rested on measuring the wrong file, and the error
survived because the number was striking — 58 lines against 359 — and striking numbers get repeated
rather than re-derived. The check that would have caught it took one command and I did not run it
until the project owner asked whether we were reading only `index.d.ts` or all of the declarations.

He was right to ask.
