/**
 * Sensitive-flow detector — the shared analysis core.
 *
 * ## What it is (the ratified design: spike §15 recommendation, DEC-026 + DEC-027)
 *
 * A **one-pass, report-only, source → adorn-sink detector, extended intraprocedurally.** It reports
 * where a `@Sensitive`-marked value reaches a parameter of one of adorn's **own** emitters. It writes
 * nothing (report-only, no `--fix`, permanently — DEC-023 point 2, §7.4). It does not iterate, does
 * not propagate across function boundaries, and has no notion of a fixpoint.
 *
 * ## The closed sink set (DEC-025, derived from the codebase — spike §14.2, `spike/sinks.js`)
 *
 * adorn secures **its own** emissions, which makes the sink set closed and enumerable:
 *   - **S1** a parameter of a method decorated `@Log()` — `src/MethodDecorators/Log.ts:92` renders
 *     *every* argument (BUG-18).
 *   - **S2** a parameter carrying an adorn constraint decorator — the violation-message path,
 *     `src/Core/Descriptor.ts:314 formatMessage → :323 formatReceived` interpolates the received
 *     value (BUG-19), reached from `ParameterDecoratorFactory.ts` `descriptorCheck`.
 *   - **S3** a parameter carrying the proposed `@Telemetry.value()` — *not implemented*; listed as a
 *     future sink on the strength of the observability/redaction plans, never invented into existence.
 *
 * **Deliberately NOT sinks**, each exclusion load-bearing: `@Time()` emits a label and a duration,
 * never an argument value (treating "adorn-decorated" as "emits" re-inflates false positives); field
 * violation messages (a field is covered by `@Sensitive` on the field directly); `console.log` and
 * everything else in application code (out of adorn's trust boundary — DEC-025); the docs projection.
 *
 * ## The intraprocedural propagator (DEC-027, +6 shapes at zero false-positive cost — spike §15.9)
 *
 * Beyond a value passed *directly*, the source classifier follows a `@Sensitive` value through
 * **same-function** local `const` aliases, template-literal interpolation (the
 * ``sink(`${s.ssn}`)`` shape — spike §6.2's "most dangerous blind spot", the six-line fix),
 * literal-keyed element access, and destructuring. No cross-function reasoning: that is the deferred
 * interprocedural version (DEC-028, IDEA-11).
 *
 * ## The permanent floor (spike §15.8, DEC-027)
 *
 * `s.ssn.slice(-4)` is caught by nothing at any budget — runtime observation misses it, substring
 * matching misses it, and an off-the-shelf static engine would declare it *clean* (a sanitizer
 * judgement adorn must not make). It is the accepted limit; the tests pin it as NOT caught.
 *
 * ## CLI-ready shape (DEC-023 point 3, IDEA-9)
 *
 * The core takes an already-built `ts.Program`, exactly what a typescript-eslint rule holds via
 * parser services and a CLI holds from `ts.createProgram`. {@link findCallFindings} is the per-call
 * unit the ESLint rule ({@link ./rule}) forwards each `CallExpression` to; {@link analyzeProgram}
 * walks a whole program and is what a CLI (`adorn check`) wraps. Both are thin over this one core.
 */

import * as ts from 'typescript';
import * as path from 'path';
import {isLegalMethodDecoratorHost, isLegalParameterDecoratorHost} from './legality';

// ---------------------------------------------------------------------------
// The decorator vocabulary — matched by name (standard for a lint rule)
// ---------------------------------------------------------------------------

/** The marker whose presence makes a value sensitive. */
const SENSITIVE_MARKER = 'Sensitive';

/** Method decorators that cause adorn to render every argument value (S1). */
const EMITTING_METHOD_DECORATORS = new Set(['Log']);

/** Method decorators that are adorn emitters but emit NO argument value (deliberately not sinks). */
const NON_EMITTING_METHOD_DECORATORS = new Set(['Time']);

/**
 * Parameter decorators whose presence routes that parameter's value into an adorn emission (S2/S3).
 * These are adorn's real per-parameter constraint decorators — a violation message interpolates the
 * received value (BUG-19) — plus the proposed `@Telemetry.value()` opt-in (S3, not implemented).
 */
