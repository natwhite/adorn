# Plan — `providerStrict` recursion: nested `Fields` optionals under OpenAI strict (Q-32 deferred piece)

**Status:** proposed, pre-adversarial-review.
**DoD:** `npx tsc --noEmit -p tsconfig.test.json` clean + full `npx jest` green, run twice; then a capstone re-run confirming OpenAI now accepts the previously-400ing nested case.
**Source:** the capstone (`docs/q31-capstone-results.md`) case 4 — a `Fields` param with an *optional* field under `{providerStrict}` 400s because OpenAI strict requires every key in the **nested** `required`, and `Fields` drops its optional field there. DEC-068 deferred this.

## The problem, precisely

`providerStrict` (DEC-068) fixes the **top level**: a null-admitting optional *param* stays in `required`; a bare optional param is refused. But OpenAI strict enforces "every property in `required`, and `additionalProperties:false`" at **every object level**. A nested `Fields` with an optional field emits `{properties:{when,label}, required:[when], additionalProperties:false}` — `label` missing from the nested `required` → 400 (`context=('properties','slot'), … Missing 'label'`).

## Design — one recursive post-pass, replacing the per-param logic

The transform is uniform at every object level: **under `providerStrict`, `required` becomes ALL keys, and every key that was not already required must admit null (else refuse).** That single rule covers the top-level params AND nested `Fields`/`Shape`/`Nullable(object)` identically — so a **recursive post-pass over the assembled document** subsumes and replaces the Slice-D per-param logic.

`Fields.schema()` is NOT touched: it is options-unaware and used in both the descriptive (`schemaForClass`) and prescriptive postures, so the strict transform must live in the **projection**, gated by the flag, after the normal (honest, non-strict) document is built and `tightenObjects` has run, and **before `canonicalize`** (D-4).

```ts
// schema.ts — gated by providerStrict; runs on the assembled document before canonicalize.
function strictifyForProvider(node: JsonValue, path: string): JsonValue {
    if (!isObjectFragment(node)) return node;
    const out: JsonObject = {...node};

    // Recurse structurally first.
    for (const kw of ['anyOf', 'allOf', 'oneOf']) {
        if (Array.isArray(out[kw])) {
            out[kw] = (out[kw] as JsonValue[]).map((m, i) => strictifyForProvider(m, `${path}.${kw}[${i}]`));
        }
    }
    if (typeIncludes(out, 'array') && isObjectFragment(out.items)) {
        out.items = strictifyForProvider(out.items, `${path}.items`);
    }

    if (typeIncludes(out, 'object')) {
        // An OPEN map (@Dictionary): strict cannot express it — additionalProperties must be `false`.
        if ('additionalProperties' in out && out.additionalProperties !== false) {
            throw new TypeError(
                `toolSchemaFrom({providerStrict}): ${path || '(root)'} is an open map — OpenAI strict requires ` +
                    'closed objects (additionalProperties:false), so a Dictionary(...) cannot be expressed under strict.',
            );
        }
        if (isObjectFragment(out.properties)) {
            const props: JsonObject = {};
            const already = new Set(Array.isArray(out.required) ? (out.required as string[]) : []);
            for (const key of Object.keys(out.properties)) {
                const child = strictifyForProvider(out.properties[key], `${path}.properties.${key}`);
                props[key] = child;
                if (!already.has(key) && !fragmentAdmitsNull(child)) {
                    throw new TypeError(
                        `toolSchemaFrom({providerStrict}): '${key}' at ${path || '(root)'} is optional but not ` +
                            'nullable — OpenAI strict requires every property in `required`. Declare it ' +
                            'NullableContracts.Nullable(...), or call without { providerStrict: true }.',
                    );
                }
            }
            out.properties = props;
            out.required = Object.keys(props); // every key is now required (promoted-if-nullable, else we threw)
            if (!('additionalProperties' in out)) out.additionalProperties = false;
        }
    }
    return out;
}
```

Wire-up in `toolSchemaFrom` — **remove** the Slice-D per-param `else if (providerStrict)` block (revert to the plain `if (!spec.optional) required.push(paramName)`), then:

