/**
 * The JSON Schema projection — the second of the artifacts DEC-006 promises from one contract
 * declaration, after documentation (`./docs.ts`).
 *
 * Documentation proved the architecture end to end at the lowest available risk (ISSUES.md IDEA-7).
 * Schema is the next renderer over the *same extraction*: it answers "what contracts exist, on what,
 * with what params" exactly as documentation does, and diverges only in what it reads off each
 * descriptor — `schema()` instead of `describe()`.
 *
 * ## Layering (DEC-012, plan §2)
 *
 * This module imports from `Core/` only, exactly as `./docs.ts` does. It must never reach into a
 * decorator adapter — not `target`/`propertyKey`, not a stage-3 context, not `__decorate`. A
 * projection that binds to an adapter turns "many artifacts from one declaration" into "many
 * artifacts from the *legacy* syntax", stranding every consumer on standard decorators — the reach
 * problem DEC-003/DEC-012 exist to prevent. The mechanical guard is a test that reads this module's
 * own imports (see `schema.test.ts`), the twin of the one over `docs.ts`.
 *
 * ## Reusing the docs seam — but not the docs *model*
 *
 * `documentClass` produces a plain-data model (`ClassDoc`/`MethodDoc`/…) by walking the registry's
 * two bands, and its module header names step 1 (extraction) as the shared seam for the other
 * projections. This module reuses that seam at the level that matters: the **registry read API**
 * `getContractsForClass` / `getFieldContractsForClass`, which own the two-key-band walk (DEC-018)
 * and the inheritance union (DEC-021 fields, DEC-022 methods). Nothing here re-derives that walk.
 *
 * It does **not** consume `ClassDoc`. The docs model deliberately flattens each descriptor to a
 * `ConstraintDoc` carrying `constraint` + `kind` + `params` + `describe()` output, and drops the
 * `schema()` hook (docs.ts header, DEC-006's consumer table). Schema needs the fragment `schema()`
 * returns, and that fragment cannot be reconstructed from `params`: the under-claim logic lives
 * *inside* each descriptor's `schema()` — `matches` with flags degrades to `{type: 'string'}`, `url`
 * to `format: 'uri'` (`Contracts/string.ts`) — so rebuilding it from `params` would fork that logic
 * and reopen exactly the descriptor/projection drift DEC-010 exists to close (Q-4). So this module is
 * a **parallel extractor sharing the docs registry reads**, and it reads `descriptor.schema()`
 * directly off the descriptors those reads hand back. That is the path the task's "note it and read
 * the descriptor's `schema()` directly" calls for; `ConstraintDoc` carrying `params` is what a schema
 * projection *would* read if the fragment logic lived in the projection, and it deliberately does not.
 *
 * ## Under-claim, never over-claim (the whole ethic)
 *
 * A JSON Schema is validated *against* by a consumer, so a schema that over-claims — one that would
 * reject a value enforcement accepts — is worse than no schema: it turns a generated artifact into a
 * source of false rejections. Every degradation here is therefore toward the **weaker true
 * statement** (a necessary, not always sufficient, condition):
 *
 * - A constraint whose descriptor supplies no `schema()` hook contributes **nothing** — its position
 *   degrades to `{}` (accept anything) rather than a guessed bound. `{}` never rejects.
 * - `additionalProperties` and `required` are **never emitted** on a class's object schema. A field
 *   constraint bounds a field's *value when assigned*; it does not assert the property is always
 *   present, nor that no other properties exist. Emitting either would reject objects enforcement
 *   accepts (a partial DTO; an object with extra fields).
 * - Method argument tuples set no `minItems`/`maxItems` and no `items: false`: arity is not reliably
 *   recoverable (docs.ts, Q-10), and a variadic or trailing-optional call must not be rejected.
 * - The individual fragment degradations (`matches`+flags, `url`, `email`) are the descriptors' own,
 *   inherited unchanged — this module never re-tightens what a descriptor deliberately loosened.
 *
 * The direction is always: the emitted schema accepts **at least** everything enforcement accepts.
 *
 * ## Merging several constraints on one position (justified in DEC — see the proposed entry)
 *
 * `@GreaterThanEqual(1) @LessThanEqual(100)` on one parameter is two descriptors; their schema is one
 * object, `{type: 'number', minimum: 1, maximum: 100}`, not two. Stacked constraints are a
 * **conjunction** (every one must hold — the same logical AND the enforcement wrapper applies, and
 * the same union DEC-021/DEC-022 resolve down a prototype chain), so the merge must mean AND:
 *
 * - **Disjoint keywords coexist.** `minimum` and `maxLength` from different constraints simply sit
 *   side by side; a JSON Schema keyword only bites on an instance of its relevant type, so their
 *   conjunction is faithful with no reconciliation.
 * - **A repeated bound takes the tighter value** — `max` of the `minimum`/`exclusiveMinimum`/
 *   `minLength` family, `min` of the `maximum`/`exclusiveMaximum`/`maxLength` family. Two lower
 *   bounds AND-ed is the higher one; that is exactly the set enforcement checks, so it neither over-
 *   nor under-claims.
 * - **`type` resolves to the narrower** when it is `integer` vs `number` (`integer ⊂ number`, and the
 *   conjunction is `integer`). `Integer()` ∧ `GreaterThanEqual(1)` is `{type: 'integer', minimum: 1}`.
 * - **Anything that cannot be combined in place falls back to `allOf`** of the raw fragments — two
 *   distinct `pattern`s, two distinct `multipleOf`s, a genuine `type` contradiction. `allOf` *is*
 *   conjunction in JSON Schema, so it is always exact and can never over-claim; the flat merge above
 *   is only a readability optimisation for the common, combinable case.
 *
 * ## The emitted shape
 *
 * `schemaForClass(C)` returns one draft-2020-12 document. Its **root validates an instance of `C`**:
 * `{type: 'object', properties: {<instance fields>}}` — the strongest honest claim available, since a
 * field constraint is a class invariant (DEC-021) that guards every instance. Method argument tuples
 * and static members are carried under annotation keywords (`methods`, `staticMethods`,
 * `staticProperties`) that a validator ignores for instance validation but a tool can read; each is
 * itself a well-formed subschema (a method is `{type: 'array', prefixItems: [...]}`, an argument
 * list). Nothing is forced into `properties` that does not describe an instance, so the root never
 * over-claims.
 *
 * ## Installed-state is out of scope, deliberately
 *
 * The docs renderer flags a recorded-but-uninstalled contract loudly. A machine schema has no such
 * banner, and the schema is a projection of the **declaration** (what is contracted), matching the
 * docs *model*, which carries every recorded constraint regardless of `installed`. Whether a contract
 * is currently enforced at runtime is a separate fact the docs projection surfaces; it is not encoded
 * here, so the schema describes the intended contract rather than the current wiring state.
 *
 * ## Deliberately not built here
 *
 * No OpenAPI document, no `$ref` graph across classes, no arbitraries, no validation runtime. One
 * class → one self-contained schema, plus a registry-walk bundle.
 */

