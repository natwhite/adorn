/**
 * SPIKE (re-evaluation) — two anomalies surfaced while re-measuring. NOT SHIPPED.
 *
 *   A. `core.js`'s `classifyHost` reports `decoratorLegal: true` for a method of a class
 *      EXPRESSION. `spike/sink-legality.js` measured TS1206 there. If that is real it is a
 *      latent `--fix` bug in the original spike that would have written non-compiling source.
 *
 *   B. Interface dispatch under the narrowed model. The original spike recorded interface
 *      dispatch as a POSITIVE ("interface dispatch resolves", §3). Under the narrowed model the
 *      resolved declaration is the interface's method SIGNATURE, which can never carry `@Log` —
 *      so the concrete, actually-decorated implementation is never consulted. Verify.
 */
'use strict';

const ts = require('typescript');
const path = require('path');
const {classifyHost} = require('./core');
const {classifySink} = require('./sinks');
const {compile} = require('./sink-legality');
const {build, makeWorkTree} = require('./run');

console.log('='.repeat(88));
console.log('A. class-expression method — does classifyHost agree with the compiler?');
console.log('='.repeat(88));

const probes = {
    'class DECLARATION method': 'class C { m(@Sensitive() v: string) {} }',
    'class EXPRESSION method': 'const C = class { m(@Sensitive() v: string) {} };',
    'named class expression method': 'const C = class D { m(@Sensitive() v: string) {} };',
};
for (const [name, src] of Object.entries(probes)) {
    const errs = compile(src);
    console.log(`  ${name.padEnd(34)} compiler: ${errs.length === 0 ? 'LEGAL' : errs[0]}`);
}

// what does classifyHost say?
const sample = 'const C = class { m(v: string) {} };';
const sf = ts.createSourceFile('x.ts', sample, ts.ScriptTarget.ES2019, true);
let reported = null;
const visit = (n) => {
    if (ts.isParameter(n)) reported = classifyHost(n);
    ts.forEachChild(n, visit);
};
visit(sf);
console.log(`\n  classifyHost says: kind=${reported.kind} decoratorLegal=${reported.decoratorLegal}`);
console.log(
    `  >>> ${reported.decoratorLegal ? 'MISMATCH — classifyHost claims LEGAL where the compiler emits TS1206' : 'agrees'}`
);

console.log('\n' + '='.repeat(88));
console.log('B. interface dispatch — is the @Log-decorated IMPLEMENTATION ever consulted?');
console.log('='.repeat(88));

const work = makeWorkTree();
const files = ['blindspots-sink.ts', 'marker.ts', 'adorn-markers.ts'].map((n) => path.join(work, n));
const program = build(files);
const checker = program.getTypeChecker();
const bs = program.getSourceFile(files[0]);

const walk = (n) => {
    if (ts.isCallExpression(n) && n.expression.getText() === 'r.report') {
        const sig = checker.getResolvedSignature(n);
        const decl = sig && sig.declaration;
        const owner = decl && decl.parent && decl.parent.name ? decl.parent.name.getText() : '?';
        const kind = decl ? ts.SyntaxKind[decl.kind] : 'none';
        console.log(`\n  call site: ${n.getText()}`);
        console.log(`  resolves to: ${owner}.${decl && decl.name ? decl.name.getText() : '?'}  (${kind})`);
        const target = decl && decl.parameters ? decl.parameters[0] : null;
        const sink = target ? classifySink(target) : {sink: false};
        console.log(`  classifySink on the resolved parameter: sink=${sink.sink}${sink.via ? ' via ' + sink.via : ''}`);
        console.log(
            `  >>> the CONCRETE @Log implementation (LoggingReporter.report) is ${sink.sink ? 'reached' : 'NEVER consulted'}`
        );
    }
    ts.forEachChild(n, walk);
};
walk(bs);

// confirm the implementation really is decorated
const walk2 = (n) => {
    if (ts.isMethodDeclaration(n) && n.name.getText() === 'report' && n.parent && n.parent.name) {
        const s = classifySink(n.parameters[0]);
        console.log(`  for reference, ${n.parent.name.getText()}.report(v) is a sink: ${s.sink}${s.via ? ' via ' + s.via : ''}`);
    }
    ts.forEachChild(n, walk2);
};
walk2(bs);
console.log('');
