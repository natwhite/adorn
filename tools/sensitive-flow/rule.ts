/**
 * The typescript-eslint rule — a thin adapter over the shared analysis core ({@link ./analysis}).
 *
 * ## Report-only, permanently (DEC-023 point 2, spike §7.4, §14.7)
 *
 * The rule declares **no** `meta.fixable` and ships no fixer, and this is deliberate and permanent —
 * not an omission to be corrected later:
 *   - The fix target is the *callee's* parameter declaration, which is in a different file whenever the
 *     call crosses a module (the normal case). An ESLint fix is confined to the linted file, so it
 *     cannot land there (§7.2).
 *   - `meta.fixable` would advertise a capability the rule can deliver only sometimes, training the
 *     over-trust this whole area exists to prevent (§7.4).
 *
 * ## Why it is *thin*
 *
 * The rule's entire job is to obtain the program/checker from parser services and forward each
 * `CallExpression`/`NewExpression`'s TypeScript node to {@link findCallFindings}, translating each
 * `leak` finding into a `context.report`. Every piece of analysis — source classification, the closed
 * sink set, the intraprocedural propagator, SMELL-19-correct legality — lives in the core, which is
 * why the same core also drives a CLI (`adorn check`) as an equally thin wrapper (IDEA-9).
 *
 * Out-of-scope flows are intentionally *not* raised as lint problems here (they are not defects in the
 * linted file). They belong in the scope report ({@link ./report}), which the CLI prints over the same
 * core to satisfy DEC-026 point 4.
 *
 * Being type-aware, this rule requires typed linting (`parserServices` with a `program`). It is
 * delivered as a rule module for a future adorn ESLint plugin / CLI to register; it is deliberately
 * NOT wired into adorn's own `eslint.config.mjs`, which is non-type-checked by design (GAP-5).
 */

import {ESLintUtils, TSESTree} from '@typescript-eslint/utils';
import {findCallFindings} from './analysis';

const createRule = ESLintUtils.RuleCreator(
    name => `https://github.com/adorn/adorn/blob/master/tools/sensitive-flow/${name}.md`,
);

export type MessageIds = 'sensitiveReachesEmitter';
export type Options = [];

export const noSensitiveToAdornSink = createRule<Options, MessageIds>({
    name: 'no-sensitive-to-adorn-sink',
    meta: {
        type: 'problem',
        docs: {
            description:
                "Report where a @Sensitive value reaches one of adorn's own emitters (@Log, a " +
                'violation-message parameter). Report-only: adorn secures its own emissions, not a ' +
                'raw console.log (DEC-025).',
        },
        // No `fixable` — see the header. The fix target is cross-file; this rule never writes.
        schema: [],
        messages: {
            sensitiveReachesEmitter:
                '{{source}} ({{kind}}) reaches adorn emitter {{sink}} {{via}}. adorn will render ' +
                'this value; mark the receiving parameter @Sensitive, or do not pass it here.',
        },
    },
    defaultOptions: [],
    create(context) {
        const services = ESLintUtils.getParserServices(context);
        const checker = services.program.getTypeChecker();

        function check(node: TSESTree.CallExpression | TSESTree.NewExpression): void {
            const tsNode = services.esTreeNodeToTSNodeMap.get(node);
            for (const finding of findCallFindings(tsNode, checker)) {
                if (finding.type !== 'leak') continue;
                const reportNode = services.tsNodeToESTreeNodeMap.get(finding.node);
                context.report({
                    node: reportNode ?? node,
                    messageId: 'sensitiveReachesEmitter',
                    data: {
                        source: finding.source.label,
                        kind: finding.source.kind,
                        sink: finding.sink.label,
                        via: finding.sink.via,
                    },
                });
            }
        }

        return {
            CallExpression: check,
            NewExpression: check,
        };
    },
});

export default noSensitiveToAdornSink;