import {ConstraintDescriptor, JsonObject, JsonValue} from '../Core/Descriptor';
import {
    ClassMethodContract,
    getContractedClasses,
    getContractsForClass,
    getFieldContractsForClass,
} from '../Core/ContractRegistry';

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

/**
 * A JSON Schema document for one class. It *is* plain JSON data (a {@link JsonObject}) — unlike the
 * docs projection's `ClassDoc`, the schema projection's model and its output are the same thing,
 * because the artifact this projection produces is itself a schema.
 */
export type ClassSchema = JsonObject;

/**
 * The prescriptive tool-call schema {@link toolSchemaForMethod} emits for one contracted method
 * (DEC-048). It *is* plain JSON data, like {@link ClassSchema} — the artifact is itself a schema.
 * Named separately because its posture is the opposite of `ClassSchema`'s: `ClassSchema` describes an
 * instance and under-claims (never `required`, never `additionalProperties`), while a `ToolSchema`
 * specifies the argument object a producer (an LLM) must send and is deliberately tight.
 */
export type ToolSchema = JsonObject;

export interface SchemaOptions {
    /** Spaces per indent level for {@link serializeSchema}. Defaults to 2 (JSON house style). */
    readonly indent?: number;
}

export interface ToolSchemaOptions {
    /**
     * Natural-language description of the tool, emitted as the schema's `description`. This is the
     * tool-level meaning ("look up a weather forecast") the model reads — distinct from each
     * parameter's own `describe()` bound, which the fragments already carry. Omitted when absent
     * (adorn is runtime-introspection only, so JSDoc is not a source — DEC-007).
     */
    readonly description?: string;
}

