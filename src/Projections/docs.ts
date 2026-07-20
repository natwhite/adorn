/**
 * The documentation projection — the first of the four artifacts DEC-006 promises from one
 * contract declaration.
 *
 * Documentation is deliberately built first (ISSUES.md IDEA-7, plan §9). It is the safest of the
 * four: it needs only `constraint` + `params` + `describe()` from a descriptor, plus enumeration
 * from the registry. There is no oracle problem (postconditions, IDEA-4) and no generator problem
 * (arbitraries for hand-written predicates, Q-3). If this projection works, the architecture is
 * proven end to end at the lowest available risk.
 *
 * ## Layering (DEC-012, plan §2)
 *
 * This module imports from `Core/` only. It must **never** import a decorator type or reach into
 * adapter specifics — not `target`/`propertyKey`, not a stage-3 context, not `__decorate`
 * behaviour. A projection that binds to an adapter turns "four artifacts from one declaration"
 * into "four artifacts from the *legacy* syntax", stranding every consumer on standard decorators.
 * That is the precise reach problem DEC-003 exists to solve.
 *
 * The practical test: everything below reads the registry and descriptors. Swap the legacy
 * per-parameter adapter for a method-level `@Contract({...})` on standard decorators and not one
 * line here changes.
 *
 * ## Two steps, and the seam between them
 *
 * 1. **Extract** — walk the registry into a plain-data model (`ClassDoc` / `MethodDoc` /
 *    `ParameterDoc` / `ConstraintDoc`). Nothing markdown-specific happens here.
 * 2. **Render** — turn that model into markdown.
 *
 * **The seam for the other three projections is step 1.** `documentClass` / `documentContracts`
 * answer "what contracts exist, on what, with what params" — which is exactly the question a JSON
 * Schema emitter, an arbitrary bridge, and a fuzz driver each start from. They diverge only in
 * what they read off the descriptor:
 *
 * | Projection      | Reads from the descriptor        | Blocked on                       |
 * |-----------------|----------------------------------|----------------------------------|
 * | docs (here)     | `constraint`, `params`, `describe()` | nothing                      |
 * | schema          | `schema()` (optional hook)       | no built-in supplies one yet     |
 * | arbitraries     | `arbitrary()` (optional hook)    | `fast-check` is not a dependency |
 * | fuzz            | `arbitrary()` + `post`           | postconditions (IDEA-4)          |
 *
 * Note `ConstraintDoc` carries `params` even though the markdown renderer never prints them —
 * `describe()` already states the bound in prose, so printing `{"min":0}` beside "a number greater
 * than or equal to 0" is noise *in a document*. It is not noise in the model: `params` is precisely
 * what a schema projection reads. Keeping it in step 1 and dropping it in step 2 is what makes the
 * seam real rather than asserted.
 *
 * When a second projection lands, these extraction functions move to their own module unchanged.
 * They are not there already because a shared-model module with exactly one consumer is the
 * premature abstraction plan risk 10 and DEC-010 both warn about at this layer.
 *
 * ## Deliberately not built here
 *
 * No JSON Schema or OpenAPI emitter, no test generation, no arbitraries. Documentation only.
 *
 * ## Status: the registry is not yet populated by real decorators
 *
 * Registry-driven installation is **P1.3** and is not landed. Until it is, nothing writes to the
 * registry except a caller doing so explicitly through `recordParameterConstraint` /
 * `setParameterMetadata` / `registerContractedClass`. This projection is written against the
 * registry's *read* API and needs no change when P1.3 starts populating it for real — but end to
 * end, "decorate a class, get docs" does not work yet. That is a wiring gap, not a gap here.
 *
 * This is also why the renderer surfaces `installed: false` prominently: per plan §8, a class whose
 * contracts were recorded but never installed is unenforced *and* would be silently wrong in a
 * generated artifact. Silently absent from documentation is worse than unenforced at runtime,
 * because nothing ever throws to reveal it.
 */

