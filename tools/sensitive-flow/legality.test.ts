/**
 * Legality probe table — the SMELL-19 correction.
 *
 * The spike's `classifyHost` decided legality from node kinds and wrongly called a class-*expression*
 * method decorator-legal, where the compiler says TS1206. These tests pin that the verdict now comes
 * from a *compiled probe*, and that the two class cases are distinguished.
 */

import {getLegalityTable, classifyHostCategory, isLegalMethodDecoratorHost} from './legality';
import {createInMemoryProgram} from './compilerHost';
import * as ts from 'typescript';

describe('legality — derived from compiled probes (SMELL-19)', () => {
    const table = getLegalityTable();

    it('a class DECLARATION method is a legal decorator host', () => {
        expect(table.get('class-declaration-method')).toBe(true);
        expect(table.get('class-declaration-static-method')).toBe(true);
        expect(table.get('class-declaration-accessor')).toBe(true);
    });

    it('a class EXPRESSION method is NOT a legal host — the exact SMELL-19 case', () => {
        // This is the verdict the spike got wrong by reading node kinds; the compiler says TS1206.
        expect(table.get('class-expression-method')).toBe(false);
    });

    it('free functions, object-literal methods, interfaces and abstract/overloads are all illegal', () => {
        expect(table.get('free-function')).toBe(false);
        expect(table.get('object-literal-method')).toBe(false);
        expect(table.get('interface-method')).toBe(false);
        expect(table.get('abstract-method')).toBe(false);
        expect(table.get('overload-signature')).toBe(false);
    });
});

describe('legality — classifyHostCategory distinguishes the two class forms', () => {
    function methodNodeFrom(code: string, fileName = 'probe.ts'): ts.MethodDeclaration {
        const {program} = createInMemoryProgram({[fileName]: code});
        const sf = program.getSourceFile(fileName)!;
        let found: ts.MethodDeclaration | undefined;
        const visit = (n: ts.Node): void => {
            if (ts.isMethodDeclaration(n) && !found) found = n;
            ts.forEachChild(n, visit);
        };
        visit(sf);
        if (!found) throw new Error('no method found in probe');
        return found;
    }

    it('classifies a class-declaration method as legal and a class-expression method as illegal', () => {
        const declMethod = methodNodeFrom('class C { m() {} }');
        const exprMethod = methodNodeFrom('const C = class { m() {} };');

        expect(classifyHostCategory(declMethod)).toBe('class-declaration-method');
        expect(classifyHostCategory(exprMethod)).toBe('class-expression-method');

        expect(isLegalMethodDecoratorHost(declMethod)).toBe(true);
        expect(isLegalMethodDecoratorHost(exprMethod)).toBe(false);
    });
});