/** The dialect every document declares. draft 2020-12 is what `prefixItems`/`exclusiveMinimum:number` assume. */
const DIALECT = 'https://json-schema.org/draft/2020-12/schema';

const DEFAULT_INDENT = 2;

/** Sentinel: two fragments disagree on a keyword in a way the flat merge cannot combine. */
const CONFLICT = Symbol('schema-merge-conflict');

// ---------------------------------------------------------------------------
// Extraction — the plain schema object (mirrors documentClass)
// ---------------------------------------------------------------------------

/**
 * Build the JSON Schema for one class, across **both** contract bands and honouring inheritance.
 *
 * The two-key-band walk (instance members on the prototype, statics on the constructor) and the
 * inheritance union both live in `getContractsForClass` / `getFieldContractsForClass` (DEC-018,
 * DEC-021, DEC-022) — this reads them exactly as `documentClass` does, so an inherited constraint
 * appears in a subclass schema because the registry already resolved it, not because this module
 * re-walked the chain.
 *
 * Returns a document with an empty `properties` (and no method/static keywords) when nothing is
 * recorded — the empty case is a valid "an instance is an object with no contracted fields" schema,
 * not a failure.
 */
export function schemaForClass(constructor: Function): ClassSchema {
    if (typeof constructor !== 'function') {
        throw new TypeError('schemaForClass: expected a constructor function');
    }

    const name = constructor.name || '(anonymous class)';

    const properties: JsonObject = {};
    const staticProperties: JsonObject = {};
    getFieldContractsForClass(constructor).forEach(entry => {
        const fragment = mergeFragments(schemaFragmentsOf(entry.contract.constraints));
        (entry.isStatic ? staticProperties : properties)[String(entry.key)] = fragment;
    });

    const methods: JsonObject = {};
    const staticMethods: JsonObject = {};
    getContractsForClass(constructor).forEach(entry => {
        const schema = methodSchema(name, entry);
        (entry.isStatic ? staticMethods : methods)[String(entry.key)] = schema;
    });

    const document: JsonObject = {
        $schema: DIALECT,
        title: name,
        type: 'object',
        // Always present, possibly empty. `additionalProperties` and `required` are deliberately
        // absent — see the under-claim note in the module header.
        properties,
    };
    // Static members and method argument tuples are carried under annotation keywords a validator
    // ignores when validating an instance, so the root stays an honest instance schema.
    if (hasKeys(staticProperties)) {
        document.staticProperties = {type: 'object', properties: staticProperties};
    }
    if (hasKeys(methods)) document.methods = methods;
    if (hasKeys(staticMethods)) document.staticMethods = staticMethods;

    return canonicalize(document) as ClassSchema;
}

/**
 * Build a schema for every class in the enumerable registry (DEC-011) — the whole-registry walk a
 * generation run takes, mirroring `documentContracts`.
 *
 * Same runtime-introspection limitation as documentation (DEC-007): only classes whose module has
 * been imported and evaluated are visible, so a generation run needs an entry point that imports the
 * modules to be projected.
 */
