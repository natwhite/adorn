/**
 * The pure, decorator-free unsatisfiable-stack analyzer (GAP-20 / DEC-063), hoisted to Core so BOTH the
 * installer path (`ContractInstaller.warnUnsatisfiableStacks`) and the descriptor-first projection
 * (`toolSchemaFrom`) can run it from ONE implementation (DEC-010, round-4 §2.3). It was installer-local
 * before, which left `toolSchemaFrom` — the README-recommended path — silently emitting an unsatisfiable
 * schema for a `[ArrayOf(...), OneOf([...])]` stack.
 *
 * Reads only `constraint.schema()` fragments (no decorator, target, or registry knowledge — DEC-012), so
 * it is Core-safe: a projection may import it without reaching into an adapter.
 */

import {ConstraintDescriptor} from './Descriptor';

/**
 * Returns the `[containerIdentity, memberIdentity]` pair when a constraint stack conjoins BOTH a
 * container-`type` fragment (`array`/`object`, e.g. `@ArrayOf`/`@Dictionary`/`@Shape`) and an
 * `enum`/`const` fragment (`@OneOf`/`@Const` of JSON primitives), else `undefined`. That conjunction is
 * always unsatisfiable — no value is both a container AND `===` a primitive member — so the position
 * rejects every input (including `[]`) while projecting a plausible `{type:'array', enum:[…], items:…}`.
 * Decidable with no false positives because `@OneOf`/`@Const` members are validated to be JSON primitives
 * at construction. `@Nullable` emits `type:['object','null']` (a `type` ARRAY, not `=== 'object'`), so it
 * is not flagged.
 */
export function detectUnsatisfiableStack(
    constraints: ReadonlyArray<ConstraintDescriptor>,
): [string, string] | undefined {
    let container: ConstraintDescriptor | undefined;
    let member: ConstraintDescriptor | undefined;
    for (const constraint of constraints) {
        const fragment = constraint.schema ? constraint.schema() : undefined;
        if (!fragment) continue;
        if ((fragment.type === 'array' || fragment.type === 'object') && !container) container = constraint;
        if (('enum' in fragment || 'const' in fragment) && !member) member = constraint;
    }
    return container && member ? [container.constraint, member.constraint] : undefined;
}
