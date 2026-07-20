/**
 * SPIKE — iterative single-hop sensitive-flow analysis core.
 *
 * NOT SHIPPED. Excluded from tsconfig, eslint and prettier. See docs/sensitive-flow-spike.md.
 *
 * The design under test, in the user's words: "Single-hop, but when that's resolved it should
 * error on the next hop in the chain."
 *
 *   1. find a @Sensitive-marked expression passed DIRECTLY as an argument
 *   2. if the receiving parameter is not itself marked, report it
 *   3. --fix writes @Sensitive() onto that parameter, which makes it a source
 *   4. repeat
 *
 * This module is deliberately written against the raw TypeScript compiler API and exposes a
 * `analyzeProgram(program)` entry point that takes an already-built `ts.Program`. That is the
 * shape a typescript-eslint rule would have to consume too (it holds a Program via
 * `parserServices`), so the same core can be driven from both — question 6 in the brief.
 */
'use strict';

const ts = require('typescript');
const path = require('path');

const MARKER = 'Sensitive';

/* ------------------------------------------------------------------ *
 * marking predicates                                                  *
 * ------------------------------------------------------------------ */

const JSDOC_TAG = '@sensitive';

/**
 * Does this declaration carry a marking — EITHER a `@Sensitive(...)` decorator OR the
 * `/** @sensitive *\/` JSDoc form?
 *
 * Both are recognised because the spike measured that a decorator is syntactically illegal
 * on most parameters (spike/legality.js), so `--fix` has to fall back to JSDoc, and the next
 * round has to be able to read back what the previous round wrote.
 */
function isMarked(decl) {
    if (!decl) return false;
    if (ts.canHaveDecorators(decl)) {
        const decorators = ts.getDecorators(decl);
        if (
            decorators &&
            decorators.some((d) => {
                const e = ts.isCallExpression(d.expression) ? d.expression.expression : d.expression;
                return ts.isIdentifier(e) && e.text === MARKER;
            })
        ) {
            return true;
        }
    }
    return hasJsDocMarking(decl);
}

/**
 * JSDoc detection. NOTE the asymmetry this exposes and which the doc calls out: a leading
 * `/** @sensitive *\/` comment is NOT attached to the parameter node by the parser as JSDoc
 * (only a *declaration*'s leading comment becomes `.jsDoc`), so this has to fall back to a
 * raw text scan of the preceding trivia. That fragility is a finding, not an implementation
 * shortcut — see the doc.
 */
function hasJsDocMarking(decl) {
    if (decl.jsDoc && decl.jsDoc.some((d) => (d.getText() || '').includes(JSDOC_TAG))) return true;
    const sf = decl.getSourceFile();
    const full = sf.text.slice(decl.getFullStart(), decl.getStart());
    return full.includes(JSDOC_TAG);
}

/** Text of the `@Sensitive(...)` argument list, so `--fix` can detect a *differing* marking. */
function markingArgs(decl) {
    if (!decl || !ts.canHaveDecorators(decl)) return null;
    const decorators = ts.getDecorators(decl) || [];
    for (const d of decorators) {
        if (!ts.isCallExpression(d.expression)) continue;
        const e = d.expression.expression;
        if (ts.isIdentifier(e) && e.text === MARKER) {
            return d.expression.arguments.map((a) => a.getText()).join(', ');
        }
    }
    return null;
}

/* ------------------------------------------------------------------ *
 * source classification — is this argument expression sensitive?      *
 * ------------------------------------------------------------------ */

/**
 * Returns a description of why an expression is sensitive, or null.
 *
 * DELIBERATELY LITERAL. The design says "passed *directly* as an argument". Anything that is
 * not a marked property access or a marked parameter identifier is NOT a source. Every case
 * that falls through here is a blind spot, and the point of the spike is to enumerate them.
 */
function classifySource(expr, checker) {
    const e = stripOuter(expr);

    if (ts.isPropertyAccessExpression(e)) {
        const sym = checker.getSymbolAtLocation(e.name);
        const decls = (sym && sym.declarations) || [];
        for (const d of decls) {
            if ((ts.isPropertyDeclaration(d) || ts.isPropertySignature(d)) && isMarked(d)) {
                return {kind: 'field', label: `${ownerName(d)}.${e.name.text}`, decl: d};
            }
        }
        // class-level marking: @Sensitive() class Foo {} marks every field
        for (const d of decls) {
            const owner = d.parent;
            if (owner && ts.isClassDeclaration(owner) && isMarked(owner)) {
                return {kind: 'class-field', label: `${ownerName(d)}.${e.name.text}`, decl: d};
            }
        }
        return null;
    }

    if (ts.isIdentifier(e)) {
        const sym = checker.getSymbolAtLocation(e);
        const decls = (sym && sym.declarations) || [];
        for (const d of decls) {
            if (ts.isParameter(d) && isMarked(d)) {
                return {kind: 'param', label: paramLabel(d), decl: d};
            }
        }
        return null;
    }

    return null;
}

