/**
 * The ESLint rule adapter — an integration test proving the delivery works end to end.
 *
 * The analysis lives in and is exhaustively tested against the core ({@link ./analysis.test}); this
 * confirms the *thin adapter* correctly obtains parser services, forwards each call to the core, and
 * turns a leak finding into a `context.report`. It drives the rule through typescript-eslint's own
 * parser (fed a pre-built in-memory program) rather than mocking the AST, so the node mapping is real.
 */

import * as path from 'path';
import * as parser from '@typescript-eslint/parser';
import {TSESTree} from '@typescript-eslint/utils';
import {createInMemoryProgram} from './compilerHost';
import {noSensitiveToAdornSink} from './rule';

interface CollectedReport {
    messageId: string;
    data?: Record<string, unknown>;
}

/**
 * Run the rule over one source string and collect its reports. Uses the real typescript-eslint parser
 * with a supplied program, then drives the rule's visitor over the resulting ESTree.
 */
function runRule(source: string): CollectedReport[] {
    const filePath = path.resolve('rule-fixture.ts');
    const {program} = createInMemoryProgram({[filePath]: source});
    const {ast, services} = parser.parseForESLint(source, {
        filePath,
        programs: [program],
        comment: true,
        loc: true,
        range: true,
    });

    const reports: CollectedReport[] = [];
    const context = {
        id: 'no-sensitive-to-adorn-sink',
        options: [],
        settings: {},
        parserPath: '@typescript-eslint/parser',
        parserOptions: {},
        sourceCode: {parserServices: services, getScope: () => undefined},
        // getParserServices reads context.sourceCode.parserServices; both accessors are provided.
        parserServices: services,
        getSourceCode: () => ({parserServices: services}),
        report(descriptor: {messageId: string; data?: Record<string, unknown>}) {
            reports.push({messageId: descriptor.messageId, data: descriptor.data});
        },
    } as unknown as Parameters<typeof noSensitiveToAdornSink.create>[0];

    const visitor = noSensitiveToAdornSink.create(context);

    const walk = (node: TSESTree.Node | null | undefined): void => {
        if (!node || typeof node.type !== 'string') return;
        if (node.type === 'CallExpression' && visitor.CallExpression) {
            visitor.CallExpression(node as TSESTree.CallExpression);
        }
        if (node.type === 'NewExpression' && visitor.NewExpression) {
            visitor.NewExpression(node as TSESTree.NewExpression);
        }
        for (const key of Object.keys(node)) {
            const value = (node as unknown as Record<string, unknown>)[key];
            if (Array.isArray(value)) value.forEach(v => walk(v as TSESTree.Node));
            else if (value && typeof (value as {type?: unknown}).type === 'string') {
                walk(value as TSESTree.Node);
            }
        }
    };
    walk(ast as unknown as TSESTree.Node);

    return reports;
}

const MODEL = `
function Sensitive(): any { return () => {}; }
function Log(): any { return () => {}; }
class Customer { @Sensitive() ssn: string = ''; name: string = ''; }
class AuditService { @Log() write(entry: string): void { void entry; } }
`;

describe('rule — no-sensitive-to-adorn-sink (report-only adapter)', () => {
    it('reports a @Sensitive field reaching a @Log parameter', () => {
        const reports = runRule(
            `${MODEL}\nfunction h(c: Customer, a: AuditService): void { a.write(c.ssn); }`,
        );
        expect(reports).toHaveLength(1);
        expect(reports[0].messageId).toBe('sensitiveReachesEmitter');
        expect(reports[0].data?.source).toBe('Customer.ssn');
        expect(reports[0].data?.via).toBe('@Log');
    });

    it('does not report a clean flow (unmarked field into a @Log parameter)', () => {
        const reports = runRule(
            `${MODEL}\nfunction h(c: Customer, a: AuditService): void { a.write(c.name); }`,
        );
        expect(reports).toHaveLength(0);
    });

    it('does not report an out-of-scope flow as a lint problem (console.log)', () => {
        const reports = runRule(`${MODEL}\nfunction h(c: Customer): void { console.log(c.ssn); }`);
        // Out-of-scope flows belong in the scope report, not as lint errors on the linted file.
        expect(reports).toHaveLength(0);
    });

    it('is report-only: declares no fixer', () => {
        expect(noSensitiveToAdornSink.meta.fixable).toBeUndefined();
    });
});