export function schemaForContracts(): ClassSchema[] {
    return getContractedClasses().map(schemaForClass);
}

// ---------------------------------------------------------------------------
// The tool-call schema — a PRESCRIPTIVE sibling of schemaForClass (DEC-048)
// ---------------------------------------------------------------------------

/**
 * Project one contracted method to the tight, params-as-object schema an LLM tool-calling API wants
 * (IDEA-20 / DEC-048).
 *
 * ## A sibling of `schemaForClass`, not a flag on it — because the posture is opposite
 *
 * `schemaForClass` is **descriptive**: it validates an *instance*, under-claims on purpose, and never
 * emits `required` or `additionalProperties` (see the module header). A tool schema is
 * **prescriptive**: its root is a *method's parameters*, and it is the target a producer (the model)
 * is obligated to hit — so it emits `required` and `additionalProperties: false` and is tight enough
 * to steer the model and reject a hallucinated or missing argument. These are not in conflict; they
 * answer different questions for different consumers (a validator checking existing data vs a
 * generator being steered), which is exactly why they are two functions. `schemaForClass` is
 * untouched.
 *
 * ## It reuses the same merge internals — no fork (DEC-010)
 *
 * The per-parameter fragment is `mergeFragments(schemaFragmentsOf(...))`, the *same* extraction and
 * DEC-029 conjunction merge `methodSchema` runs (so `@GreaterThanEqual(1) @LessThanEqual(7)` is one
 * `{minimum:1, maximum:7}`, and a `@OneOf([...])` is one `{enum:[...]}`). Re-implementing the merge
 * would reopen the descriptor/projection drift DEC-010 closes. Layering is unchanged (DEC-012): it
 * reads `getContractsForClass` and `descriptor.schema()`, Core + Contracts only.
 *
 * ## The emitted shape
 *
 * ```
 * {
 *   title: "Class.method",
 *   description?: <options.description>,   // only when supplied
 *   type: "object",
 *   properties: { "<paramName>": <merged fragment>, … },
 *   required: [ <every param carrying ≥1 constraint> ],
 *   additionalProperties: false
 * }
 * ```
 *
 * - **Property names are the registry's `param.name`.** A param with no recovered name degrades to
 *   `arg{index}` but still appears — names rely on `Function.toString()` (SMELL-1), which is solid
 *   server-side and degrades to single letters only under minification.
 * - **`required` = "carries ≥1 constraint"** (DEC-048). This is not a guess about TS optionality —
 *   `?`/defaults are unrecoverable at runtime (Q-10/Q-28) — it is backed by enforcement: the built-in
 *   predicates are total (BUG-4) and reject a missing argument (Q-7), so a constrained param already
 *   throws when absent. An unconstrained-but-known position is present in `properties` (as `{}`,
 *   accept-anything) and **not** required, a faithful subset.
 * - **`additionalProperties: false` always.** A method's parameter set is closed; this is the one
 *   keyword the tool schema asserts that runtime enforcement does not check — a producer-steering
 *   assertion, emitted honestly as prescriptive rather than as a claim about adorn's runtime.
 *
 * A method with contracted params carrying no expressible constraint, or one with none at all, yields
 * `{title, type:'object', properties:{}, required:[], additionalProperties:false}` — valid, not an
 * error. A method that does not exist on the class throws.
 *
 * Inherited contracts are included: `getContractsForClass` resolves the DEC-021/DEC-022 union, so a
 * subclass's inherited method parameters project exactly as its own would.
 */
