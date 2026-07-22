/**
 * Sensitive-flow detector — analysis core tests.
 *
 * Covers the cases the build requires pinned: a direct sink hit, an intraprocedural template hit, a
 * clean case, an out-of-scope flow the scope report names, and the permanent-floor case asserted as
 * NOT caught (so the limit is fixed, not silently improved away). Plus the closed sink set (@Time is
 * not a sink) and the SMELL-19 legality correction.
 */

import * as ts from 'typescript';
import {createInMemoryProgram} from './compilerHost';
import {analyzeProgram, classifySink, AnalysisResult} from './analysis';
import {formatScopeReport} from './report';

/** Common decorator stand-ins, matched by name exactly as the real adorn decorators are. */
const PRELUDE = `
function Sensitive(): any { return () => {}; }
function Log(): any { return () => {}; }
function Time(): any { return () => {}; }
function GreaterThan(_n: number): any { return () => {}; }
`;

function analyze(body: string, extra = ''): AnalysisResult {
    const source = `${PRELUDE}\n${extra}\n${body}\n`;
    const {program, rootFiles} = createInMemoryProgram({'fixture.ts': source});
    return analyzeProgram(program, rootFiles);
}

const MODEL = `
class Customer {
    @Sensitive() ssn: string = '';
    name: string = '';
}
class AuditService {
    @Log() write(entry: string): void { void entry; }
    @Time() timed(entry: string): void { void entry; }
    check(@GreaterThan(0) score: number): void { void score; }
}
`;

describe('detector — leaks into an adorn sink', () => {
    it('direct sink hit: a @Sensitive field passed straight into a @Log parameter', () => {
        const result = analyze(`function h(c: Customer, a: AuditService): void { a.write(c.ssn); }`, MODEL);
        expect(result.leaks).toHaveLength(1);
        expect(result.leaks[0].source.label).toBe('Customer.ssn');
        expect(result.leaks[0].source.kind).toBe('field');
        expect(result.leaks[0].sink.emitter).toBe('log');
        expect(result.leaks[0].sink.via).toBe('@Log');
    });

    it('intraprocedural TEMPLATE hit: sink(`... ${s.ssn} ...`) — the six-line propagator', () => {
        const result = analyze(
            'function h(c: Customer, a: AuditService): void { a.write(`user ${c.ssn}`); }',
            MODEL,
        );
        expect(result.leaks).toHaveLength(1);
        expect(result.leaks[0].source.kind).toBe('template');
        expect(result.leaks[0].source.label).toBe('Customer.ssn');
    });

    it('intraprocedural LOCAL CONST ALIAS hit: const copy = s.ssn; sink(copy)', () => {
        const result = analyze(
            `function h(c: Customer, a: AuditService): void { const copy = c.ssn; a.write(copy); }`,
            MODEL,
        );
        expect(result.leaks).toHaveLength(1);
        expect(result.leaks[0].source.kind).toBe('local-alias');
        expect(result.leaks[0].source.label).toBe('Customer.ssn');
    });

    it('the violation-message parameter path (@GreaterThan) is a sink', () => {
        const result = analyze(
            `function h(c: Customer, a: AuditService): void {
                const s = c.ssn as unknown as number;
                a.check(s);
            }`,
            MODEL,
        );
        expect(result.leaks).toHaveLength(1);
        expect(result.leaks[0].sink.emitter).toBe('violation-message');
        expect(result.leaks[0].sink.via).toBe('@GreaterThan');
    });
});

describe('detector — the clean case and the permanent floor', () => {
    it('clean: an UNMARKED field into a @Log parameter is not a leak', () => {
        const result = analyze(`function h(c: Customer, a: AuditService): void { a.write(c.name); }`, MODEL);
        expect(result.leaks).toHaveLength(0);
        expect(result.outOfScope).toHaveLength(0);
    });

    it('permanent floor: s.ssn.slice(-4) into a @Log parameter is NOT caught (spike §15.8)', () => {
        const result = analyze(
            `function h(c: Customer, a: AuditService): void { a.write(c.ssn.slice(-4)); }`,
            MODEL,
        );
        // Caught by nothing at any budget. This assertion pins the accepted limit — a future change
        // that "fixes" it would be adopting a sanitizer policy adorn must not (DEC-027).
        expect(result.leaks).toHaveLength(0);
    });
});

