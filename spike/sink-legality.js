/**
 * SPIKE (re-evaluation) — THE CRUX of question 2.
 *
 * NOT SHIPPED. See docs/sensitive-flow-spike.md §14.
 *
 * The original spike killed `--fix` on TS1206: a legacy parameter decorator is legal in only
 * 7 of 18 syntactic positions. The re-evaluation's claim is that this blocker is MOOT under the
 * narrowed threat model, because an adorn sink parameter can only ever EXIST in one of those 7.
 *
 * That claim must be proven, not asserted, and it has two halves:
 *
 *   HALF A  Where can an adorn emitter be DECLARED at all? `@Log()` is a `MethodDecorator` and
 *           `@Enforce.*` is a `ParameterDecorator`. If those are themselves illegal on a free
 *           function, then no free function can ever BE an adorn sink, and the analysis can
 *           never be asked to annotate one.
 *
 *   HALF B  For every position where an emitter IS legal, is `@Sensitive()` also legal on the
 *           parameters of that same position? If the two legal sets coincide, TS1206 cannot bite.
 *
 * A single counter-example in half B falsifies the re-evaluation's central claim.
 */
'use strict';

const ts = require('typescript');
const path = require('path');

/**
 * Same minimal, `noResolve` host `spike/legality.js` uses — no lib loading, so a probe cannot
 * fail for an unrelated reason. Semantic diagnostics are requested ONLY when the probe parsed
 * cleanly: TypeScript's checker crashes outright on some of the malformed decorator placements
 * below (e.g. `@Log() function f() {}`), which is itself a strong signal that the placement is
 * not expressible, but is not a diagnostic we can read.
 */
const OPTIONS = {
    target: ts.ScriptTarget.ES2019,
    module: ts.ModuleKind.CommonJS,
    experimentalDecorators: true,
    strict: false,
    noEmit: true,
    noResolve: true,
    types: [],
};

const PRELUDE =
    'declare function Log(): MethodDecorator;\n' +
    'declare function Sensitive(): any;\n' +
    'declare const Enforce: {minLength(n: number): ParameterDecorator};\n';

