/**
 * `@Describe('…')` — a record-only natural-language description on a parameter (Q-30).
 *
 * ## What it does
 *
 * `@Describe(text)` records into {@link ContractRegistry}'s parameter-description band the meaning the
 * *model* reads for a tool-call argument — "the city to look up", "an ISO currency code". It installs
 * nothing and never enters an enforcement band; it is plain registry data the projections read.
 *
 * ## Where it lands, and its precedence
 *
 *   - **Tool schema** (`toolSchemaForMethod`): the text becomes the parameter's `description`. It is the
 *     *sole* source of a property description — the tool schema deliberately does **not** fall back to
 *     the constraint's own `describe()` prose (the emitted keywords `minLength`/`enum`/`format` already
 *     encode the bound; `@Describe` supplies the meaning the keywords cannot — plan §4.3). So `@Describe`
 *     "overrides" the `describe()`-derived default in the sense that it is the only description emitted.
 *   - **Docs** (`documentClass`): the text fills `ParameterDoc.description`, rendered beside the parameter.
 *
 * ## Pure annotation — safe in both schema postures
 *
 * A description never rejects a value, so — unlike a `format` keyword — it can never over-claim in either
 * the descriptive or the prescriptive schema. JSDoc stays rejected (DEC-007): meaning must be a decorator
 * argument, not an erased comment.
 *
 * ## Surfaces even without a constraint (S1)
 *
 * A `@Describe` on an *unconstrained* parameter is still emitted into the tool schema's `properties` (as
 * `{description}` over the `{}` fragment): the projection unions the description band's parameter indices
 * with the contract band, mirroring the telemetry band, so a described-but-unconstrained argument is not
 * silently dropped.
 *
 * ## Record-only / layering (DEC-012)
 *
 * Like `@Sensitive`/`@Optional`, this resolves its target from argument shape and calls only the
 * registry's record-only writer; the registry learns the parameter *has a description*, never that a
 * decorator named `@Describe` produced it.
 */

import {MethodKey, recordParameterDescription} from '../Core/ContractRegistry';

/**
 * The method key a constructor parameter's marking is recorded under — a constructor-parameter decorator
 * receives `propertyKey === undefined`; a dedicated symbol keeps such markings from colliding with a real
 * method literally named `'constructor'`, the same trick `@Sensitive`/`@Optional` use.
 */
const CONSTRUCTOR_PARAMETERS: unique symbol = Symbol('adorn.describe.constructor');

/**
 * Attach a natural-language description to a parameter (record-only). Emitted as the parameter's
 * `description` in the tool schema and rendered in docs.
 *
 * `text` must be a non-empty string. Must be applied to a parameter — it throws if used anywhere else.
 */
export function Describe(
    text: string,
): (target: object, propertyKey?: MethodKey, parameterIndex?: number) => void {
    if (typeof text !== 'string' || text.length === 0) {
        throw new TypeError('@Describe(text): text must be a non-empty string.');
    }

    return function (target: object, propertyKey?: MethodKey, parameterIndex?: number): void {
        if (typeof parameterIndex !== 'number') {
            throw new TypeError('@Describe() must be applied to a parameter.');
        }
        const key: MethodKey = propertyKey ?? CONSTRUCTOR_PARAMETERS;
        recordParameterDescription(target, key, parameterIndex, text);
    };
}
