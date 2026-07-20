/**
 * SPIKE (third pass) — Option B, bounded probe.
 *
 * The brief says: assess Option B comparatively, mostly from evidence already gathered, and do
 * NOT build a taint engine. This is not one. It is a deliberately minimal INTRAPROCEDURAL alias
 * pass — local `const` bindings and template-literal propagation, within a single function body,
 * with no summaries, no fixpoint, no heap model and no cross-function reasoning.
 *
 * It exists to answer one question that decides how Option B should be scoped, and that the
 * §14 measurements cannot answer: of the 17 source-side blind spots, how many are actually
 * INTERprocedural, and how many are merely local severings that a single-function pass sees?
 *
 * "Full interprocedural analysis" is the expensive answer. If most of the 17 are local, the
 * expensive answer is being proposed for a problem the cheap one solves.
 *
 * Run:  node spike/observe-optionb.js
 */

'use strict';

const ts = require('typescript');
const path = require('path');
const {classifySource, isMarked} = require('./core');

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const ROOTS = [
    path.join(FIXTURE_DIR, 'blindspots-sink.ts'),
    path.join(FIXTURE_DIR, 'marker.ts'),
    path.join(FIXTURE_DIR, 'adorn-markers.ts'),
];

const program = ts.createProgram(ROOTS, {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    experimentalDecorators: true,
    strict: true,
    skipLibCheck: true,
});
const checker = program.getTypeChecker();
const sf = program.getSourceFile(ROOTS[0]);

/**
 * Is this expression a source, EXTENDED with two purely local rules:
 *   L1  an identifier bound by `const x = <source>` in this same body
 *   L2  a template literal with a source in any of its spans  (a "propagator", Semgrep's term)
 * plus the shorthand destructure `const {ssn} = s`.
 */
function localSourceAware(expr, locals) {
    if (classifySource(expr, checker)) return 'direct';

    const e = strip(expr);

    if (ts.isIdentifier(e)) {
        const sym = checker.getSymbolAtLocation(e);
        if (sym && locals.has(sym)) return locals.get(sym);
    }

    if (ts.isTemplateExpression(e)) {
        for (const span of e.templateSpans) {
            if (localSourceAware(span.expression, locals)) return 'template';
        }
    }

    // `s?.ssn ?? ''`
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
        if (localSourceAware(e.left, locals)) return 'nullish';
    }
    if (ts.isPropertyAccessChain && ts.isPropertyAccessChain(e)) {
        const sym = checker.getSymbolAtLocation(e.name);
        for (const d of (sym && sym.declarations) || []) {
            if ((ts.isPropertyDeclaration(d) || ts.isPropertySignature(d)) && isMarked(d)) return 'optional-chain';
        }
    }

    // `s[key]` where the key type is a union of string literals — statically knowable
    if (ts.isElementAccessExpression(e)) {
        const objType = checker.getTypeAtLocation(e.expression);
        const argType = checker.getTypeAtLocation(e.argumentExpression);
        const parts = argType.isUnion() ? argType.types : [argType];
        for (const t of parts) {
            if (!t.isStringLiteral || !t.isStringLiteral()) continue;
            const prop = objType.getProperty(t.value);
            for (const d of (prop && prop.declarations) || []) {
                if ((ts.isPropertyDeclaration(d) || ts.isPropertySignature(d)) && isMarked(d)) return 'index-literal';
            }
        }
    }

    return null;
}

function strip(n) {
    for (;;) {
        if (ts.isParenthesizedExpression(n)) n = n.expression;
        else if (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) n = n.expression;
        else if (ts.isNonNullExpression(n)) n = n.expression;
        else return n;
    }
}