function stripOuter(node) {
    let n = node;
    for (;;) {
        if (ts.isParenthesizedExpression(n)) n = n.expression;
        else if (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) n = n.expression;
        else if (ts.isNonNullExpression(n)) n = n.expression;
        else return n;
    }
}

function ownerName(decl) {
    const p = decl.parent;
    if (p && (ts.isClassDeclaration(p) || ts.isInterfaceDeclaration(p)) && p.name) return p.name.text;
    return '<anon>';
}

function paramLabel(p) {
    const fn = p.parent;
    const fnName =
        fn && fn.name && ts.isIdentifier(fn.name)
            ? fn.name.text
            : fn && fn.name
              ? fn.name.getText()
              : '<anon>';
    const pn = ts.isIdentifier(p.name) ? p.name.text : p.name.getText();
    return `${fnName}(${pn})`;
}

/* ------------------------------------------------------------------ *
 * the single hop                                                      *
 * ------------------------------------------------------------------ */

function analyzeProgram(program, rootFiles) {
    const checker = program.getTypeChecker();
    const findings = [];
    const roots = new Set(rootFiles.map((f) => path.resolve(f).toLowerCase()));

    for (const sf of program.getSourceFiles()) {
        if (sf.isDeclarationFile) continue;
        if (!roots.has(path.resolve(sf.fileName).toLowerCase())) continue;
        visit(sf);
    }

    function visit(node) {
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
            inspectCall(node);
        }
        ts.forEachChild(node, visit);
    }

    function inspectCall(call) {
        const args = call.arguments || [];
        if (args.length === 0) return;

        let sig;
        try {
            sig = checker.getResolvedSignature(call);
        } catch {
            sig = undefined;
        }
        const sigDecl = sig && sig.declaration;

        for (let i = 0; i < args.length; i++) {
            const src = classifySource(args[i], checker);
            if (!src) continue;

            const site = locOf(args[i]);

            if (!sigDecl) {
                findings.push({
                    type: 'unresolved-callee',
                    source: src.label,
                    site,
                    calleeText: call.expression.getText().slice(0, 60),
                });
                continue;
            }

            // A signature declared in a .d.ts (console.log, Array.prototype.forEach, ...) is a
            // boundary the tool cannot annotate: there is no source to write into.
            if (sigDecl.getSourceFile().isDeclarationFile) {
                findings.push({
                    type: 'external-boundary',
                    source: src.label,
                    site,
                    calleeText: call.expression.getText().slice(0, 60),
                    declFile: path.basename(sigDecl.getSourceFile().fileName),
                });
                continue;
            }

            const params = sigDecl.parameters || [];
            if (params.length === 0) continue;

            const last = params[params.length - 1];
            const isRestTarget = !!last.dotDotDotToken && i >= params.length - 1;
            const target = isRestTarget ? last : params[i];
            if (!target) continue;

            if (isMarked(target)) continue; // already annotated — nothing to do

            const destructured = !ts.isIdentifier(target.name);
            const host = classifyHost(target);

            findings.push({
                type: isRestTarget ? 'rest-param' : destructured ? 'destructured-param' : 'hop',
                source: src.label,
                sourceKind: src.kind,
                site,
                host: host.kind,
                decoratorLegal: host.decoratorLegal,
                target: {
                    file: target.getSourceFile().fileName,
                    pos: target.getStart(),
                    label: paramLabel(target),
                    text: target.getText(),
                },
            });
        }
    }

    return findings;
}

/**
 * MEASURED (spike/legality.js): a legacy parameter decorator is legal ONLY on the parameter
 * of a concrete class member — method, constructor, static method, accessor. Everywhere else
 * TypeScript emits TS1206, and in a function-type node or arrow function it is a PARSE error.
 *
 * This classifier is what tells `--fix` whether it may write a decorator at all.
 */
