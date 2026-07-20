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
 * ## Two contract bands: methods and fields (GAP-9)
 *
 * The registry records methods and fields in separate bands, and this module renders both. Until the
 * field band existed, `@Enforce.positive()` was enforced at runtime and **absent from every generated
 * document** — the DEC-011 failure shape exactly: an artifact that looks complete and is not.
 *
 * Fields are read through `getFieldContractsForClass`, which owns the two-key-band rule its method
 * twin does (DEC-018): a static field's contracts live on the constructor, an instance field's on the
 * prototype, and a projection walking only one silently drops half of them.
 *
 * A field is deliberately **not** modelled as a degenerate method. It has no parameters, no arity and
 * no pre/post, so {@link FieldDoc} carries a name and a constraint list rather than a `ParameterDoc[]`
 * — and unlike a parameter, its name is never an `argN` fallback, because a field's registry key *is*
 * its name. There is consequently no `nameRecovered` flag to carry.
 *
 * ## What this module does not invent
 *
 * Names and types reach the registry from the **real decorator path** now. `ParameterDecoratorFactory`
 * records the same recovered names its violation messages are built from — one computation, both
 * artifacts (BUG-14) — and the field factory records `design:type` when the toolchain emitted one.
 *
 * Where a toolchain supplies neither, this module renders the absence rather than a plausible guess.
 * `emitDecoratorMetadata` is unavailable under esbuild permanently (DEC-004), so the Type column is
 * empty rather than inferred from a first assigned value; and minification degrades recovered
 * parameter names to single letters (SMELL-1), which now propagates into documents. That propagation
 * is the **accepted trade, not a regression**: a document saying `s` about a check that also says `s`
 * is honest, whereas the `arg0`-versus-`sku` disagreement it replaced was two artifacts from one
 * declaration contradicting each other — precisely what DEC-006 exists to prevent.
 *
 * The renderer surfaces `installed: false` prominently for the same reason: per plan §8, a contract
 * recorded but never installed is unenforced *and* would be silently wrong in a generated artifact.
 * Silently absent from documentation is worse than unenforced at runtime, because nothing ever
 * throws to reveal it.
 */

import {ConstraintDescriptor, ConstraintKind, ConstraintParams} from '../Core/Descriptor';
import {
    ClassFieldContract,
    ClassMethodContract,
    getContractedClasses,
    getContractsForClass,
    getFieldContractsForClass,
} from '../Core/ContractRegistry';

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
    /**
     * Whether an installer has attached an enforcement wrapper. `false` means the contract is
     * recorded but **not enforced** — see the renderer's warning treatment.
     */
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

/**
 * One contracted field (GAP-9).
 *
 * Not a {@link MethodDoc} with one parameter: a field has no arity and no pre/post, so folding the two
 * together would ship permanently-empty slots and force a reader to disambiguate before reading —
 * the same reasoning that keeps the registry's two bands apart.
 */
export interface FieldDoc {
    /** `String(key)` — a symbol key renders as `Symbol(name)`. */
    readonly name: string;
    /** Recorded against the constructor rather than the prototype. */
    readonly isStatic: boolean;
    /**
     * `design:type` name, when one was recorded. **Advisory only**, exactly as
     * {@link ParameterDoc.typeName} is, and **absent entirely** under a transpile-only toolchain.
     * Never inferred from an assigned value — an absent type is rendered as absent.
     */
    readonly typeName?: string;
    /** Whether an installer has attached the validating accessor. */
    readonly installed: boolean;
    /** In declaration order — the field adapter normalises `__decorate`'s reversal at record time. */
    readonly constraints: ReadonlyArray<ConstraintDoc>;
}

/** One contracted class. */
export interface ClassDoc {
    readonly name: string;
    /** Instance methods first, then statics; alphabetical within each group. */
    readonly methods: ReadonlyArray<MethodDoc>;
    /** Instance fields first, then statics; alphabetical within each group. */
    readonly fields: ReadonlyArray<FieldDoc>;
}

// ---------------------------------------------------------------------------
// Step 1 — extraction
// ---------------------------------------------------------------------------

/**
 * Build the documentation model for one class, across **both** contract bands.
 *
 * The two-key-band walk — instance members on `constructor.prototype`, statics on `constructor`
 * itself — is not done here. It lives in `getContractsForClass` / `getFieldContractsForClass`
 * (DEC-018), which is the whole point of those APIs: a rule that four projections must each
 * re-derive, and whose omission produces a plausible-looking document missing every static rather
 * than an error, belongs in the registry once.
 *
 * Returns a `ClassDoc` with empty `methods` and `fields` when nothing is recorded — callers render
 * the empty case rather than having to special-case a `null`.
 */