export function toolSchemaForMethod(
    constructor: Function,
    method: string | symbol,
    options?: ToolSchemaOptions,
): ToolSchema {
    if (typeof constructor !== 'function') {
        throw new TypeError('toolSchemaForMethod: expected a constructor function');
    }

    const className = constructor.name || '(anonymous class)';
    const entry = getContractsForClass(constructor).filter(candidate => candidate.key === method)[0];

    // A recorded method entry is the projectable case. When there is none, the method may still be a
    // real-but-uncontracted method (an empty tool schema is the honest answer) — or not exist at all,
    // which is an author error and throws.
    if (!entry && !methodIsDeclared(constructor, method)) {
        throw new Error(
            `toolSchemaForMethod: ${className} has no method '${String(method)}'. Pass the name of a ` +
                'method declared on the class (contracted or not).',
        );
    }

    const properties: JsonObject = {};
    const required: string[] = [];

    if (entry) {
        const params = entry.contract.params.slice().sort((a, b) => a.index - b.index);
        params.forEach(parameter => {
            const name =
                typeof parameter.name === 'string' && parameter.name.length > 0
                    ? parameter.name
                    : `arg${parameter.index}`;
            properties[name] = mergeFragments(schemaFragmentsOf(parameter.constraints));
            if (parameter.constraints.length > 0) required.push(name);
        });
    }

    const document: JsonObject = {
        title: `${className}.${String(method)}`,
        type: 'object',
        properties,
        required,
        additionalProperties: false,
    };
    if (options && typeof options.description === 'string') {
        document.description = options.description;
    }

    return canonicalize(document) as ToolSchema;
}

/**
 * Whether `method` is a real member of `constructor` — an instance method on the prototype chain, or
 * a static on the constructor chain — excluding the `Object.prototype`/`Function.prototype` members
 * every object inherits, so `'toString'`/`'name'` are not mistaken for a declared method. Used only
 * to distinguish an uncontracted-but-real method (empty tool schema) from a typo (throw).
 */