import {ConstraintDescriptor, ConstraintKind, ConstraintParams} from '../Core/Descriptor';
import {getContracts, getContractedClasses, MethodContract, MethodKey} from '../Core/ContractRegistry';

// ---------------------------------------------------------------------------
// The model — step 1's output. Plain data, no markdown.
// ---------------------------------------------------------------------------

/** One constraint, flattened to what a projection reads. */
export interface ConstraintDoc {
    /** Identity — `'min'`, `'minLength'`, … This is what documentation *names*. */
    readonly constraint: string;
    /** Domain: `'number' | 'string' | 'generic'`. */
    readonly kind: ConstraintKind;
    /**
     * The params the descriptor was built from. Unused by the markdown renderer; carried because
     * this is what a schema projection reads. See the seam note in the module header.
     */
    readonly params: ConstraintParams;
    /** The descriptor's own human phrase, e.g. `a number greater than or equal to 0`. */
    readonly expectation: string;
}

/** One contracted parameter position. */
export interface ParameterDoc {
    readonly index: number;
    /**
     * The recovered parameter name, or `arg{index}` when none is available. Names are genuinely
     * not always recoverable at runtime — minification renames parameters and there is no other
     * runtime source (plan §1.4) — so this always has a value and {@link nameRecovered} says
     * whether it is real.
     */
    readonly name: string;
    /** `false` when {@link name} is the positional `arg{index}` fallback. */
    readonly nameRecovered: boolean;
    /**
     * `design:paramtypes` name, when one was recorded. **Advisory only** — the emitter erases
     * interfaces, unions, and generics to `Object`, so a doc reader must not treat this as the
     * declared type.
     */
    readonly typeName?: string;
    readonly constraints: ReadonlyArray<ConstraintDoc>;
}

/** One contracted method. */
export interface MethodDoc {
    /** `String(key)` — a symbol key renders as `Symbol(name)`. */
    readonly name: string;
    /** Recorded against the constructor rather than the prototype. */
    readonly isStatic: boolean;
    /**
     * e.g. `Task.send(message, count)`.
     *
     * Built from positions `0..maxContractedIndex`, because the registry only records positions
     * that were decorated — it has no source of the method's true arity. A method whose last
     * parameter carries no constraint therefore shows a signature shorter than the real one, and
     * an undecorated position *before* a decorated one shows as `argN`.
     */
    readonly signature: string;
    /** Whether an installer has attached enforcement. `false` for everything until P1.3 lands. */
    readonly installed: boolean;
    /** Ordered by parameter index. Only positions with a registry entry appear. */
    readonly parameters: ReadonlyArray<ParameterDoc>;
    /**
     * Reserved slots (registry P1.1), always empty in T0/T1 — no writer exists for them yet.
     * Carried so postconditions (IDEA-4, the top Tier 2 item) extend the renderer rather than
     * the model. Not rendered, for the same reason: an unreachable render branch is untestable.
     */
    readonly pre: ReadonlyArray<ConstraintDoc>;
    readonly post: ReadonlyArray<ConstraintDoc>;
}

/** One contracted class. */
export interface ClassDoc {
    readonly name: string;
    /** Instance methods first, then statics; alphabetical within each group. */
    readonly methods: ReadonlyArray<MethodDoc>;
}

// ---------------------------------------------------------------------------
// Step 1 — extraction
// ---------------------------------------------------------------------------

/**
 * Build the documentation model for one class.
 *
 * Reads both `constructor.prototype` (instance methods) and `constructor` itself (statics), since
 * the registry keys on "a prototype or constructor" and a static method's contracts land on the
 * latter. Missing either would drop contracts from the artifact silently.
 *
 * Returns a `ClassDoc` with an empty `methods` array when nothing is recorded — callers render the
 * empty case rather than having to special-case a `null`.
 */
