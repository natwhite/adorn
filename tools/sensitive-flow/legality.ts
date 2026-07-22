/**
 * Decorator-host legality — derived from **compiled probes**, not from AST node kinds (SMELL-19).
 *
 * ## Why this exists as its own module, and why it compiles
 *
 * The spike's `classifyHost` decided legality by reading node kinds, and got one wrong: it grouped
 * `ts.isClassDeclaration(parent) || ts.isClassExpression(parent)` into one "class body" case and
 * called both decorator-legal. The compiler disagrees — a method of a class *expression*
 * (`const C = class { @D() m() {} }`) is **TS1206**, exactly like a free function. SMELL-19 records
 * that a `--fix` built on that classifier would have written non-compiling source into any codebase
 * using class expressions, and instructs: *"derive host legality from a compiled probe table, not
 * from node kinds."* This module does that.
 *
 * ## Why legality matters to a report-only detector at all
 *
 * The detector never writes decorators, so it does not need legality to *fix* anything. It needs it
 * to classify **sinks**. Under DEC-025/DEC-026 the sink set is closed, and a sink is a parameter of a
 * method carrying `@Log` (or a parameter carrying an adorn constraint/`@Telemetry` decorator). An
 * adorn emitter is a legacy decorator, so it is legal on exactly the positions `@Sensitive` is
 * (spike §14.3) — a class *declaration*'s concrete members and nothing else. A `@Log` written on a
 * class-expression method would not compile, so such a "sink" cannot exist in valid code; treating it
 * as one (the SMELL-19 bug) would invent a sink the compiler forbids. Grounding the verdict in a
 * compiled probe keeps the sink set honest.
 *
 * The probe table is computed once, lazily, and cached.
 */

import * as ts from 'typescript';
import {createInMemoryProgram} from './compilerHost';

/**
 * A host position, named so the *category* comes from the AST but the *legal/illegal verdict* comes
 * from the probe table — which is the whole SMELL-19 correction.
 */
export type HostCategory =
    | 'class-declaration-method'
    | 'class-declaration-static-method'
    | 'class-declaration-accessor'
    | 'class-declaration-constructor'
    | 'class-expression-method'
    | 'object-literal-method'
    | 'abstract-method'
    | 'overload-signature'
    | 'free-function'
    | 'function-expression'
    | 'arrow-function'
    | 'interface-method'
    | 'unknown';

interface Probe {
    readonly category: HostCategory;
    /** A snippet placing a legacy method decorator `@D()` at the category's position. */
    readonly code: string;
}

/**
 * One probe per method-hosting position. Each declares `D` so the *only* possible diagnostic is the
 * decorator-position error (TS1206, or a parse error such as TS1005/TS1109) — so "compiled clean"
 * means "the decorator is legal here".
 */
const METHOD_HOST_PROBES: readonly Probe[] = [
    {category: 'class-declaration-method', code: 'declare function D(): any; class C { @D() m() {} }'},
    {
        category: 'class-declaration-static-method',
        code: 'declare function D(): any; class C { @D() static m() {} }',
    },
    {
        category: 'class-declaration-accessor',
        code: 'declare function D(): any; class C { @D() get g() { return 1; } }',
    },
    {
        category: 'class-expression-method',
        code: 'declare function D(): any; const C = class { @D() m() {} };',
    },
    {category: 'object-literal-method', code: 'declare function D(): any; const o = { @D() m() {} };'},
    {
        category: 'abstract-method',
        code: 'declare function D(): any; abstract class C { @D() abstract m(): void; }',
    },
    {
        category: 'overload-signature',
        code: 'declare function D(): any; class C { @D() m(x: number): void; m(x: number) {} }',
    },
    {category: 'free-function', code: 'declare function D(): any; @D() function f() {}'},
    {category: 'interface-method', code: 'declare function D(): any; interface I { @D() m(): void; }'},
];

let cachedTable: Map<HostCategory, boolean> | undefined;