const EMITTING_PARAM_DECORATORS = new Set([
    'LessThanEqual',
    'GreaterThanEqual',
    'LessThan',
    'GreaterThan',
    'Between',
    'Integer',
    'MultipleOf',
    'StringMinLength',
    'MinLength',
    'MaxLength',
    'NotEmpty',
    'Matches',
    'Email',
    'Url',
    'Telemetry',
]);

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export type SourceKind =
    | 'field' // s.ssn where ssn is @Sensitive
    | 'class-field' // s.ssn where s's class is @Sensitive
    | 'param' // an identifier bound to a @Sensitive parameter
    | 'local-alias' // const copy = s.ssn  (intraprocedural)
    | 'element-access' // s['ssn']          (intraprocedural)
    | 'destructure' // const {ssn} = s    (intraprocedural)
    | 'template'; // `${s.ssn}`         (intraprocedural)

export type Emitter = 'log' | 'violation-message' | 'telemetry';

export interface SensitiveSource {
    readonly kind: SourceKind;
    /** Human-readable origin, e.g. `Customer.ssn`. */
    readonly label: string;
}

/** An adorn emission position discovered while scanning — the denominator of the scope report. */
export interface EmissionPosition {
    readonly label: string; // e.g. AuditService.write(entry)
    readonly via: string; // @Log / @GreaterThan / ...
    readonly emitter: Emitter;
    readonly site: string; // file:line:col
}

/** A `@Sensitive` value reaching an adorn emission position. The actionable finding. */
export interface Leak {
    readonly source: SensitiveSource;
    readonly sink: {readonly label: string; readonly via: string; readonly emitter: Emitter};
    readonly site: string;
    /** The argument node, so the ESLint adapter can attach the report to it. */
    readonly node: ts.Node;
}

/**
 * A `@Sensitive` value flowing to a receiver adorn does not own — a raw function, `console.log`, a
 * `.d.ts` signature. Under DEC-025 adorn was never in this call path, so it is NOT analysed. Recorded
 * so the scope report can disclose it (DEC-026 point 4): a clean leak report that hides these is the
 * false-confidence failure the redaction plan §11.2 calls worse than no design.
 */
export interface OutOfScopeFlow {
    readonly source: SensitiveSource;
    readonly receiver: string;
    readonly site: string;
    readonly reason: 'external-declaration' | 'unresolved-callee' | 'non-adorn-receiver';
    readonly node: ts.Node;
}

export type CallFinding = ({type: 'leak'} & Leak) | ({type: 'out-of-scope'} & OutOfScopeFlow);

export interface AnalysisResult {
    /** Every adorn emission position found in the scanned files — what the analysis *could* see. */
    readonly analyzedSinks: EmissionPosition[];
    readonly leaks: Leak[];
    readonly outOfScope: OutOfScopeFlow[];
}

// ---------------------------------------------------------------------------
// Marking + decorator helpers
// ---------------------------------------------------------------------------

/** The root identifier of a decorator, unwrapping `@Enforce.min(3)` → `Enforce` and `@Log()` → `Log`. */
function decoratorRootName(decorator: ts.Decorator): string | undefined {
    let e: ts.Expression = decorator.expression;
    if (ts.isCallExpression(e)) e = e.expression;
    while (ts.isPropertyAccessExpression(e)) e = e.expression;
    return ts.isIdentifier(e) ? e.text : undefined;
}

function decoratorRootNames(node: ts.Node): string[] {
    if (!ts.canHaveDecorators(node)) return [];
    return (ts.getDecorators(node) ?? []).map(decoratorRootName).filter((n): n is string => n !== undefined);
}

/** Does this declaration carry `@Sensitive(...)`? */
function isSensitiveMarked(decl: ts.Node): boolean {
    return decoratorRootNames(decl).includes(SENSITIVE_MARKER);
}

/** Is the class declaring this member marked `@Sensitive` at the class level? */
function ownerClassIsSensitive(decl: ts.Node): boolean {
    const owner = decl.parent;
    return !!owner && ts.isClassDeclaration(owner) && isSensitiveMarked(owner);
}

function ownerName(decl: ts.Node): string {
    const p = decl.parent;
    if (p && (ts.isClassDeclaration(p) || ts.isInterfaceDeclaration(p)) && p.name) return p.name.text;
    return '<anonymous>';
}

function stripOuter(node: ts.Expression): ts.Expression {
    let n: ts.Expression = node;
    for (;;) {
        if (ts.isParenthesizedExpression(n)) n = n.expression;
        else if (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) n = n.expression;
        else if (ts.isNonNullExpression(n)) n = n.expression;
        else return n;
    }
}