/** Collect local `const` aliases and destructured bindings within one function body. */
function collectLocals(body) {
    const locals = new Map();
    const visit = node => {
        if (ts.isVariableDeclaration(node) && node.initializer) {
            if (ts.isIdentifier(node.name)) {
                const kind = localSourceAware(node.initializer, locals);
                if (kind) {
                    const sym = checker.getSymbolAtLocation(node.name);
                    if (sym) locals.set(sym, 'alias');
                }
            } else if (ts.isObjectBindingPattern(node.name)) {
                // const {ssn} = s
                const initType = checker.getTypeAtLocation(node.initializer);
                for (const el of node.name.elements) {
                    const propName = (el.propertyName || el.name).getText();
                    const prop = initType.getProperty(propName);
                    for (const d of (prop && prop.declarations) || []) {
                        if ((ts.isPropertyDeclaration(d) || ts.isPropertySignature(d)) && isMarked(d)) {
                            const sym = checker.getSymbolAtLocation(el.name);
                            if (sym) locals.set(sym, 'destructure');
                        }
                    }
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(body, visit);
    return locals;
}

/** Parameter-position destructuring: `function f({ssn}: Subject)` */
function collectParamDestructure(fn, locals) {
    for (const p of fn.parameters || []) {
        if (!ts.isObjectBindingPattern(p.name)) continue;
        const t = checker.getTypeAtLocation(p);
        for (const el of p.name.elements) {
            const propName = (el.propertyName || el.name).getText();
            const prop = t.getProperty(propName);
            for (const d of (prop && prop.declarations) || []) {
                if ((ts.isPropertyDeclaration(d) || ts.isPropertySignature(d)) && isMarked(d)) {
                    const sym = checker.getSymbolAtLocation(el.name);
                    if (sym) locals.set(sym, 'param-destructure');
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Walk every exported function and report which case ids become visible
// ---------------------------------------------------------------------------

const seen = new Map();

function analyseFunction(fn, caseName) {
    if (!fn.body) return;
    const locals = collectLocals(fn.body);
    collectParamDestructure(fn, locals);

    const visit = node => {
        if (ts.isCallExpression(node)) {
            for (const arg of node.arguments) {
                const kind = localSourceAware(arg, locals);
                if (kind) {
                    if (!seen.has(caseName)) seen.set(caseName, kind);
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn.body, visit);
}

ts.forEachChild(sf, node => {
    if (ts.isFunctionDeclaration(node) && node.name) analyseFunction(node, node.name.text);
});

// ---------------------------------------------------------------------------
// The 17 source-side blind spots from §14.4, with the reason each severs
// ---------------------------------------------------------------------------

const SEVENTEEN = [
    ['bs1_localVar', 'local const alias'],
    ['bs2_any', '`any` — no symbol, no declaration'],
    ['bs3_dynamic', 'computed key `s[key]`'],
    ['bs5_callback', 'array element into a callback'],
    ['bs5_install', 'callback installed into a higher-order function'],
    ['bs6_destructure', 'destructure in the body'],
    ['bs6_paramDestructure', 'destructure in the parameter list'],
    ['bs7_objectSpread', 'object spread'],
    ['bs7_argSpread', 'argument spread'],
    ['bs8_template', 'template-literal interpolation'],
    ['bs10_caller', 'value returned from another function'],
    ['bs11_transform', '.slice(-4) — a transform'],
    ['bs12_wrapped', 'wrapped in an object literal'],
    ['bs14_fieldWrite', 'laundered through an unmarked class field'],
    ['bs17_iface', 'dispatched through an interface'],
    ['bs18_indexSig', 'laundered through an index-signature bag'],
    ['bs19_optional', 'optional chaining + ??'],
];

console.log('');
console.log('=== B.1 — how many of the 17 are INTRAprocedural? ===');
console.log('');
console.log('  A minimal single-function-body pass: local const aliases, destructuring,');
console.log('  template propagation, literal-keyed element access. No summaries, no fixpoint,');
console.log('  no cross-function reasoning of any kind.');
console.log('');

/**
 * bs17_iface is NOT a source-severing case and must not be counted as one. Its argument
 * (`s.ssn`) is a plain marked property access, which is why this probe "sees" it — but §14.4
 * counts it as a miss because the SINK is unresolvable (the call resolves to an interface
 * MethodSignature, which can never host `@Log`). This probe does not model sinks at all, so it
 * cannot fix bs17. Class-hierarchy analysis fixes bs17; a local alias pass does not.
 */
const SINK_RESOLUTION_ONLY = new Set(['bs17_iface']);

let local = 0;
for (const [id, why] of SEVENTEEN) {
    const hit = seen.get(id);
    const counts = hit && !SINK_RESOLUTION_ONLY.has(id);
    if (counts) local++;
    const label = SINK_RESOLUTION_ONLY.has(id)
        ? 'source visible, SINK unresolvable'
        : hit
          ? 'SEEN by local pass  (' + hit + ')'
          : 'still missed';
    console.log('  ' + id.padEnd(22) + label.padEnd(36) + why);
}

console.log('');
console.log('  ' + local + ' of 17 are source-side severings caught WITHOUT any interprocedural analysis.');
console.log('   1 of 17 (bs17_iface) is a SINK-resolution problem, needing class-hierarchy analysis.');
console.log('  ' + (17 - local - 1) + ' of 17 need genuine interprocedural reasoning, or are unsolvable.');
console.log('');
console.log('  Of note: bs8_template — §6.2\'s "most dangerous blind spot", and the shape §14.4');
console.log('  singled out as in-scope and invisible — falls to a SIX-LINE local propagator.');
console.log('');
console.log('  cost of this pass: one program build, one walk — the ~907 ms one-pass figure of §14.3,');
console.log('  unchanged. It adds no rounds and no fixpoint.');

// ---------------------------------------------------------------------------
// B.2 — are A and B complementary? Compute the union directly.
// ---------------------------------------------------------------------------

// From spike/observe-run.js, exact-membership mode:
const RUNTIME_EXACT_MISSES = new Set(['bs8_template', 'bs11_transform']);
// From spike/observe-run.js, substring mode:
const RUNTIME_SUBSTRING_MISSES = new Set(['bs11_transform']);

const staticSeen = new Set();
for (const [id] of SEVENTEEN) {
    if (seen.get(id) && !SINK_RESOLUTION_ONLY.has(id)) staticSeen.add(id);
}

const ids = SEVENTEEN.map(([id]) => id);
const runtimeSeen = new Set(ids.filter(id => !RUNTIME_EXACT_MISSES.has(id)));

const both = ids.filter(id => runtimeSeen.has(id) && staticSeen.has(id));
const runtimeOnly = ids.filter(id => runtimeSeen.has(id) && !staticSeen.has(id));
const staticOnly = ids.filter(id => !runtimeSeen.has(id) && staticSeen.has(id));
const neither = ids.filter(id => !runtimeSeen.has(id) && !staticSeen.has(id));

console.log('');
console.log('=== B.2 — complementarity, over the 17 ===');
console.log('');
console.log('  caught by BOTH               ' + String(both.length).padStart(2) + '   ' + both.join(', '));
console.log('  RUNTIME only (A)             ' + String(runtimeOnly.length).padStart(2) + '   ' + runtimeOnly.join(', '));
console.log('  STATIC only (B, local pass)  ' + String(staticOnly.length).padStart(2) + '   ' + staticOnly.join(', '));
console.log('  caught by NEITHER            ' + String(neither.length).padStart(2) + '   ' + neither.join(', '));
console.log('');
console.log('  union: ' + (17 - neither.length) + '/17');
console.log('');
console.log("  Static's unique contribution is exactly " + staticOnly.length + ' case(s). Runtime substring mode');
console.log('  also covers ' + [...staticOnly].filter(id => !RUNTIME_SUBSTRING_MISSES.has(id)).length + ' of them — but at a 29.4% false-positive rate, where the static');
console.log('  propagator delivers it at zero. Same case, two prices.');