```ts
let document: JsonObject = {type: 'object', properties, required, additionalProperties: false};
if (typeof input.name === 'string') document.title = input.name;
if (typeof input.description === 'string') document.description = input.description;
if (providerStrict) document = strictifyForProvider(document, '') as JsonObject;
return canonicalize(document) as ToolSchema;
```

Reuses the existing `typeIncludes` / `fragmentAdmitsNull` (Slice D) and `isObjectFragment`. `title`/`description` are non-`properties` siblings — they pass through `{...node}` untouched.

### Why this is correct (walk the cases)
- **Nested `Fields` with a `Nullable` optional** (the fix): loop keeps `slot` required; `tightenObjects` already closed it to `{properties:{when,label}, required:[when], additionalProperties:false}`; strictify recurses into `slot`, sees `label` ∉ required, `label` admits null (`type:['string','null']`) → promotes → `slot.required = [when,label]`. Accepted by strict; the `Fields` validator accepts `label:null` OR absent (it's a `Nullable` optional) → no drift.
- **Nested `Fields` with a BARE optional**: strictify throws at `(root).properties.slot` naming `label` and the `Nullable(...)` fix — an early, clear build error instead of an opaque OpenAI 400.
- **Top level preserved** (unify): a top-level `Nullable` optional param is ∉ required after the loop, admits null → promoted (= old behavior); a bare optional param → thrown (= old behavior). The four Slice-D tests pin this.
- **`Nullable(Shape(X))` param**: `tightenObjects` (D-3) already closed it; strictify promotes the param (admits null) and recurses (x,y already required) — unchanged.
- **`@Dictionary` under strict**: an open map — strictify throws early (see open question).

## Open questions for the reviewer
1. **Open maps (`@Dictionary`) under `providerStrict`** — throw early (proposed: honest fail-fast, clearer than OpenAI's 400), or leave it to the provider? A Dictionary is fundamentally strict-incompatible (open object). Does the throw belong in THIS slice, or is it scope creep? Is `additionalProperties !== false` the right detector (a closed `@Shape`/`@Fields` always has `false`; only Dictionary has a schema there)?
2. **Unify vs. keep two paths** — replacing the per-param logic with the recursive pass is DRYer and the only way to reach nesting, but it moves the top-level refusal from a param-named message to a path-based one. Acceptable? Any Slice-D test asserting the exact message text (the tests match `/nullable/i`, which survives)?
3. **`allOf` / stacked-descriptor fields** — a multi-descriptor field emits `{allOf:[...]}` (no `type`), so strictify treats it as a leaf; if such a field is optional it will be judged non-nullable and throw. Correct, or does a stacked field need `admitsNull` to look inside `allOf`? (Edge; the consumer's shapes are single-descriptor.)
4. **`oneOf` recursion** — adorn never emits `oneOf` today; recursing into it is a harmless no-op. Keep for robustness or drop?
5. **Ordering** — strictify runs before `canonicalize` (so promoted `required`/added `additionalProperties` get ordered). Confirm nothing downstream re-reads the pre-canonical shape.
6. **Mutation safety** — strictify clones each node (`{...node}`) rather than mutating; confirm no shared reference into a descriptor's cached fragment is mutated (schema hooks return fresh objects, so believed safe).

## Files
- `src/Projections/schema.ts` — add `strictifyForProvider`; remove the Slice-D per-param providerStrict block; wire the post-pass. (No change to `Fields`, `tightenObjects`, or any descriptor.)
- `test/toolSchemaFrom.test.ts` — nested `Fields` + `Nullable` optional promoted into nested `required`; nested BARE optional throws with a path naming the field; deep nesting (`Fields` in `Fields`); Dictionary-under-strict throws (per Q1); the four Slice-D tests unchanged (unify pin).
- `tools/q31/capstone.ts` + `docs/q31-capstone-results.md` — re-point case 4 to the now-nullable nested shape and confirm OpenAI **accepts** it end-to-end (the previously-400ing case, closed).
- `docs/DECISIONS.md` (DEC-069), `docs/ISSUES.md` (Q-32 → the nested piece resolved), memory.

## Surface / risk
No new exports (the transform is internal; `providerStrict` already exists). Surface stays **96**. Risk is contained to `toolSchemaFrom` under `providerStrict` (opt-in); non-strict output is byte-identical (pinned). The one design call is Q1 (Dictionary-under-strict).