function isConstVariable(decl: ts.VariableDeclaration): boolean {
    const list = decl.parent;
    return ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
}

// ---------------------------------------------------------------------------
// Source classification — is this argument expression a @Sensitive value?
// ---------------------------------------------------------------------------

const MAX_ALIAS_DEPTH = 8; // bound the intraprocedural const-alias chase

/**
 * Classify an argument expression as a sensitive source, or return `null`.
 *
 * Handles the direct shapes (property access, sensitive parameter) and the intraprocedural shapes the
 * local propagator adds (const alias, template interpolation, literal element access, destructuring).
 * Everything else — including `s.ssn.slice(-4)` — returns `null`, which is the design's honest floor.
 */
export function classifySource(
    expr: ts.Expression,
    checker: ts.TypeChecker,
    depth = 0,
): SensitiveSource | null {
    const e = stripOuter(expr);

    // Direct: s.ssn
    if (ts.isPropertyAccessExpression(e)) {
        return classifyMemberAccess(e.expression, e.name.text, checker);
    }

    // Intraprocedural: s['ssn'] with a literal key behaves exactly like s.ssn.
    if (ts.isElementAccessExpression(e) && isLiteralKey(e.argumentExpression)) {
        const src = classifyMemberAccess(e.expression, literalKeyText(e.argumentExpression), checker);
        return src ? {kind: 'element-access', label: src.label} : null;
    }

    // Direct: a @Sensitive parameter; intraprocedural: a local const alias or destructuring binding.
    if (ts.isIdentifier(e)) {
        return classifyIdentifier(e, checker, depth);
    }

    // Intraprocedural: `... ${s.ssn} ...` — a template with any sensitive span is sensitive.
    if (ts.isTemplateExpression(e)) {
        for (const span of e.templateSpans) {
            const inner = classifySource(span.expression, checker, depth);
            if (inner) return {kind: 'template', label: inner.label};
        }
        return null;
    }

    return null;
}

/** Resolve `object.property` (or `object['property']`) to a sensitive-field / class-field source. */
function classifyMemberAccess(
    object: ts.Expression,
    property: string,
    checker: ts.TypeChecker,
): SensitiveSource | null {
    const type = checker.getTypeAtLocation(object);
    const symbol = type.getProperty(property);
    if (!symbol || !symbol.declarations) return null;

    for (const d of symbol.declarations) {
        if ((ts.isPropertyDeclaration(d) || ts.isPropertySignature(d)) && isSensitiveMarked(d)) {
            return {kind: 'field', label: `${ownerName(d)}.${property}`};
        }
    }
    for (const d of symbol.declarations) {
        if (ownerClassIsSensitive(d)) {
            return {kind: 'class-field', label: `${ownerName(d)}.${property}`};
        }
    }
    return null;
}

function classifyIdentifier(
    id: ts.Identifier,
    checker: ts.TypeChecker,
    depth: number,
): SensitiveSource | null {
    const symbol = checker.getSymbolAtLocation(id);
    if (!symbol || !symbol.declarations) return null;

    for (const d of symbol.declarations) {
        // A @Sensitive parameter.
        if (ts.isParameter(d) && isSensitiveMarked(d)) {
            return {kind: 'param', label: parameterLabel(d)};
        }

        if (depth >= MAX_ALIAS_DEPTH) continue;

        // const copy = s.ssn  — follow the local (same-function) const alias.
        if (ts.isVariableDeclaration(d) && d.initializer && isConstVariable(d)) {
            const inner = classifySource(d.initializer, checker, depth + 1);
            if (inner) return {kind: 'local-alias', label: inner.label};
        }

        // const {ssn} = s  /  function f({ssn}: Subject)  — a destructuring binding.
        if (ts.isBindingElement(d)) {
            const inner = classifyBindingElement(d, checker, depth + 1);
            if (inner) return {kind: 'destructure', label: inner.label};
        }
    }
    return null;
}

