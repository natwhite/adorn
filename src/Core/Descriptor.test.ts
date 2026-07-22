import {
    constraintFromJSON,
    ConstraintParams,
    defineConstraint,
    getConstraintDefinition,
    getConstraintIdentities,
    JsonObject,
    SerializedConstraint,
} from './Descriptor';

/**
 * Constraint identities are process-unique by design (a duplicate would make a serialised
 * descriptor ambiguous), so tests mint fresh ones rather than reusing a shared fixture.
 */
let identityCounter = 0;
const uniqueIdentity = (label: string) => `test:${label}:${identityCounter++}`;

interface MinParams extends JsonObject {
    min: number;
}

const defineMin = (identity: string = uniqueIdentity('min')) =>
    defineConstraint<MinParams>({
        kind: 'number',
        constraint: identity,
        derive: params => value => (value as number) >= params.min,
        describe: params => `a number greater than or equal to ${params.min}`,
    });

describe('defineConstraint', () => {
    it('builds a descriptor carrying identity and params as data', () => {
        const identity = uniqueIdentity('min');
        const descriptor = defineMin(identity)({min: 5});

        expect(descriptor.kind).toBe('number');
        expect(descriptor.constraint).toBe(identity);
        expect(descriptor.params).toEqual({min: 5});
    });

    it('exposes the originating definition on the factory', () => {
        const identity = uniqueIdentity('min');
        const factory = defineMin(identity);

        expect(factory.definition.constraint).toBe(identity);
        expect(getConstraintDefinition(identity)).toBe(factory.definition);
        expect(getConstraintIdentities()).toContain(identity);
    });

    it('rejects a duplicate constraint identity', () => {
        const identity = uniqueIdentity('duplicate');
        defineMin(identity);

        expect(() => defineMin(identity)).toThrow(/already registered/);
    });

    it('requires a derive function — predicates are never attached alongside params', () => {
        expect(() =>
            defineConstraint({
                kind: 'number',
                constraint: uniqueIdentity('noDerive'),
                describe: () => 'anything',
            } as any),
        ).toThrow(/derive/);
    });

    it('requires a non-empty identity', () => {
        expect(() =>
            defineConstraint({
                kind: 'number',
                constraint: '',
                derive: () => () => true,
                describe: () => 'anything',
            }),
        ).toThrow(/identity/);
    });
});

describe('predicate derivation (DEC-010)', () => {
    it('derives the check from params, so the two cannot disagree', () => {
        const min = defineMin();

        expect(min({min: 0}).predicate(0)).toBe(true);
        expect(min({min: 0}).predicate(-1)).toBe(false);
        expect(min({min: 10}).predicate(9)).toBe(false);
        expect(min({min: 10}).predicate(10)).toBe(true);
    });

    it('agrees with its own params at the boundary', () => {
        const min = defineMin();

        [-100, -1, 0, 1, 7, 8, 9, 100].forEach(bound => {
            const descriptor = min({min: bound});
            expect(descriptor.predicate(bound - 1)).toBe(false);
            expect(descriptor.predicate(bound)).toBe(true);
            expect(descriptor.predicate(bound + 1)).toBe(true);
        });
    });

    it('fails loudly when derive does not return a function', () => {
        const broken = defineConstraint({
            kind: 'generic',
            constraint: uniqueIdentity('broken'),
            derive: () => undefined as any,
            describe: () => 'anything',
        });

        expect(() => broken({})).toThrow(/did not return a function/);
    });
});

describe('params immutability', () => {
    it("clones the caller's object so later mutation cannot desynchronise the predicate", () => {
        const min = defineMin();
        const source: MinParams = {min: 5};
        const descriptor = min(source);

        source.min = 500;

        expect(descriptor.params.min).toBe(5);
        expect(descriptor.predicate(5)).toBe(true);
    });

    it('deep-freezes params', () => {
        const nested = defineConstraint<JsonObject>({
            kind: 'generic',
            constraint: uniqueIdentity('nested'),
            derive: () => () => true,
            describe: () => 'anything',
        });
        const descriptor = nested({outer: {inner: [1, 2]}});

        expect(Object.isFrozen(descriptor.params)).toBe(true);
        expect(Object.isFrozen((descriptor.params as any).outer)).toBe(true);
        expect(Object.isFrozen((descriptor.params as any).outer.inner)).toBe(true);
    });

    it('freezes the descriptor itself', () => {
        expect(Object.isFrozen(defineMin()({min: 1}))).toBe(true);
    });
});

describe('params serialisability', () => {
    const build = (params: any) => () =>
        defineConstraint<any>({
            kind: 'generic',
            constraint: uniqueIdentity('serialisable'),
            derive: () => () => true,
            describe: () => 'anything',
        })(params);

    it('accepts plain JSON data', () => {
        expect(build({a: 1, b: 'two', c: true, d: null, e: [1, {f: 'g'}]})).not.toThrow();
    });

    it('rejects a function', () => {
        expect(build({fn: () => true})).toThrow(/JSON-serialisable/);
    });

    it('rejects undefined', () => {
        expect(build({missing: undefined})).toThrow(/JSON-serialisable/);
    });

    it('rejects a symbol', () => {
        expect(build({sym: Symbol('x')})).toThrow(/JSON-serialisable/);
    });

    it('rejects a RegExp, and says how to represent one instead', () => {
        expect(build({pattern: /^a+$/i})).toThrow(/source, flags/);
    });

    it('rejects a class instance', () => {
        expect(build({when: new Date()})).toThrow(/plain JSON data/);
    });

    it('rejects NaN and Infinity, which JSON cannot carry', () => {
        expect(build({min: NaN})).toThrow(/finite number/);
        expect(build({min: Infinity})).toThrow(/finite number/);
    });

    it('rejects non-object params', () => {
        expect(build([1, 2])).toThrow(/plain object/);
        expect(build(null)).toThrow(/plain object/);
    });
});