function methodIsDeclared(constructor: Function, method: string | symbol): boolean {
    const owns = Object.prototype.hasOwnProperty;
    for (
        let proto: object | null = constructor.prototype;
        proto && proto !== Object.prototype;
        proto = Object.getPrototypeOf(proto)
    ) {
        if (owns.call(proto, method)) return true;
    }
    for (
        let ctor: Function | null = constructor;
        typeof ctor === 'function' && ctor !== Function.prototype;
        ctor = Object.getPrototypeOf(ctor)
    ) {
        if (owns.call(ctor, method)) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Serialisation — the convenience that renders JSON (mirrors generateMarkdown)
// ---------------------------------------------------------------------------

/**
 * Serialise one class schema, or a whole array of them, to a JSON string.
 *
 * A single schema serialises as-is. An array serialises as a **bundle** — one document whose `$defs`
 * holds each class schema by title, with the inner per-class `$schema` stripped since the bundle's
 * own declares the dialect for all of them. An empty array is an honest empty bundle (`$defs: {}`),
 * not an error, exactly as an empty documentation model renders rather than throwing.
 */
export function serializeSchema(
    schema: ClassSchema | ReadonlyArray<ClassSchema>,
    options?: SchemaOptions,
): string {
    const indent = options && typeof options.indent === 'number' ? options.indent : DEFAULT_INDENT;
    // `Array.isArray`'s guard is `arg is any[]`, which does not narrow a `readonly` array out of the
    // union, so the single-schema branch is reached by exclusion and cast rather than by narrowing.
    const document: JsonObject = Array.isArray(schema) ? bundle(schema) : (schema as ClassSchema);
    return JSON.stringify(canonicalize(document), null, indent) + '\n';
}

/**
 * Walk the registry and serialise it in one call — the entry point a schema-generation script uses.
 *
 * Equivalent to `serializeSchema(schemaForContracts(), options)`.
 */
export function generateSchema(options?: SchemaOptions): string {
    return serializeSchema(schemaForContracts(), options);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * A method projects to its **argument tuple** — `{type: 'array', prefixItems: [<per-parameter>]}` —
 * plus, when it carries a reified `@Returns` contract (DEC-033), a `returns` sub-schema for the
 * return value (the OpenAPI-response half, IDEA-7/IDEA-12).
 *
 * Positions are filled `0..maxContractedIndex`; a gap (an undecorated position before a decorated
 * one) is `{}` (accept anything), the same gap-filling `docs.ts` does for signatures. No `minItems`/
 * `maxItems` and no `items: false`: arity is not reliably known and a trailing-optional or variadic
 * call must not be rejected (under-claim).
 *
 * `returns` is built from the descriptor `post` band with the exact same `schema()`-hook extraction and
 * conjunction merge parameters use — a descriptor with no `schema()` hook contributes `{}`, and the
 * whole under-claim discipline is inherited unchanged. It is an annotation keyword a tuple-validator
 * ignores (like `methods`/`staticMethods`), emitted only when the band is non-empty, so the argument
 * tuple stays an honest tuple schema.
 */
function methodSchema(className: string, entry: ClassMethodContract): JsonObject {
    const params = entry.contract.params;

    let highest = -1;
    params.forEach(parameter => {
        if (parameter.index > highest) highest = parameter.index;
    });

    const schema: JsonObject = {title: `${className}.${String(entry.key)}`, type: 'array'};

    if (highest >= 0) {
        const prefixItems: JsonValue[] = [];
        for (let index = 0; index <= highest; index++) {
            const match = params.filter(parameter => parameter.index === index)[0];
            prefixItems.push(match ? mergeFragments(schemaFragmentsOf(match.constraints)) : {});
        }
        schema.prefixItems = prefixItems;
    }

    const post = entry.contract.post;
    if (post.length > 0) {
        schema.returns = mergeFragments(schemaFragmentsOf(post));
    }

    return schema;
}

/**
 * The schema fragments for a constraint list, in order. A descriptor with no `schema()` hook
 * contributes nothing — the honest-degradation floor: a constraint we cannot express weakens the
 * position to "accept anything" rather than asserting a bound we cannot back.
 */
function schemaFragmentsOf(constraints: ReadonlyArray<ConstraintDescriptor>): JsonObject[] {
    const fragments: JsonObject[] = [];
    constraints.forEach(descriptor => {
        const hook = descriptor.schema;
        if (typeof hook !== 'function') return;
        const fragment = hook();
        if (fragment && typeof fragment === 'object' && !Array.isArray(fragment)) {
            fragments.push(fragment);
        }
    });
    return fragments;
}

/**
 * Compose several fragments as a **conjunction** (see the module header).
 *
 * `{}` for the empty case (accept anything); the single fragment cloned for one; a flat keyword merge
 * where every collision combines; and an `allOf` of the raw fragments the moment any keyword cannot
 * be combined in place. `allOf` is exact conjunction, so the fallback can never over-claim.
 */
function mergeFragments(fragments: JsonObject[]): JsonObject {
    if (fragments.length === 0) return {};
    if (fragments.length === 1) return {...fragments[0]};

    const merged: JsonObject = {};
    let conflicted = false;

    for (const fragment of fragments) {
        for (const key of Object.keys(fragment)) {
            if (!(key in merged)) {
                merged[key] = fragment[key];
                continue;
            }
            const combined = combineKeyword(key, merged[key], fragment[key]);
            if (combined === CONFLICT) {
                conflicted = true;
                break;
            }
            merged[key] = combined;
        }
        if (conflicted) break;
    }

    if (conflicted) return {allOf: fragments.map(fragment => ({...fragment}))};
    return merged;
}

/** The `minimum`/`exclusiveMinimum`/`minLength` family: a conjunction takes the **tighter** (higher) bound. */
const LOWER_BOUND_KEYWORDS = new Set(['minimum', 'exclusiveMinimum', 'minLength']);
/** The `maximum`/`exclusiveMaximum`/`maxLength` family: a conjunction takes the **tighter** (lower) bound. */
const UPPER_BOUND_KEYWORDS = new Set(['maximum', 'exclusiveMaximum', 'maxLength']);

/**
 * Combine one keyword's two values under conjunction, or {@link CONFLICT} when the flat merge cannot.
 * Equal values collapse to themselves, so only genuine disagreements reach the family rules.
 */
function combineKeyword(key: string, a: JsonValue, b: JsonValue): JsonValue | typeof CONFLICT {
    if (sameJson(a, b)) return a;
    if (key === 'type') return combineType(a, b);
    if (LOWER_BOUND_KEYWORDS.has(key) && typeof a === 'number' && typeof b === 'number') {
        return Math.max(a, b);
    }
    if (UPPER_BOUND_KEYWORDS.has(key) && typeof a === 'number' && typeof b === 'number') {
        return Math.min(a, b);
    }
    return CONFLICT;
}

/**
 * `integer ⊂ number`, so a conjunction of the two is `integer` — the stricter, and exactly the set
 * enforcement checks. Any other unequal pair is a genuine contradiction the flat merge defers to
 * `allOf` (an unsatisfiable conjunction accepts nothing, so even an `allOf` that a validator treats
 * as always-false is faithful — it cannot reject a value enforcement accepts, because enforcement
 * accepts none).
 */
function combineType(a: JsonValue, b: JsonValue): JsonValue | typeof CONFLICT {
    if ((a === 'integer' && b === 'number') || (a === 'number' && b === 'integer')) return 'integer';
    return CONFLICT;
}

/** Serialise an array of class schemas into one bundle document keyed by class title under `$defs`. */
function bundle(schemas: ReadonlyArray<ClassSchema>): JsonObject {
    const defs: JsonObject = {};
    schemas.forEach(schema => {
        const title = typeof schema.title === 'string' ? schema.title : '(anonymous class)';
        const embedded: JsonObject = {};
        Object.keys(schema).forEach(key => {
            // The bundle's own `$schema` declares the dialect for every embedded resource.
            if (key !== '$schema') embedded[key] = schema[key];
        });
        defs[title] = embedded;
    });
    return {$schema: DIALECT, $defs: defs};
}

/**
 * Recursively order object keys so a regenerated schema produces no spurious diff. Well-known
 * keywords lead in a natural reading order; the rest fall back to alphabetical. Array order is
 * preserved — it is semantic (`prefixItems` is positional).
 */
function canonicalize(value: JsonValue): JsonValue {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value !== null && typeof value === 'object') {
        const object = value as JsonObject;
        const ordered: JsonObject = {};
        Object.keys(object)
            .sort(compareKeys)
            .forEach(key => {
                ordered[key] = canonicalize(object[key]);
            });
        return ordered;
    }
    return value;
}

const KEY_ORDER = [
    '$schema',
    '$id',
    '$ref',
    '$defs',
    'title',
    'description',
    'type',
    'enum',
    'minimum',
    'exclusiveMinimum',
    'maximum',
    'exclusiveMaximum',
    'multipleOf',
    'minLength',
    'maxLength',
    'pattern',
    'format',
    'properties',
    'prefixItems',
    'returns',
    'items',
    'required',
    'additionalProperties',
    'allOf',
    'anyOf',
    'oneOf',
    'not',
    'methods',
    'staticMethods',
    'staticProperties',
];

function compareKeys(a: string, b: string): number {
    const ia = KEY_ORDER.indexOf(a);
    const ib = KEY_ORDER.indexOf(b);
    const ra = ia === -1 ? KEY_ORDER.length : ia;
    const rb = ib === -1 ? KEY_ORDER.length : ib;
    if (ra !== rb) return ra - rb;
    return a < b ? -1 : a > b ? 1 : 0;
}

function hasKeys(object: JsonObject): boolean {
    return Object.keys(object).length > 0;
}

function sameJson(a: JsonValue, b: JsonValue): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}