/**
 * The probe table: category → is a legacy decorator legal on it, per the compiler. Computed once.
 */
export function getLegalityTable(): Map<HostCategory, boolean> {
    if (cachedTable) return cachedTable;

    const table = new Map<HostCategory, boolean>();
    METHOD_HOST_PROBES.forEach((probe, i) => {
        const fileName = `probe_${i}.ts`;
        const {program} = createInMemoryProgram({[fileName]: probe.code});
        const sf = program.getSourceFile(fileName)!;
        const diagnostics = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)];
        // Legal iff nothing complained. The snippet is otherwise well-formed and `D` is declared, so
        // the only diagnostic a position can produce is its own decorator-illegality.
        table.set(probe.category, diagnostics.length === 0);
    });

    cachedTable = table;
    return table;
}

/**
 * The AST-only half: what *category* is this function/method node? The legal/illegal answer is then
 * looked up from {@link getLegalityTable}, never inferred here — that separation is the SMELL-19 fix.
 */
export function classifyHostCategory(fn: ts.Node): HostCategory {
    const parent = fn.parent;
    const inClassDeclaration = !!parent && ts.isClassDeclaration(parent);
    const inClassExpression = !!parent && ts.isClassExpression(parent);

    if (ts.isMethodDeclaration(fn)) {
        // A method of a class *expression* is TS1206 — the exact case SMELL-19 caught. Keep it a
        // distinct category so the probe (not a node-kind guess) supplies the verdict.
        if (inClassExpression) return 'class-expression-method';
        if (ts.isObjectLiteralExpression(parent!)) return 'object-literal-method';
        if (!inClassDeclaration) return 'unknown';
        const modifiers = ts.getModifiers(fn) ?? [];
        if (modifiers.some(m => m.kind === ts.SyntaxKind.AbstractKeyword)) return 'abstract-method';
        if (!fn.body) return 'overload-signature';
        if (modifiers.some(m => m.kind === ts.SyntaxKind.StaticKeyword)) {
            return 'class-declaration-static-method';
        }
        return 'class-declaration-method';
    }
    if (ts.isConstructorDeclaration(fn)) {
        return inClassDeclaration ? 'class-declaration-constructor' : 'unknown';
    }
    if (ts.isGetAccessorDeclaration(fn) || ts.isSetAccessorDeclaration(fn)) {
        return inClassDeclaration ? 'class-declaration-accessor' : 'unknown';
    }
    if (ts.isMethodSignature(fn)) return 'interface-method';
    if (ts.isFunctionDeclaration(fn)) return 'free-function';
    if (ts.isFunctionExpression(fn)) return 'function-expression';
    if (ts.isArrowFunction(fn)) return 'arrow-function';
    return 'unknown';
}

/**
 * Can this method/accessor node legally host an adorn *method* decorator (`@Log`)? Grounded in the
 * probe table. A constructor cannot host a method decorator; `class-declaration-constructor` is
 * therefore reported not-legal here even though it is a legal *parameter*-decorator host.
 */
export function isLegalMethodDecoratorHost(fn: ts.Node): boolean {
    const category = classifyHostCategory(fn);
    const table = getLegalityTable();
    // Constructors and accessors: a method decorator's legality follows the class-body membership the
    // probe measured for a method in the same position.
    if (category === 'class-declaration-constructor') return false; // no method decorator on a ctor
    return table.get(category) ?? false;
}

/**
 * Can a parameter of this function legally host an adorn *parameter* decorator (a constraint /
 * `@Telemetry`)? A legacy parameter decorator is legal on exactly the concrete class members a method
 * decorator is, plus the constructor. Grounded in the same probe table.
 */
export function isLegalParameterDecoratorHost(fn: ts.Node): boolean {
    const category = classifyHostCategory(fn);
    if (category === 'class-declaration-constructor') return true; // ctor params take decorators
    const table = getLegalityTable();
    return table.get(category) ?? false;
}