function classifyHost(param) {
    const fn = param.parent;
    if (!fn) return {kind: 'unknown', decoratorLegal: false};

    const inClassBody =
        fn.parent && (ts.isClassDeclaration(fn.parent) || ts.isClassExpression(fn.parent));

    if (ts.isMethodDeclaration(fn) && inClassBody) {
        const abstract = (ts.getModifiers(fn) || []).some(
            (m) => m.kind === ts.SyntaxKind.AbstractKeyword
        );
        if (abstract) return {kind: 'abstract-method', decoratorLegal: false};
        if (!fn.body) return {kind: 'overload-signature', decoratorLegal: false};
        return {kind: 'class-method', decoratorLegal: true};
    }
    if (ts.isConstructorDeclaration(fn) && inClassBody)
        return {kind: 'constructor', decoratorLegal: !!fn.body};
    if (ts.isSetAccessorDeclaration(fn) || ts.isGetAccessorDeclaration(fn))
        return {kind: 'accessor', decoratorLegal: !!inClassBody};

    if (ts.isFunctionDeclaration(fn)) return {kind: 'free-function', decoratorLegal: false};
    if (ts.isArrowFunction(fn)) return {kind: 'arrow-function', decoratorLegal: false};
    if (ts.isFunctionExpression(fn)) return {kind: 'function-expression', decoratorLegal: false};
    if (ts.isMethodSignature(fn)) return {kind: 'interface-method', decoratorLegal: false};
    if (ts.isFunctionTypeNode(fn) || ts.isConstructorTypeNode(fn))
        return {kind: 'function-type', decoratorLegal: false};
    if (ts.isCallSignatureDeclaration(fn)) return {kind: 'call-signature', decoratorLegal: false};

    return {kind: ts.SyntaxKind[fn.kind], decoratorLegal: false};
}

function locOf(node) {
    const sf = node.getSourceFile();
    const {line, character} = sf.getLineAndCharacterOfPosition(node.getStart());
    return `${path.basename(sf.fileName)}:${line + 1}:${character + 1}`;
}

/* ------------------------------------------------------------------ *
 * --fix                                                               *
 * ------------------------------------------------------------------ */

/**
 * Produce text edits inserting `@Sensitive() ` before each fixable parameter.
 *
 * Two properties the design claims and this must actually deliver:
 *   - idempotence: a parameter already marked produces no edit (checked upstream by isMarked)
 *   - no churn:    re-running on a converged tree produces zero edits
 */
function planFixes(findings, mode) {
    mode = mode || 'decorator';
    const byFile = new Map();
    const seen = new Set();
    const skipped = [];

    for (const f of findings) {
        if (f.type === 'external-boundary' || f.type === 'unresolved-callee') continue;

        // A rest parameter cannot receive a per-argument marking meaningfully — it is one
        // binding for N arguments — and `...@S() v` is a parse error while `@S() ...v` marks
        // the whole rest array. Left unfixable deliberately; it is a permanent open finding.
        if (f.type === 'rest-param') {
            skipped.push({...f, why: 'rest-parameter'});
            continue;
        }

        // MEASURED: a parameter decorator is legal only on a concrete class member.
        if (mode === 'decorator' && !f.decoratorLegal) {
            skipped.push({...f, why: `decorator illegal on ${f.host}`});
            continue;
        }

        const key = `${f.target.file}#${f.target.pos}`;
        if (seen.has(key)) continue; // two sources hitting one parameter = one annotation
        seen.add(key);
        if (!byFile.has(f.target.file)) byFile.set(f.target.file, []);
        byFile.get(f.target.file).push({pos: f.target.pos, mode, host: f.host});
    }

    const edits = [];
    for (const [file, items] of byFile) {
        edits.push({file, positions: items.sort((a, b) => b.pos - a.pos)}); // reverse order
    }
    return {edits, skipped};
}

function applyFixes(edits, fs, mode) {
    mode = mode || 'decorator';
    let count = 0;
    let needsImport = false;
    for (const {file, positions} of edits) {
        let text = fs.readFileSync(file, 'utf8');
        for (const item of positions) {
            const useDecorator = mode === 'decorator' || (mode === 'auto' && item.host && isLegalHost(item.host));
            const insert = useDecorator ? `@${MARKER}() ` : `/** ${JSDOC_TAG} */ `;
            if (useDecorator) needsImport = true;
            text = text.slice(0, item.pos) + insert + text.slice(item.pos);
            count++;
        }
        if (needsImport) text = ensureImport(text, file);
        fs.writeFileSync(file, text, 'utf8');
        needsImport = false;
    }
    return count;
}

function isLegalHost(host) {
    return ['class-method', 'constructor', 'accessor'].includes(host);
}

/**
 * The import problem, which is not a detail: writing a decorator into a file that does not
 * import the marker produces code that does not compile.
 */
function ensureImport(text, file) {
    if (new RegExp(`import\\s*\\{[^}]*\\b${MARKER}\\b`).test(text)) return text;
    const dir = path.dirname(file);
    let rel = path.relative(dir, path.join(__dirname, 'fixtures', 'marker')).replace(/\\/g, '/');
    if (!rel.startsWith('.')) rel = './' + rel;
    return `import {${MARKER}} from '${rel}';\n` + text;
}

module.exports = {
    analyzeProgram,
    planFixes,
    applyFixes,
    isMarked,
    markingArgs,
    classifySource,
    classifyHost,
    MARKER,
    JSDOC_TAG,
};
