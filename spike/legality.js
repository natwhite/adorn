/**
 * SPIKE — where is a parameter decorator legal at all?
 *
 * Compiles one probe per syntactic position and reports the diagnostic. This is the
 * measurement that decides what `--fix` can write. NOT SHIPPED.
 */
'use strict';

const ts = require('typescript');

const PROBES = {
    'class method param': `class C { m(@S() v: string) {} }`,
    'class constructor param': `class C { constructor(@S() v: string) {} }`,
    'class static method param': `class C { static m(@S() v: string) {} }`,
    'class getter param (n/a)': `class C { set p(@S() v: string) {} }`,
    'free function declaration': `function f(@S() v: string) {}`,
    'exported free function': `export function f(@S() v: string) {}`,
    'function expression': `const f = function (@S() v: string) {};`,
    'arrow function': `const f = (@S() v: string) => {};`,
    'object literal method': `const o = {m(@S() v: string) {}};`,
    'interface method signature': `interface I { m(@S() v: string): void; }`,
    'function type node': `type T = (@S() v: string) => void;`,
    'class method overload sig': `class C { m(@S() v: string): void; m(v: any) {} }`,
    'abstract class method': `abstract class C { abstract m(@S() v: string): void; }`,
    'declared function (d.ts-ish)': `declare function f(@S() v: string): void;`,
    'destructured class-method param': `class C { m(@S() {a}: {a: string}) {} }`,
    'rest class-method param (...@S)': `class C { m(...@S() v: string[]) {} }`,
    'rest class-method param (@S ...)': `class C { m(@S() ...v: string[]) {} }`,
    'optional class-method param': `class C { m(@S() v?: string) {} }`,
    /* --- the JSDoc alternative, same positions --- */
    'JSDOC free function': `/** @sensitive v */\nfunction f(v: string) {}`,
    'JSDOC arrow function': `/** @sensitive v */\nconst f = (v: string) => {};`,
    'JSDOC interface method': `interface I {\n  /** @sensitive v */\n  m(v: string): void;\n}`,
    'JSDOC function type': `/** @sensitive v */\ntype T = (v: string) => void;`,
    'JSDOC inline param': `function f(/** @sensitive */ v: string) {}`,
};

const OPTS = {
    target: ts.ScriptTarget.ES2019,
    module: ts.ModuleKind.CommonJS,
    experimentalDecorators: true,
    strict: false,
    noEmit: true,
    noResolve: true,
    types: [],
};

const PRELUDE = 'declare function S(): any;\n';

function probe(name, src) {
    const fileName = 'probe.ts';
    const full = PRELUDE + src + '\n';
    const sf = ts.createSourceFile(fileName, full, ts.ScriptTarget.ES2019, true);
    const host = {
        getSourceFile: (f) => (f === fileName ? sf : undefined),
        writeFile: () => {},
        getDefaultLibFileName: () => 'lib.d.ts',
        useCaseSensitiveFileNames: () => false,
        getCanonicalFileName: (f) => f,
        getCurrentDirectory: () => '',
        getNewLine: () => '\n',
        fileExists: (f) => f === fileName,
        readFile: (f) => (f === fileName ? full : undefined),
    };
    const program = ts.createProgram([fileName], OPTS, host);
    const diags = [
        ...program.getSyntacticDiagnostics(sf),
        ...program.getSemanticDiagnostics(sf),
    ].filter((d) => d.code !== 2318 && d.code !== 2304);

    if (diags.length === 0) return {ok: true, msg: 'LEGAL'};
    const d = diags[0];
    return {
        ok: false,
        msg: `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`,
        syntactic: program.getSyntacticDiagnostics(sf).length > 0,
    };
}

console.log('Where is a legacy parameter decorator legal? (experimentalDecorators: true)\n');
let legal = 0;
const rows = [];
for (const [name, src] of Object.entries(PROBES)) {
    const r = probe(name, src);
    if (r.ok) legal++;
    rows.push([name, r.ok ? 'LEGAL' : r.syntactic ? 'PARSE ERROR' : 'ERROR', r.msg]);
}
const w = Math.max(...rows.map((r) => r[0].length));
for (const [n, v, m] of rows) {
    console.log(`  ${n.padEnd(w)}  ${v.padEnd(12)}  ${v === 'LEGAL' ? '' : m}`);
}
console.log(`\n  ${legal} of ${rows.length} positions accept a parameter decorator.`);