/** `const {ssn} = s` or `function f({ssn}: T)`: is the destructured property sensitive? */
function classifyBindingElement(
    be: ts.BindingElement,
    checker: ts.TypeChecker,
    depth: number,
): SensitiveSource | null {
    const propertyName = bindingElementPropertyName(be);
    if (propertyName === undefined) return null;

    const pattern = be.parent; // ObjectBindingPattern
    if (!ts.isObjectBindingPattern(pattern)) return null;
    const declaration = pattern.parent; // VariableDeclaration | ParameterDeclaration

    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        return classifyMemberAccess(declaration.initializer, propertyName, checker);
    }
    if (ts.isParameter(declaration)) {
        const type = checker.getTypeAtLocation(declaration);
        const symbol = type.getProperty(propertyName);
        for (const d of symbol?.declarations ?? []) {
            if ((ts.isPropertyDeclaration(d) || ts.isPropertySignature(d)) && isSensitiveMarked(d)) {
                return {kind: 'destructure', label: `${ownerName(d)}.${propertyName}`};
            }
            if (ownerClassIsSensitive(d)) {
                return {kind: 'destructure', label: `${ownerName(d)}.${propertyName}`};
            }
        }
    }
    return null;
}

function bindingElementPropertyName(be: ts.BindingElement): string | undefined {
    // `{ssn}` → propertyName undefined, name is `ssn`; `{ssn: s}` → propertyName `ssn`.
    const nameNode = be.propertyName ?? be.name;
    if (ts.isIdentifier(nameNode)) return nameNode.text;
    if (ts.isStringLiteral(nameNode)) return nameNode.text;
    return undefined;
}

function isLiteralKey(node: ts.Expression): boolean {
    return ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node);
}
function literalKeyText(node: ts.Expression): string {
    return (node as ts.StringLiteralLike).text;
}

function parameterLabel(p: ts.ParameterDeclaration): string {
    const fn = p.parent;
    let fnName = '<anonymous>';
    const named = fn as {name?: ts.Node};
    if (named.name && ts.isIdentifier(named.name)) fnName = named.name.text;
    const owner =
        fn.parent && (ts.isClassDeclaration(fn.parent) || ts.isClassExpression(fn.parent)) && fn.parent.name
            ? `${fn.parent.name.text}.`
            : '';
    const pn = ts.isIdentifier(p.name) ? p.name.text : p.name.getText();
    return `${owner}${fnName}(${pn})`;
}

// ---------------------------------------------------------------------------
// Sink classification — is this parameter an adorn emission position?
// ---------------------------------------------------------------------------

export interface SinkClassification {
    readonly sink: boolean;
    readonly via?: string;
    readonly emitter?: Emitter;
    /** Present when a decorator *looks* like a sink but its host is decorator-illegal (SMELL-19). */
    readonly rejected?: string;
}

export function classifySink(param: ts.ParameterDeclaration): SinkClassification {
    // S2 / S3 — the parameter itself carries an emitting parameter decorator.
    for (const name of decoratorRootNames(param)) {
        if (EMITTING_PARAM_DECORATORS.has(name)) {
            const fn = param.parent;
            if (!isLegalParameterDecoratorHost(fn)) {
                return {sink: false, rejected: `@${name} on a decorator-illegal host`};
            }
            return {
                sink: true,
                via: `@${name}`,
                emitter: name === 'Telemetry' ? 'telemetry' : 'violation-message',
            };
        }
    }

    // S1 — the enclosing method is decorated with an argument-rendering method decorator.
    const fn = param.parent;
    if (ts.isMethodDeclaration(fn) || ts.isGetAccessorDeclaration(fn) || ts.isSetAccessorDeclaration(fn)) {
        const names = decoratorRootNames(fn);
        for (const name of names) {
            if (EMITTING_METHOD_DECORATORS.has(name)) {
                // SMELL-19: only honour @Log where it can legally be declared. A @Log on a
                // class-expression method would not compile, so it is not a real sink.
                if (!isLegalMethodDecoratorHost(fn)) {
                    return {sink: false, rejected: `@${name} on a decorator-illegal host (SMELL-19)`};
                }
                return {sink: true, via: `@${name}`, emitter: 'log'};
            }
        }
        for (const name of names) {
            if (NON_EMITTING_METHOD_DECORATORS.has(name)) {
                return {sink: false, rejected: `@${name} emits no argument value`};
            }
        }
    }

    return {sink: false};
}

// ---------------------------------------------------------------------------
// The one-pass walk
// ---------------------------------------------------------------------------

function locationOf(node: ts.Node): string {
    const sf = node.getSourceFile();
    const {line, character} = sf.getLineAndCharacterOfPosition(node.getStart());
    return `${path.basename(sf.fileName)}:${line + 1}:${character + 1}`;
}

