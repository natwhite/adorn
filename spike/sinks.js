/**
 * SPIKE (re-evaluation) — sink classification under the NARROWED threat model.
 *
 * NOT SHIPPED. See docs/sensitive-flow-spike.md §14.
 *
 * The original spike's decisive finding was that the analysis has no notion of a sink, so it
 * converges by propagating the marking onto every receiver INCLUDING the loggers. The user has
 * since narrowed the threat model: adorn secures *its own emissions*, not the application's
 * `printf`. That makes the sink set closed and enumerable.
 *
 * THE SINK SET, determined from the codebase (not guessed):
 *
 *   S1  a parameter of a method decorated `@Log()`
 *       src/MethodDecorators/Log.ts:92  `context.args.map(arg => safeStringify(arg)).join(',')`
 *       EVERY argument is rendered. Every parameter of the method is an emission position.
 *
 *   S2  a parameter carrying an `@Enforce.*` constraint decorator
 *       src/Core/Descriptor.ts:314 `formatMessage` -> :323 `formatReceived` interpolates the
 *       received value; reached from `descriptorCheck` (ParameterDecoratorFactory.ts:407).
 *       Only the *constrained* parameter's value reaches the message, not its siblings.
 *
 *   S3  a parameter carrying the proposed `@Telemetry.value()` opt-in
 *       docs/observability-plan.md §5.3. Not implemented; included because the redaction plan
 *       (§6.2) makes `@Sensitive` a veto over it, so it is a sink by construction.
 *
 * DELIBERATELY NOT SINKS, and each exclusion is load-bearing:
 *
 *   `@Time()`   src/MethodDecorators/Time.ts:126 emits `record.label` and `record.durationMs`
 *               only. No argument value is ever rendered. A decorator is not automatically an
 *               emitter, and treating it as one would re-inflate the false-positive rate the
 *               narrowing is supposed to reduce.
 *   field violations (FieldDecoratorFactory.ts:609) — the value is the FIELD's, and a field is
 *               already covered by `@Sensitive` on the field (pii-redaction-plan.md §5.1). No
 *               parameter flow analysis is needed to reach it.
 *   `console.log` / `console.warn` anywhere in application code — OUT OF SCOPE. This is the
 *               whole point of the narrowing.
 *   docs projection (src/Projections/docs.ts) — emits `constraint`, `params` and `describe()`.
 *               Never a runtime value. Not a flow sink.
 */
'use strict';

const ts = require('typescript');
const path = require('path');
const {isMarked, classifySource, classifyHost} = require('./core');

/** Method decorators that cause adorn to render every argument. */
const EMITTING_METHOD_DECORATORS = new Set(['Log']);
/** Method decorators that are adorn emitters but emit NO argument value. */
const NON_EMITTING_METHOD_DECORATORS = new Set(['Time']);
/** Parameter decorators whose presence puts that parameter's value into an adorn emission. */
const EMITTING_PARAM_DECORATOR_ROOTS = new Set(['Enforce', 'Telemetry']);

function decoratorRootName(decorator) {
    let e = decorator.expression;
    if (ts.isCallExpression(e)) e = e.expression;
    // `@Enforce.min(3)` -> root identifier `Enforce`; `@Log()` -> `Log`
    while (ts.isPropertyAccessExpression(e)) e = e.expression;
    return ts.isIdentifier(e) ? e.text : null;
}

function decoratorNames(node) {
    if (!node || !ts.canHaveDecorators(node)) return [];
    return (ts.getDecorators(node) || []).map(decoratorRootName).filter(Boolean);
}

/**
 * Is this parameter declaration an adorn EMISSION position?
 *
 * Returns `{sink: true, via, emitter}` or `{sink: false}`.
 */
function classifySink(param) {
    // S2 / S3 — the parameter itself carries an emitting parameter decorator.
    for (const name of decoratorNames(param)) {
        if (EMITTING_PARAM_DECORATOR_ROOTS.has(name)) {
            return {sink: true, via: `@${name}`, emitter: name === 'Enforce' ? 'violation-message' : 'telemetry'};
        }
    }

    // S1 — the enclosing method is decorated with an argument-rendering method decorator.
    const fn = param.parent;
    if (fn && (ts.isMethodDeclaration(fn) || ts.isConstructorDeclaration(fn))) {
        const names = decoratorNames(fn);
        for (const name of names) {
            if (EMITTING_METHOD_DECORATORS.has(name)) {
                return {sink: true, via: `@${name}`, emitter: 'log'};
            }
        }
        for (const name of names) {
            if (NON_EMITTING_METHOD_DECORATORS.has(name)) {
                return {sink: false, via: `@${name}`, reason: 'decorated but emits no argument value'};
            }
        }
    }

    return {sink: false};
}

/* ------------------------------------------------------------------ *
 * the sink-aware walk                                                 *
 * ------------------------------------------------------------------ */

