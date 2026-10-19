# Feedback from Axiform, 2026-10-18 (M0-2 Adorn runtime adapter)

Measured against adorn `1d9f74a` through `file:vendor/adorn` (git submodule, locally built `dist/`). The
consumer is Axiform `src/contracts/adorn.ts`. It compiles a serialized, implementation-independent component
contract (typed ports plus relational `requires`/`ensures` clauses in Axiform's own expression subset) into a
`contract()` spec, runs interchangeable realizations through it, and turns each call into a structured
evidence record: which clauses held, which one was violated, which port, blame, inputs and outputs.

Axiform's need differs from a typical consumer's in one way. It doesn't only want enforcement (throw on
violation). It wants a **per-call verdict as data**, because the verdict *is* the product: an evidence report,
a counterexample, later a before/after diff.

## What worked

- **`contract()` with object-form clauses is a clean compilation target.** `requires: [{predicate,
  description}]` / `ensures: [...]` plus `params: [Fields(...)]` / `returns: Fields(...)` mapped Axiform's
  model one-to-one. Enforcement order (params → requires → body → returns → ensures) is exactly the band
  order Axiform reports.
- **`ObjectContracts.Fields` + `Verify.check(...).path`** localizes a bad port (`['raw']`), with the
  innermost `expected` (`an integer`).
- **`defineConstraint` is enough to fill gaps** (see §3) without forking anything.
- **Seeing ≠ emitting held up.** With the host policy set to `'warn'`, `contract()` doesn't throw, but the
  `violation` event still reaches the sink. That's what lets the adapter report a violation regardless of
  the host's policy.
- **Total predicates.** `NaN`, a missing field and a wrong type all arrive as violations, never `TypeError`s.

## Findings

1. **No structured, non-throwing per-call verdict from `contract()`.** A violation is a thrown plain `Error`
   (message only); structured `ViolationFacts` exist only on the process-global observation sink. To get a
   verdict, Axiform swaps the global sink around every call (forwarding to the previous one), filters events
   by `observation.name`, and restores the sink in `finally`. That only works for **synchronous** calls,
   isn't safe under concurrency, and briefly hijacks a host-wide seam. The site lists "per-request policy" as
   unsupported, and this is the same gap viewed from the evidence side.

2. **A postcondition failure loses the returned value.** A counterexample needs `(inputs, output)`. The
   output isn't in the thrown error or the facts, so Axiform wraps the realization to capture its return
   before handing it to `contract()`.

3. **No primitive type descriptors.** There's `Integer()`, but no "finite number", "string" or "boolean".
   Axiform defines `axiform.number` and `axiform.string` via `defineConstraint` and uses
   `EnumContracts.OneOf([true, false])` for boolean. Every consumer that maps a type system onto Adorn will
   write the same three.

4. **`ViolationFacts` drop the localization `Verify.check` computed.** `violationFromCheck` keeps
   `expected` but not `path`, so the sink can't tell *which field* of a `Fields` argument failed. Axiform
   re-runs `Verify.check` on the same descriptor to recover the path. That's the same oracle, so there's no
   drift, but it's duplicate work.

5. **A closure clause is identified only by its free-text `description`.** Facts for a closure are
   `{constraint: '_OTHER', expectation: description}`. Axiform sets `description` to its clause id and reads it
   back from `expectation`. That works, but it's a convention resting on a human-readable field. An optional
   `id` on `Precondition`/`Postcondition`, carried on the facts, would make it explicit. So would the
   clause's index within its band.

6. **First failure only.** `evaluatePostconditions` stops at the first failing clause. For enforcement
   that's right. For an evidence report, "clauses 2 and 4 both failed on this input" is more informative,
   and today the report has to say "not evaluated" for everything after the first failure.

7. **Typing inconsistency in `ContractSpec.ensures`.** The bare-function form types `result` as `any`, but
   the object form's `predicate` is `PostconditionPredicate` with `result: unknown`. So
   `{predicate: (r: Foo, …) => …}` fails to type-check where `(r: Foo, …) => …` passes.

8. **Packaging, for a reproducible consumer.** The README says `npm i adorn`, but the npm name `adorn` is an
   npm security-holder package. There's no `prepare` script, so a git dependency
   (`github:natwhite/adorn#<sha>`) installs without `dist/`. Axiform works around both with a submodule
   plus a local build. Separately, `constraintFromJSON` isn't on the public surface, so a consumer holding
   `toJSON()` output can't rehydrate it.

9. **Postconditions see the arguments *after* the body ran, so a body can mask its own violation.**
   `contract()` evaluates `ensures` as `predicate(result, ...args)` with the same argument objects the body
   received. A body that mutates an argument changes what its postconditions check against. Found during
   Axiform's M0 adversarial review: a clamp that returns `5` for `{raw: -1}` and also sets `raw = 5` passes
   every postcondition (`out == in` now holds) and completes cleanly. The violation is masked, and any
   consumer recording the argument object records the falsified value. Axiform now hands realizations a
   deep-frozen clone. Suggestions, in order of strength: evaluate postconditions against a pre-call
   snapshot (it's the same mechanism the planned `old()` needs); or freeze/clone arguments when the contract
   has postconditions; or at least document that postconditions read the post-call argument state. This one
   is a soundness issue, not ergonomics, so it should probably come before §3–§8.

## Request

**Main request (covers 1, 2, 4, 5 and optionally 6):** a checked call form of `contract()` that returns a
verdict instead of throwing, with no global state involved. For example:

```ts
const checked = contract.checked(spec, fn);   // or contract(spec, fn, {mode: 'verdict'})
const v = checked(...args);
// v: {ok: true, value, durationMs}
//  | {ok: false, band: 'params' | 'requires' | 'returns' | 'ensures',
//     index: number,            // position within the band
//     id?: string,              // the clause's declared id, if any
//     facts: ViolationFacts,    // including path/expected for compositional descriptors
//     value?: unknown,          // the settled return, for returns/ensures failures
//     message: string}          // redacted, as today
//  | {ok: false, band: 'body', error: unknown}
// optional {evaluate: 'all'} → `failures: [...]` instead of the first failure
```

An async variant would return a promise of the same verdict. With this, Axiform's adapter loses the sink swap,
the return-capture wrapper and the `Verify.check` re-run, and becomes safe for async and concurrent
realizations.

**Smaller requests:** primitive descriptors (§3), `path` on `ViolationFacts` (§4), the `ensures` object-form
typing (§7), a `prepare` script or published package (§8).