/**
 * Analyse a single call/new expression. This is the unit the ESLint rule forwards each node to, so the
 * rule and a CLI share exactly this logic. Returns every finding at the call: leaks (a sensitive value
 * into an adorn sink) and out-of-scope flows (a sensitive value into a non-adorn receiver).
 */
export function findCallFindings(
    call: ts.CallExpression | ts.NewExpression,
    checker: ts.TypeChecker,
): CallFinding[] {
    const findings: CallFinding[] = [];
    const args = call.arguments ? Array.from(call.arguments) : [];
    if (args.length === 0) return findings;

    let signature: ts.Signature | undefined;
    try {
        signature = checker.getResolvedSignature(call);
    } catch {
        signature = undefined;
    }
    const sigDecl = signature?.declaration;
    const calleeText = call.expression.getText().slice(0, 80);

    for (let i = 0; i < args.length; i++) {
        const source = classifySource(args[i], checker);
        if (!source) continue;

        const site = locationOf(args[i]);

        // Unresolvable, or a `.d.ts` signature (console.log, Array#forEach, …). Under DEC-025 adorn is
        // not in this call path — out of scope, disclosed but not a leak.
        if (!sigDecl || sigDecl.getSourceFile().isDeclarationFile) {
            findings.push({
                type: 'out-of-scope',
                source,
                receiver: calleeText,
                site,
                reason: !sigDecl ? 'unresolved-callee' : 'external-declaration',
                node: args[i],
            });
            continue;
        }

        const params = (sigDecl as ts.SignatureDeclaration).parameters ?? [];
        if (params.length === 0) continue;
        const last = params[params.length - 1];
        const isRestTarget = !!last.dotDotDotToken && i >= params.length - 1;
        const target = isRestTarget ? last : params[i];
        if (!target || !ts.isParameter(target)) continue;

        const sink = classifySink(target);
        if (sink.sink) {
            findings.push({
                type: 'leak',
                source,
                sink: {label: parameterLabel(target), via: sink.via!, emitter: sink.emitter!},
                site,
                node: args[i],
            });
        } else {
            // A resolvable, non-adorn receiver. The sensitive value left adorn's scope.
            findings.push({
                type: 'out-of-scope',
                source,
                receiver: `${parameterLabel(target)}`,
                site,
                reason: 'non-adorn-receiver',
                node: args[i],
            });
        }
    }

    return findings;
}

/**
 * Walk a whole program and produce the full result — leaks, out-of-scope flows, and the set of adorn
 * emission positions the analysis could see. This is what a CLI (`adorn check`) wraps.
 *
 * `rootFiles` bounds the scan to the developer's own files (declaration files are always skipped).
 */
export function analyzeProgram(program: ts.Program, rootFiles: string[]): AnalysisResult {
    const checker = program.getTypeChecker();
    const roots = new Set(rootFiles.map(f => path.resolve(f).toLowerCase()));

    const analyzedSinks: EmissionPosition[] = [];
    const leaks: Leak[] = [];
    const outOfScope: OutOfScopeFlow[] = [];

    for (const sf of program.getSourceFiles()) {
        if (sf.isDeclarationFile) continue;
        if (!roots.has(path.resolve(sf.fileName).toLowerCase())) continue;

        collectEmissionPositions(sf, analyzedSinks);

        const visit = (node: ts.Node): void => {
            if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
                for (const finding of findCallFindings(node, checker)) {
                    if (finding.type === 'leak') leaks.push(finding);
                    else outOfScope.push(finding);
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(sf);
    }

    return {analyzedSinks, leaks, outOfScope};
}

/** Enumerate every adorn emission position declared in `sf` — the scope report's denominator. */
function collectEmissionPositions(sf: ts.SourceFile, out: EmissionPosition[]): void {
    const visit = (node: ts.Node): void => {
        if (
            ts.isParameter(node) &&
            (ts.isMethodDeclaration(node.parent) ||
                ts.isConstructorDeclaration(node.parent) ||
                ts.isGetAccessorDeclaration(node.parent) ||
                ts.isSetAccessorDeclaration(node.parent))
        ) {
            const sink = classifySink(node);
            if (sink.sink) {
                out.push({
                    label: parameterLabel(node),
                    via: sink.via!,
                    emitter: sink.emitter!,
                    site: locationOf(node),
                });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
}