/**
 * One pass. For every call, for every argument that classifies as a sensitive source, decide
 * what KIND of receiver it lands on:
 *
 *   'leak'          the receiving parameter is an adorn emission position and is UNMARKED.
 *                   This is the report. Under the narrowed model it is the only finding that
 *                   means anything.
 *   'leak-covered'  the receiving parameter is an adorn emission position and IS marked.
 *                   Nothing to do — the emitter will redact.
 *   'hop'           an ordinary parameter. Under `mode: 'direct'` this is DISCARDED; under
 *                   `mode: 'propagate'` it is the thing that gets annotated to reach the next hop.
 *   'out-of-scope'  the receiver is not adorn's (a free function, `console.log`, a .d.ts
 *                   signature). Under the narrowed model adorn was never in this call path.
 */
function analyzeSinkAware(program, rootFiles, options) {
    const opts = options || {};
    const mode = opts.mode || 'propagate';
    const checker = program.getTypeChecker();
    const findings = [];
    const roots = new Set(rootFiles.map((f) => path.resolve(f).toLowerCase()));

    for (const sf of program.getSourceFiles()) {
        if (sf.isDeclarationFile) continue;
        if (!roots.has(path.resolve(sf.fileName).toLowerCase())) continue;
        visit(sf);
    }

    function visit(node) {
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) inspectCall(node);
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
            const calleeText = call.expression.getText().slice(0, 60);

            // No resolvable declaration, or a .d.ts signature (console.log, forEach, ...).
            // Under the NARROWED model this is not adorn's call path at all.
            if (!sigDecl || sigDecl.getSourceFile().isDeclarationFile) {
                findings.push({
                    type: 'out-of-scope',
                    reason: !sigDecl ? 'unresolved-callee' : 'external-declaration',
                    source: src.label,
                    site,
                    calleeText,
                });
                continue;
            }

            const params = sigDecl.parameters || [];
            if (params.length === 0) continue;
            const last = params[params.length - 1];
            const isRestTarget = !!last.dotDotDotToken && i >= params.length - 1;
            const target = isRestTarget ? last : params[i];
            if (!target) continue;

            const sink = classifySink(target);
            const host = classifyHost(target);
            const marked = isMarked(target);

            const base = {
                source: src.label,
                sourceKind: src.kind,
                site,
                calleeText,
                host: host.kind,
                decoratorLegal: host.decoratorLegal,
                rest: isRestTarget,
                target: {
                    file: target.getSourceFile().fileName,
                    pos: target.getStart(),
                    label: paramLabelOf(target),
                    text: target.getText(),
                },
            };

            if (sink.sink) {
                findings.push({...base, type: marked ? 'leak-covered' : 'leak', via: sink.via, emitter: sink.emitter});
                continue;
            }

            if (marked) continue; // already annotated intermediate — nothing to do

            if (mode === 'direct') {
                // No propagation. An ordinary receiver is simply not adorn's problem here.
                findings.push({...base, type: 'out-of-scope', reason: 'non-sink-receiver', via: sink.via});
                continue;
            }

            findings.push({...base, type: isRestTarget ? 'rest-param' : 'hop'});
        }
    }

    return findings;
}

function paramLabelOf(p) {
    const fn = p.parent;
    let fnName = '<anon>';
    if (fn && fn.name) fnName = ts.isIdentifier(fn.name) ? fn.name.text : fn.name.getText();
    const owner = fn && fn.parent && (ts.isClassDeclaration(fn.parent) || ts.isClassExpression(fn.parent)) && fn.parent.name
        ? fn.parent.name.text + '.'
        : '';
    const pn = ts.isIdentifier(p.name) ? p.name.text : p.name.getText();
    return `${owner}${fnName}(${pn})`;
}

function locOf(node) {
    const sf = node.getSourceFile();
    const {line, character} = sf.getLineAndCharacterOfPosition(node.getStart());
    return `${path.basename(sf.fileName)}:${line + 1}:${character + 1}`;
}

/**
 * `--fix` planning under the narrowed model. Only 'hop' findings are annotated to make progress;
 * a 'leak' is annotated at the sink because THAT annotation is the one the emitter reads.
 */
function planSinkFixes(findings, mode) {
    mode = mode || 'decorator';
    const byFile = new Map();
    const seen = new Set();
    const skipped = [];

    for (const f of findings) {
        if (f.type !== 'hop' && f.type !== 'leak') continue;
        if (f.rest) {
            skipped.push({...f, why: 'rest-parameter'});
            continue;
        }
        if (!ts.isIdentifier) {
            /* unreachable; keeps the shape parallel to core.planFixes */
        }
        if (mode === 'decorator' && !f.decoratorLegal) {
            skipped.push({...f, why: `decorator illegal on ${f.host}`});
            continue;
        }
        const key = `${f.target.file}#${f.target.pos}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!byFile.has(f.target.file)) byFile.set(f.target.file, []);
        byFile.get(f.target.file).push({pos: f.target.pos, mode, host: f.host});
    }

    const edits = [];
    for (const [file, items] of byFile) {
        edits.push({file, positions: items.sort((a, b) => b.pos - a.pos)});
    }
    return {edits, skipped};
}

module.exports = {analyzeSinkAware, classifySink, planSinkFixes, decoratorNames};