function compile(body) {
    const fileName = 'sinkprobe.ts';
    const full = PRELUDE + body + '\n';
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
    const program = ts.createProgram([fileName], OPTIONS, host);
    const ignore = (d) => d.code !== 2318 && d.code !== 2304 && d.code !== 6133;

    const syntactic = program.getSyntacticDiagnostics(sf).filter(ignore);
    if (syntactic.length > 0) {
        return syntactic.map((d) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
    }
    let semantic;
    try {
        semantic = program.getSemanticDiagnostics(sf).filter(ignore);
    } catch (e) {
        return [`CHECKER-CRASH: ${e && e.message ? e.message.slice(0, 60) : 'unknown'}`];
    }
    return semantic.map((d) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
}

/**
 * The 18 positions from §5, each asked THREE questions:
 *   sensitive  — can `@Sensitive()` go on the parameter? (the original spike's table)
 *   logHost    — can `@Log()` (a MethodDecorator, adorn's emitter) go on this function?
 *   enforce    — can `@Enforce.minLength()` (a ParameterDecorator) go on the parameter?
 */
const POSITIONS = [
    {
        name: 'class method parameter',
        sensitive: 'class C { m(@Sensitive() v: string) {} }',
        logHost: 'class C { @Log() m(v: string) {} }',
        enforce: 'class C { m(@Enforce.minLength(1) v: string) {} }',
    },
    {
        name: 'class constructor parameter',
        sensitive: 'class C { constructor(@Sensitive() v: string) {} }',
        logHost: null, // a MethodDecorator cannot decorate a constructor; probed below
        enforce: 'class C { constructor(@Enforce.minLength(1) v: string) {} }',
    },
    {
        name: 'class static method parameter',
        sensitive: 'class C { static m(@Sensitive() v: string) {} }',
        logHost: 'class C { @Log() static m(v: string) {} }',
        enforce: 'class C { static m(@Enforce.minLength(1) v: string) {} }',
    },
    {
        name: 'class accessor parameter',
        sensitive: 'class C { set p(@Sensitive() v: string) {} }',
        logHost: 'class C { @Log() set p(v: string) {} }',
        enforce: 'class C { set p(@Enforce.minLength(1) v: string) {} }',
    },
    {
        name: 'destructured class-method parameter',
        sensitive: 'class C { m(@Sensitive() {a}: {a: string}) {} }',
        logHost: 'class C { @Log() m({a}: {a: string}) {} }',
        enforce: 'class C { m(@Enforce.minLength(1) {a}: {a: string}) {} }',
    },
    {
        name: 'optional class-method parameter',
        sensitive: 'class C { m(@Sensitive() v?: string) {} }',
        logHost: 'class C { @Log() m(v?: string) {} }',
        enforce: 'class C { m(@Enforce.minLength(1) v?: string) {} }',
    },
    {
        name: 'rest class-method parameter @S() ...v',
        sensitive: 'class C { m(@Sensitive() ...v: string[]) {} }',
        logHost: 'class C { @Log() m(...v: string[]) {} }',
        enforce: 'class C { m(@Enforce.minLength(1) ...v: string[]) {} }',
    },
    {
        name: 'free function declaration',
        sensitive: 'function f(@Sensitive() v: string) {}',
        logHost: '@Log() function f(v: string) {}',
        enforce: 'function f(@Enforce.minLength(1) v: string) {}',
    },
    {
        name: 'exported free function',
        sensitive: 'export function f(@Sensitive() v: string) {}',
        logHost: '@Log() export function f(v: string) {}',
        enforce: 'export function f(@Enforce.minLength(1) v: string) {}',
    },
    {
        name: 'function expression',
        sensitive: 'const f = function (@Sensitive() v: string) {};',
        logHost: 'const f = @Log() function (v: string) {};',
        enforce: 'const f = function (@Enforce.minLength(1) v: string) {};',
    },
    {
        name: 'arrow function',
        sensitive: 'const f = (@Sensitive() v: string) => {};',
        logHost: 'const f = @Log() (v: string) => {};',
        enforce: 'const f = (@Enforce.minLength(1) v: string) => {};',
    },
    {
        name: 'object literal method',
        sensitive: 'const o = {m(@Sensitive() v: string) {}};',
        logHost: 'const o = {@Log() m(v: string) {}};',
        enforce: 'const o = {m(@Enforce.minLength(1) v: string) {}};',
    },
    {
        name: 'interface method signature',
        sensitive: 'interface I { m(@Sensitive() v: string): void }',
        logHost: 'interface I { @Log() m(v: string): void }',
        enforce: 'interface I { m(@Enforce.minLength(1) v: string): void }',
    },
    {
        name: 'function type node',
        sensitive: 'type F = (@Sensitive() v: string) => void;',
        logHost: 'type F = @Log() (v: string) => void;',
        enforce: 'type F = (@Enforce.minLength(1) v: string) => void;',
    },
    {
        name: 'class method overload signature',
        sensitive: 'class C { m(@Sensitive() v: string): void; m(v: any): void { } }',
        logHost: 'class C { @Log() m(v: string): void; m(v: any): void { } }',
        enforce: 'class C { m(@Enforce.minLength(1) v: string): void; m(v: any): void { } }',
    },
    {
        name: 'abstract class method',
        sensitive: 'abstract class C { abstract m(@Sensitive() v: string): void; }',
        logHost: 'abstract class C { @Log() abstract m(v: string): void; }',
        enforce: 'abstract class C { abstract m(@Enforce.minLength(1) v: string): void; }',
    },
    {
        name: 'declare function',
        sensitive: 'declare function f(@Sensitive() v: string): void;',
        logHost: '@Log() declare function f(v: string): void;',
        enforce: 'declare function f(@Enforce.minLength(1) v: string): void;',
    },
    {
        name: 'class expression method parameter',
        sensitive: 'const C = class { m(@Sensitive() v: string) {} };',
        logHost: 'const C = class { @Log() m(v: string) {} };',
        enforce: 'const C = class { m(@Enforce.minLength(1) v: string) {} };',
    },
];

function verdict(errs) {
    if (errs === null) return {ok: false, why: 'n/a'};
    if (errs.length === 0) return {ok: true, why: 'LEGAL'};
    return {ok: false, why: errs[0].split(':')[0]};
}

function main() {
    console.log('='.repeat(100));
    console.log('SINK LEGALITY — can an adorn emitter exist where @Sensitive() cannot be written?');
    console.log('='.repeat(100));
    console.log(
        '\n' +
            'position'.padEnd(38) +
            '@Sensitive()'.padEnd(16) +
            '@Log() host'.padEnd(16) +
            '@Enforce param'.padEnd(16) +
            'IS A SINK?'
    );
    console.log('-'.repeat(100));

    let sinkPositions = 0;
    let sinkPositionsWhereSensitiveIllegal = 0;
    const counterExamples = [];

    for (const p of POSITIONS) {
        const s = verdict(p.sensitive === null ? null : compile(p.sensitive));
        const l = verdict(p.logHost === null ? null : compile(p.logHost));
        const e = verdict(p.enforce === null ? null : compile(p.enforce));

        // A position can BE an adorn sink iff an emitting decorator is legal there.
        const isSink = l.ok || e.ok;
        if (isSink) {
            sinkPositions++;
            if (!s.ok) {
                sinkPositionsWhereSensitiveIllegal++;
                counterExamples.push({position: p.name, sensitive: s.why, log: l.why, enforce: e.why});
            }
        }

        console.log(
            p.name.padEnd(38) +
                (s.ok ? 'LEGAL' : s.why).padEnd(16) +
                (l.why === 'n/a' ? 'n/a' : l.ok ? 'LEGAL' : l.why).padEnd(16) +
                (e.ok ? 'LEGAL' : e.why).padEnd(16) +
                (isSink ? 'YES' : 'no')
        );
    }

    console.log('-'.repeat(100));
    console.log(`\npositions that CAN host an adorn emitter:                  ${sinkPositions}/${POSITIONS.length}`);
    console.log(`of those, positions where @Sensitive() is ILLEGAL:         ${sinkPositionsWhereSensitiveIllegal}`);
    if (counterExamples.length === 0) {
        console.log('\n  >>> NO COUNTER-EXAMPLE. Every position that can host an adorn emitter also');
        console.log('  >>> accepts a parameter decorator. TS1206 cannot bite at a sink.');
    } else {
        console.log('\n  >>> COUNTER-EXAMPLES FOUND — the claim is FALSE:');
        for (const c of counterExamples) {
            console.log(`  >>>   ${c.position}: @Sensitive=${c.sensitive} but @Log=${c.log} / @Enforce=${c.enforce}`);
        }
    }

    // The separate question: a constructor cannot take a MethodDecorator, but CAN take
    // parameter decorators — so it is a sink via @Enforce only. Verified above.
    console.log('\nnote: `@Log()` on a constructor is not expressible (a MethodDecorator cannot');
    console.log('      decorate a constructor); a constructor reaches the sink set via @Enforce only.');
}

if (require.main === module) main();
module.exports = {compile};