describe('JSON round-trip', () => {
    it('serialises to identity plus params only — no predicate on the wire', () => {
        const identity = uniqueIdentity('min');
        const descriptor = defineMin(identity)({min: 3});
        const wire = JSON.parse(JSON.stringify(descriptor));

        expect(wire).toEqual({kind: 'number', constraint: identity, params: {min: 3}});
    });

    it('rehydrates into a descriptor that enforces exactly what the original did', () => {
        const identity = uniqueIdentity('min');
        const original = defineMin(identity)({min: 4});
        const revived = constraintFromJSON(JSON.parse(JSON.stringify(original)));

        expect(revived.constraint).toBe(original.constraint);
        expect(revived.params).toEqual(original.params);
        expect(revived.describe()).toBe(original.describe());

        [-1, 0, 3, 4, 5, 1000].forEach(value => {
            expect(revived.predicate(value)).toBe(original.predicate(value));
        });
    });

    it('rejects an identity whose defining module was never imported', () => {
        const orphan: SerializedConstraint = {
            kind: 'number',
            constraint: 'test:never-registered',
            params: {min: 1},
        };

        expect(() => constraintFromJSON(orphan)).toThrow(/unknown constraint identity/);
    });
});

describe('optional projection hooks', () => {
    it('omits arbitrary and schema when the definition supplies neither', () => {
        const descriptor = defineMin()({min: 1});

        expect('arbitrary' in descriptor).toBe(false);
        expect('schema' in descriptor).toBe(false);
    });

    it('remains fully usable for validation and documentation without them', () => {
        const descriptor = defineMin()({min: 2});

        expect(descriptor.predicate(2)).toBe(true);
        expect(descriptor.describe()).toBe('a number greater than or equal to 2');
        expect(descriptor.params).toEqual({min: 2});
    });

    it("binds supplied hooks to the descriptor's own params", () => {
        const withHooks = defineConstraint<MinParams>({
            kind: 'number',
            constraint: uniqueIdentity('hooked'),
            derive: params => value => (value as number) >= params.min,
            describe: params => `at least ${params.min}`,
            arbitrary: params => ({from: params.min}),
            schema: params => ({type: 'number', minimum: params.min}),
        });
        const descriptor = withHooks({min: 7});

        expect(descriptor.arbitrary!()).toEqual({from: 7});
        expect(descriptor.schema!()).toEqual({type: 'number', minimum: 7});
    });
});

describe('message formatting', () => {
    const numeric = defineMin();
    const stringy = defineConstraint<ConstraintParams>({
        kind: 'string',
        constraint: uniqueIdentity('stringy'),
        derive: () => () => false,
        describe: () => 'a string of length greater than 3',
    });

    it('uses the supplied signature as the subject', () => {
        const descriptor = numeric({min: 5});

        expect(
            descriptor.message({
                value: 2,
                signature: "Task.test(count) parameter 'count'",
            }),
        ).toBe(
            "Value Error: Task.test(count) parameter 'count' expected a number greater than or " +
                'equal to 5 but received [REDACTED] instead',
        );
    });

    it('falls back to the parameter name, then to a generic subject', () => {
        const descriptor = numeric({min: 5});

        expect(descriptor.message({value: 2, paramName: 'count'})).toBe(
            'Value Error: count expected a number greater than or equal to 5 but received [REDACTED] instead',
        );
        expect(descriptor.message({value: 2})).toBe(
            'Value Error: value expected a number greater than or equal to 5 but received [REDACTED] instead',
        );
    });

    // --- BUG-19 / DEC-PII-1: the received value is redacted by default ------

    it('REDACTS the received value by default — nothing extra needs forwarding for safety', () => {
        // The default lives in `formatMessage`, so a caller (or a future enforcement path) that
        // supplies no `disclose` gets the safe rendering rather than the leak. This is why routing a
        // violation anywhere (setViolationPolicy, an error tracker) can no longer leak the value.
        expect(stringy({}).message({value: 'hunter2', paramName: 'password'})).toBe(
            'Value Error: password expected a string of length greater than 3 but received [REDACTED] instead',
        );
        expect(numeric({min: 5}).message({value: 2, paramName: 'count'})).toContain(
            'received [REDACTED] instead',
        );
        // The raw value appears nowhere in the rendered string.
        expect(stringy({}).message({value: 'hunter2', paramName: 'password'})).not.toContain('hunter2');
    });

    it('discloses the value only when `disclose: true` — quoting strings, not numerics', () => {
        // The opt-in path (setValueDisclosure('all') resolves this boolean at the enforcement site).
        expect(stringy({}).message({value: 'ab', paramName: 'message', disclose: true})).toContain(
            "received 'ab' instead",
        );
        expect(numeric({min: 5}).message({value: 2, paramName: 'count', disclose: true})).toContain(
            'received 2 instead',
        );
    });

    it('treats a non-true `disclose` as redact — the safe default is sticky', () => {
        expect(stringy({}).message({value: 'ab', paramName: 'm', disclose: false})).toContain(
            'received [REDACTED] instead',
        );
        expect(numeric({min: 5}).message({value: 2, paramName: 'c', disclose: undefined})).toContain(
            'received [REDACTED] instead',
        );
    });
});
