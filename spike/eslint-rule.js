/**
 * SPIKE — the same single-hop analysis, expressed as a typescript-eslint type-aware rule.
 *
 * Built to answer brief question 6: can one analysis core serve both an ESLint rule and a CLI?
 *
 * The rule reuses `core.js`'s `classifySource` and `isMarked` UNCHANGED — that part shares
 * cleanly. What does not share is everything about *where the answer goes*, and this file
 * exists to make that concrete rather than argue it.
 *
 * NOT SHIPPED.
 */
'use strict';

const {ESLintUtils} = require('@typescript-eslint/utils');
const path = require('path');
const {classifySource, isMarked, MARKER} = require('./core');

const createRule = ESLintUtils.RuleCreator(() => 'https://example.invalid/spike');

module.exports = createRule({
    name: 'no-unmarked-sensitive-flow',
    meta: {
        type: 'problem',
        docs: {description: 'A @Sensitive value is passed to an unmarked parameter.'},
        // Set to 'code' only because ESLint hard-errors ("Fixable rules must set the
        // meta.fixable property") the instant any report carries a `fix`. That is itself the
        // finding: the rule is forced to advertise itself as fixable for the SAME-FILE case,
        // while the cross-file case — the common one — can carry no fix at all. See the doc.
        fixable: 'code',
        schema: [],
        messages: {
            hop: "'{{source}}' flows into unmarked parameter '{{target}}'{{where}}.",
            crossFile:
                "'{{source}}' flows into unmarked parameter '{{target}}' in {{file}} — " +
                'ESLint cannot fix across files; run the CLI.',
            external:
                "'{{source}}' is passed to '{{callee}}', declared in {{file}} — " +
                'no source to annotate.',
        },
    },
    defaultOptions: [],

    create(context) {
        const services = ESLintUtils.getParserServices(context);
        const checker = services.program.getTypeChecker();
        const thisFile = path.resolve(context.filename);

        function check(node) {
            const tsNode = services.esTreeNodeToTSNodeMap.get(node);
            if (!tsNode || !tsNode.arguments) return;

            let sig;
            try {
                sig = checker.getResolvedSignature(tsNode);
            } catch {
                return;
            }
            const decl = sig && sig.declaration;

            for (let i = 0; i < tsNode.arguments.length; i++) {
                const src = classifySource(tsNode.arguments[i], checker);
                if (!src) continue;
                const reportAt = node.arguments[i];

                if (!decl) continue;

                if (decl.getSourceFile().isDeclarationFile) {
                    context.report({
                        node: reportAt,
                        messageId: 'external',
                        data: {
                            source: src.label,
                            callee: tsNode.expression.getText().slice(0, 40),
                            file: path.basename(decl.getSourceFile().fileName),
                        },
                    });
                    continue;
                }

                const params = decl.parameters || [];
                const last = params[params.length - 1];
                const target =
                    last && last.dotDotDotToken && i >= params.length - 1 ? last : params[i];
                if (!target || isMarked(target)) continue;

                const targetFile = path.resolve(target.getSourceFile().fileName);
                const targetName = target.name.getText();

                if (targetFile !== thisFile) {
                    // THE STRUCTURAL PROBLEM. The finding is here; the edit belongs there.
                    context.report({
                        node: reportAt,
                        messageId: 'crossFile',
                        data: {
                            source: src.label,
                            target: targetName,
                            file: path.relative(process.cwd(), targetFile),
                        },
                    });
                } else {
                    context.report({
                        node: reportAt,
                        messageId: 'hop',
                        data: {source: src.label, target: targetName, where: ' (same file)'},
                        // Even same-file, the fix is at a location the reported node does not
                        // own. ESLint permits it, but the report is attached to the call site,
                        // so `--fix` edits a line the developer is not looking at.
                        fix(fixer) {
                            return fixer.insertTextBeforeRange(
                                [target.getStart(), target.getEnd()],
                                `@${MARKER}() `
                            );
                        },
                    });
                }
            }
        }

        return {CallExpression: check, NewExpression: check};
    },
});