export function documentClass(constructor: Function): ClassDoc {
    if (typeof constructor !== 'function') {
        throw new TypeError('documentClass: expected a constructor function');
    }

    const name = constructor.name || '(anonymous class)';
    const methods = collectMethods(constructor.prototype, name, false)
        .concat(collectMethods(constructor, name, true));

    // Deterministic ordering. Decoration order is not source order — parameter decorators are
    // evaluated right-to-left and members bottom-up — so registry insertion order is arbitrary
    // enough that sorting is both more predictable for a reader and stable across runs, which
    // keeps a regenerated document from producing spurious diffs.
    methods.sort((a, b) => {
        if (a.isStatic !== b.isStatic) return a.isStatic ? 1 : -1;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });

    return {name, methods};
}

/**
 * Build the documentation model for every class in the enumerable registry (DEC-011) — the
 * question a `WeakMap` cannot answer, and the reason the enumerable companion `Set` exists.
 *
 * **Limitation, inherent to runtime introspection (DEC-007):** this reflects only what has been
 * imported and evaluated. A class nothing imports is invisible, so a documentation run needs an
 * entry point that imports the modules to be documented. A static analyser would not need one;
 * that trade was accepted deliberately in exchange for no build-tool lock-in.
 *
 * Order follows the registry's own registration order rather than being sorted, since that is the
 * order the enumeration API defines.
 */
export function documentContracts(): ClassDoc[] {
    return getContractedClasses().map(documentClass);
}

function collectMethods(target: object, className: string, isStatic: boolean): MethodDoc[] {
    const methods: MethodDoc[] = [];

    getContracts(target).forEach((contract: MethodContract, key: MethodKey) => {
        methods.push(toMethodDoc(className, key, contract, isStatic));
    });

    return methods;
}

function toMethodDoc(
    className: string,
    key: MethodKey,
    contract: MethodContract,
    isStatic: boolean,
): MethodDoc {
    const name = String(key);
    const parameters = contract.params.map(toParameterDoc);

    return {
        name,
        isStatic,
        signature: buildSignature(className, name, parameters),
        installed: contract.installed,
        parameters,
        pre: contract.pre.map(toConstraintDoc),
        post: contract.post.map(toConstraintDoc),
    };
}

function toParameterDoc(parameter: {
    readonly index: number;
    readonly name?: string;
    readonly type?: Function;
    readonly constraints: ReadonlyArray<ConstraintDescriptor>;
}): ParameterDoc {
    const recovered = typeof parameter.name === 'string' && parameter.name.length > 0;

    const doc: ParameterDoc = {
        index: parameter.index,
        name: recovered ? (parameter.name as string) : `arg${parameter.index}`,
        nameRecovered: recovered,
        constraints: parameter.constraints.map(toConstraintDoc),
    };

    // `type` is a live `Function` and is not serialisable, so only its name crosses into the model.
    // Absent rather than undefined when unknown, matching how the descriptor treats its own
    // optional hooks.
    if (parameter.type && typeof parameter.type.name === 'string' && parameter.type.name.length > 0) {
        return {...doc, typeName: parameter.type.name};
    }
    return doc;
}

/**
 * Flatten a descriptor to the data a document needs.
 *
 * `expectation` comes from the descriptor's own `describe()`, which is derived from `params` by the
 * same definition that derived the predicate (DEC-010). That is what makes generated documentation
 * trustworthy: it cannot describe a bound the enforcement does not check, because both come from
 * one source. Documentation that *looks* authoritative while disagreeing with enforcement is Q-4,
 * the worst failure mode this whole goal introduces.
 */
function toConstraintDoc(descriptor: ConstraintDescriptor): ConstraintDoc {
    return {
        constraint: descriptor.constraint,
        kind: descriptor.kind,
        params: descriptor.params,
        expectation: descriptor.describe(),
    };
}

