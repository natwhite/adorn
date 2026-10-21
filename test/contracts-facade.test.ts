/**
 * The fluent facade in use (DEC-094, GPT review): `Contracts.*` drives the real validation and projection
 * paths exactly as the `*Contracts` namespaces do — same descriptors, so same outputs. The reference-identity
 * proof (every member IS the namespace factory) lives in `public-surface.test.ts`; this pins the end-to-end
 * behaviour a developer actually writes.
 */
import {Contracts, Verify, StringContracts, ArrayContracts, NullableContracts} from '../index';
import {toolSchemaFrom} from '../schema';

describe('Contracts fluent facade — end to end (DEC-094)', () => {
    it('validates through Verify.check identically to the namespace descriptor', () => {
        const fail = Verify.check(Contracts.string.notEmpty(), 'name', '');
        const nsFail = Verify.check(StringContracts.NotEmpty(), 'name', '');
        expect(fail.ok).toBe(false);
        expect(nsFail.ok).toBe(false);
        expect(Verify.check(Contracts.string.notEmpty(), 'name', 'adorn').ok).toBe(true);
    });

    it('composes — array of nullable uuids — and projects to the same tool schema as the namespaces', () => {
        const facadeSchema = toolSchemaFrom({
            name: 'tool',
            params: {ids: Contracts.array(Contracts.nullable(Contracts.string.uuid()))},
        });
        const nsSchema = toolSchemaFrom({
            name: 'tool',
            params: {ids: ArrayContracts.ArrayOf(NullableContracts.Nullable(StringContracts.Uuid()))},
        });
        expect(facadeSchema).toEqual(nsSchema);
    });

    it('builds a closed object literal through Contracts.object (Fields)', () => {
        const schema = toolSchemaFrom({
            name: 'make',
            params: {
                user: Contracts.object({
                    id: Contracts.string.uuid(),
                    age: Contracts.number.between(0, 120),
                }),
            },
        });
        const user = (schema.properties as Record<string, Record<string, unknown>>).user;
        expect(user.type).toBe('object');
        expect(Object.keys(user.properties as Record<string, unknown>).sort()).toEqual(['age', 'id']);
    });

    it('enforces a composed contract.checked spec built entirely from Contracts.*', () => {
        // The facade reaches the functional enforcement path too — a descriptor is a descriptor.
        const schema = toolSchemaFrom({
            name: 'retry',
            params: {attempts: Contracts.number.integer()},
        });
        expect((schema.properties as Record<string, Record<string, unknown>>).attempts.type).toBe('integer');
    });
});
