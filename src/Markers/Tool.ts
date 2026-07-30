/**
 * `@Tool('…')` — a record-only natural-language description on a method (Q-30).
 *
 * ## What it does
 *
 * `@Tool(text)` records into {@link ContractRegistry}'s method-description band the tool-level meaning the
 * *model* reads — "Look up a weather forecast". It is the recorded, co-located twin of the existing
 * `toolSchemaForMethod(C, m, {description})` option: a `@Tool` on the method is the declarative default,
 * and the call-site option overrides it when both are present (plan §4.3). It installs nothing.
 *
 * ## Where it lands
 *
 *   - **Tool schema** (`toolSchemaForMethod`): the text becomes the schema's top-level `description`.
 *   - **Docs** (`documentClass`): the text fills `MethodDoc.description`, heading the method's section.
 *
 * ## Projects even with no constrained params (S1)
 *
 * A `@Tool('…') now(): string {}` — a described method carrying no parameter *constraint* — still projects
 * to `{type:'object', properties:{}, required:[], additionalProperties:false, description:'…'}`. The
 * projection resolves the marker-read target from the class and unions the description band's method keys
 * with the contract band (mirroring the telemetry band), so such a method is neither dropped nor an NPE.
 *
 * ## Pure annotation / layering (DEC-012)
 *
 * A description never rejects a value, so it is posture-neutral (safe in both schema postures). Structurally
 * the sibling of `@Telemetry.result()`: a method decorator that validates it sits on a method and calls only
 * the registry's record-only writer; the registry learns the method *has a description*, never that a
 * decorator named `@Tool` produced it. JSDoc stays rejected (DEC-007).
 */

import {MethodKey, recordMethodDescription} from '../Core/ContractRegistry';

/**
 * Attach a tool-level natural-language description to a method (record-only). Emitted as the schema's
 * top-level `description` and rendered as the method's docs heading.
 *
 * `text` must be a non-empty string. Must be applied to a method — it throws if used anywhere else.
 */
export function Tool(text: string): MethodDecorator {
    if (typeof text !== 'string' || text.length === 0) {
        throw new TypeError('@Tool(text): text must be a non-empty string.');
    }

    return function (target: object, propertyKey: MethodKey, descriptor?: PropertyDescriptor): void {
        if (!descriptor || typeof descriptor.value !== 'function') {
            throw new TypeError(`@Tool must be applied to a method; ${String(propertyKey)} is not one.`);
        }
        recordMethodDescription(target, propertyKey, text);
    } as MethodDecorator;
}