function buildSignature(className: string, methodName: string, parameters: ReadonlyArray<ParameterDoc>): string {
    let highest = -1;
    parameters.forEach(parameter => {
        if (parameter.index > highest) highest = parameter.index;
    });

    const slots: string[] = [];
    for (let index = 0; index <= highest; index++) {
        const match = parameters.find(parameter => parameter.index === index);
        slots.push(match ? match.name : `arg${index}`);
    }

    return `${className}.${methodName}(${slots.join(', ')})`;
}

// ---------------------------------------------------------------------------
// Step 2 — markdown rendering
// ---------------------------------------------------------------------------

export interface MarkdownOptions {
    /** Top-level heading. Defaults to `Contracts`. */
    readonly title?: string;
}

const DEFAULT_TITLE = 'Contracts';

/**
 * Render a documentation model as markdown.
 *
 * Constraint `params` are deliberately not printed: `expectation` is those params already stated in
 * prose, so printing both is redundant *in a document*. The model keeps them for the projections
 * that read them — see the seam note in the module header.
 */
export function renderMarkdown(classes: ReadonlyArray<ClassDoc>, options?: MarkdownOptions): string {
    const title = (options && options.title) || DEFAULT_TITLE;
    const lines: string[] = [`# ${title}`, ''];

    if (classes.length === 0) {
        lines.push('_No contracted classes are registered._');
        lines.push('');
        // Not a footnote: an empty document is the expected result of forgetting to import the
        // modules being documented, and that is indistinguishable from "there are no contracts"
        // unless it is said out loud (DEC-007).
        lines.push(
            'Contracts are discovered at runtime, so a class is only visible once the module ' +
            'declaring it has been imported and evaluated.',
        );
        return lines.join('\n') + '\n';
    }

    classes.forEach(classDoc => {
        lines.push(`## ${classDoc.name}`, '');

        if (classDoc.methods.length === 0) {
            lines.push('_No contracts recorded._', '');
            return;
        }

        classDoc.methods.forEach(method => renderMethod(method, lines));
    });

    return lines.join('\n').replace(/\n+$/, '') + '\n';
}

/**
 * Walk the registry and render it in one call — the entry point a documentation script uses.
 *
 * Equivalent to `renderMarkdown(documentContracts(), options)`.
 */
export function generateMarkdown(options?: MarkdownOptions): string {
    return renderMarkdown(documentContracts(), options);
}

function renderMethod(method: MethodDoc, lines: string[]): void {
    lines.push(`### ${method.signature}${method.isStatic ? ' _(static)_' : ''}`, '');

    if (!method.installed) {
        // Loud on purpose. An uninstalled contract is recorded but not enforced, so this document
        // would otherwise describe a guarantee that does not hold at runtime (plan §8, risk 1).
        lines.push(
            '> **Not enforced.** Contracts are recorded for this method but no enforcement ' +
            'wrapper is installed.',
            '',
        );
    }

    const hasConstraints = method.parameters.some(parameter => parameter.constraints.length > 0);
    if (!hasConstraints) {
        lines.push('_No parameter constraints recorded._', '');
        return;
    }

    lines.push(
        '| Parameter | Type | Constraint | Expectation |',
        '| --- | --- | --- | --- |',
    );

    method.parameters.forEach(parameter => {
        parameter.constraints.forEach(constraint => {
            lines.push(
                `| \`${escapeCell(parameter.name)}\` (${parameter.index}) ` +
                `| ${parameter.typeName ? '`' + escapeCell(parameter.typeName) + '`' : '—'} ` +
                `| \`${escapeCell(constraint.constraint)}\` ` +
                `| ${escapeCell(constraint.expectation)} |`,
            );
        });
    });

    lines.push('');
}

/**
 * A constraint's `describe()` is author-supplied prose and may contain a `|` — a `matches`
 * constraint over `^a|b$` is the obvious case — which would silently split a table row.
 */
function escapeCell(value: string): string {
    return value.replace(/\|/g, '\\|');
}