describe('detector — out-of-scope disclosure (DEC-026 point 4)', () => {
    it('a @Sensitive value into console.log is recorded out of scope and NAMED by the report', () => {
        const result = analyze(`function h(c: Customer): void { console.log(c.ssn); }`, MODEL);
        expect(result.leaks).toHaveLength(0);
        expect(result.outOfScope).toHaveLength(1);
        expect(result.outOfScope[0].source.label).toBe('Customer.ssn');
        expect(result.outOfScope[0].receiver).toContain('console.log');

        const report = formatScopeReport(result);
        expect(report).toContain('Out of scope: 1');
        expect(report).toContain('Customer.ssn');
        expect(report).toContain('console.log');
        // The honesty line — adorn secures its own emissions, not a raw console.log.
        expect(report).toMatch(/adorn secures its OWN emissions/);
    });

    it('a sensitive value into a plain (non-adorn) function is disclosed out of scope', () => {
        const result = analyze(
            `function sink(x: string): void { void x; }
             function h(c: Customer): void { sink(c.ssn); }`,
            MODEL,
        );
        expect(result.leaks).toHaveLength(0);
        expect(result.outOfScope).toHaveLength(1);
        expect(result.outOfScope[0].reason).toBe('non-adorn-receiver');
    });
});

describe('detector — the scope report is never silent', () => {
    it('a clean run still prints what it analysed (clean != never-run)', () => {
        const result = analyze(`function h(c: Customer, a: AuditService): void { a.write(c.name); }`, MODEL);
        const report = formatScopeReport(result, {basis: 'fixture.ts'});
        // Denominator is printed even at zero leaks — the AuditService.write(entry) and check(score)
        // emission positions are enumerated.
        expect(report).toContain('Analysed 2 adorn emission position(s)');
        expect(report).toContain('AuditService.write(entry)');
        expect(report).toContain('AuditService.check(score)');
        expect(report).toContain('Leaks: none');
    });

    it('a program with no emitters says so explicitly, not silently', () => {
        const result = analyze(`const x = 1; void x;`, '');
        const report = formatScopeReport(result);
        expect(report).toContain('Analysed 0 adorn emission position(s)');
        expect(report).toMatch(/NOT "no sensitive data leaks"/);
    });
});

describe('detector — the closed sink set (DEC-025/DEC-026)', () => {
    it('@Time is deliberately NOT a sink — it emits a label and a duration, no argument value', () => {
        const result = analyze(`function h(c: Customer, a: AuditService): void { a.timed(c.ssn); }`, MODEL);
        // Not a leak — @Time never renders the argument. It IS disclosed as out-of-scope (the value
        // went to a non-emitting receiver), but it is not reported as a leak.
        expect(result.leaks).toHaveLength(0);
    });

    it('the analysed emission positions are exactly @Log params and constrained params — never @Time', () => {
        const result = analyze(`function h(): void {}`, MODEL);
        const labels = result.analyzedSinks.map(s => s.label).sort();
        expect(labels).toEqual(['AuditService.check(score)', 'AuditService.write(entry)']);
        // AuditService.timed(entry) — a @Time method — is absent.
        expect(labels).not.toContain('AuditService.timed(entry)');
    });
});

describe('detector — SMELL-19: @Log on a class-expression method is not a sink', () => {
    function firstParamOfMethodNamed(source: string, methodName: string): ts.ParameterDeclaration {
        const {program} = createInMemoryProgram({'e.ts': `${PRELUDE}\n${source}`});
        const sf = program.getSourceFile('e.ts')!;
        let found: ts.ParameterDeclaration | undefined;
        const visit = (n: ts.Node): void => {
            if (
                ts.isMethodDeclaration(n) &&
                n.name &&
                ts.isIdentifier(n.name) &&
                n.name.text === methodName &&
                n.parameters.length > 0
            ) {
                found = n.parameters[0];
            }
            ts.forEachChild(n, visit);
        };
        visit(sf);
        if (!found) throw new Error(`method ${methodName} not found`);
        return found;
    }

    it('the SAME @Log method is a sink in a class declaration but not in a class expression', () => {
        const declParam = firstParamOfMethodNamed(
            `class C { @Log() emit(x: string): void { void x; } }`,
            'emit',
        );
        expect(classifySink(declParam).sink).toBe(true);

        const exprParam = firstParamOfMethodNamed(
            `const C = class { @Log() emit(x: string): void { void x; } };`,
            'emit',
        );
        const classification = classifySink(exprParam);
        expect(classification.sink).toBe(false);
        expect(classification.rejected).toMatch(/SMELL-19|decorator-illegal/);
    });
});