export function documentClass(constructor: Function): ClassDoc {
    if (typeof constructor !== 'function') {
        throw new TypeError('documentClass: expected a constructor function');
    }

    const name = constructor.name || '(anonymous class)';

    const methods = getContractsForClass(constructor)
        .map((entry: ClassMethodContract) => toMethodDoc(name, entry));
    const fields = getFieldContractsForClass(constructor).map(toFieldDoc);

    // Deterministic ordering. Decoration order is not source order — parameter decorators are
    // evaluated right-to-left and members bottom-up — so registry insertion order is arbitrary
    // enough that sorting is both more predictable for a reader and stable across runs, which
    // keeps a regenerated document from producing spurious diffs. Fields sort by the same rule as
    // methods, so the two sections read alike.
    methods.sort(byBandThenName);
    fields.sort(byBandThenName);

    return {name, methods, fields};
}

/** Instance members before statics, alphabetical within each band. */
function byBandThenName(
    a: {isStatic: boolean; name: string},
    b: {isStatic: boolean; name: string},
): number {
    if (a.isStatic !== b.isStatic) return a.isStatic ? 1 : -1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
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

function toMethodDoc(className: string, entry: ClassMethodContract): MethodDoc {
    const name = String(entry.key);
    const parameters = entry.contract.params.map(toParameterDoc);

    return {
        name,
        isStatic: entry.isStatic,
        signature: buildSignature(className, name, parameters),
        installed: entry.contract.installed,
        parameters,
        pre: entry.contract.pre.map(toConstraintDoc),
        post: entry.contract.post.map(toConstraintDoc),
    };
}

/**
 * Flatten one registry field entry.
 *
 * No name fallback and no `nameRecovered`: the registry key *is* the field's name, so the whole
 * `argN` problem parameters have simply does not arise here.
 */
function toFieldDoc(entry: ClassFieldContract): FieldDoc {
    const doc: FieldDoc = {
        name: String(entry.key),
        isStatic: entry.isStatic,
        installed: entry.contract.installed,
        constraints: entry.contract.constraints.map(toConstraintDoc),
    };

    // Same treatment as a parameter's `type`: a live `Function` is not serialisable, so only its
    // name crosses into the model, and it is *absent* rather than undefined when the toolchain
    // emitted none. Nothing here infers a type from anything else.
    const type = entry.contract.type;
    if (type && typeof type.name === 'string' && type.name.length > 0) {
        return {...doc, typeName: type.name};
    }
    return doc;
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

        // Keyed on **both** bands. Keying on `methods` alone reported a field-only class as having
        // no contracts at all — a document that looks complete and is not, produced by the very
        // module whose job is to prevent that (DEC-011).
        if (classDoc.methods.length === 0 && classDoc.fields.length === 0) {
            lines.push('_No contracts recorded._', '');
            return;
        }

        classDoc.methods.forEach(method => renderMethod(method, lines));
        renderFields(classDoc.fields, lines);
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
 * Fields render as **one table for the class**, not a heading each.
 *
 * A method gets a `###` heading because it has a signature to head a section with; a field has only a
 * name, so per-field headings would be pure noise. The table reuses the parameter table's shape and
 * its one-row-per-constraint rule, minus the parameter index — the column that has no field analogue.
 */
function renderFields(fields: ReadonlyArray<FieldDoc>, lines: string[]): void {
    if (fields.length === 0) return;

    lines.push('### Fields', '');

    const unenforced = fields.filter(field => !field.installed);
    if (unenforced.length > 0) {
        // The same loud treatment a recorded-but-uninstalled method gets, for the same reason. Named
        // individually rather than as a blanket banner because one table can hold both enforced and
        // unenforced fields, and a reader must be able to tell which rows describe a guarantee that
        // does not actually hold at runtime.
        lines.push(
            '> **Not enforced.** Contracts are recorded for ' +
            unenforced.map(field => `\`${escapeCell(field.name)}\``).join(', ') +
            ' but no validating accessor is installed.',
            '',
        );
    }

    // A field entry can exist carrying only a reflected type — `setFieldMetadata` creates one — so
    // the constraint-free case is reachable and gets the parameter table's treatment rather than an
    // empty table with a header and no rows.
    if (!fields.some(field => field.constraints.length > 0)) {
        lines.push('_No field constraints recorded._', '');
        return;
    }

    lines.push(
        '| Field | Type | Constraint | Expectation |',
        '| --- | --- | --- | --- |',
    );

    fields.forEach(field => {
        field.constraints.forEach(constraint => {
            lines.push(
                `| \`${escapeCell(field.name)}\`${field.isStatic ? ' _(static)_' : ''} ` +
                `| ${field.typeName ? '`' + escapeCell(field.typeName) + '`' : '—'} ` +
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
