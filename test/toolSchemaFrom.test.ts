/**
 * `toolSchemaFrom` — the descriptor-first tool schema (DEC-061 / IDEA-30 / round-3 §5).
 *
 * Builds the same prescriptive envelope as `toolSchemaForMethod` from named descriptors, no class required
 * — so a PER-SESSION enum projects at runtime. The headline test is byte-equality against the decorated
 * equivalent, which proves it REUSES `toolSchemaForMethod`'s internals rather than forking them.
 */

import {
    toolSchemaFrom,
    toolSchemaForMethod,
    Contract,
    Between,
    OneOf,
    NumberContracts,
    EnumContracts,
    ObjectContracts,
    ArrayContracts,
    StringContracts,
    NullableContracts,
    Enforce,
    setContractDiagnosticsSink,
} from '../index';

describe('toolSchemaFrom — descriptor-first tool schema (DEC-061)', () => {
    it('byte-equals toolSchemaForMethod for an equivalent decorated method (reuse, not fork)', () => {
        @Contract()
        class Weather {
            forecast(@Between(1, 7) days: number, @OneOf(['c', 'f']) unit: string) {
                return {days, unit};
            }
        }
        const fromMethod = toolSchemaForMethod(Weather, 'forecast');
        const fromDescriptors = toolSchemaFrom({
            name: 'Weather.forecast',
            params: {
                days: NumberContracts.Between(1, 7),
                unit: EnumContracts.OneOf(['c', 'f']),
            },
        });
        expect(fromDescriptors).toEqual(fromMethod);
    });

    it('projects a PER-SESSION enum with no class — the runtime-roster case', () => {
        const roster = ['p-dave', 'p-erin']; // known only at "session start"
        const schema = toolSchemaFrom({
            name: 'affirmFor',
            params: {subjects: ArrayContracts.ArrayOf(EnumContracts.OneOf(roster))},
        });
        const props = schema.properties as Record<string, Record<string, unknown>>;
        expect(props.subjects.type).toBe('array');
        expect((props.subjects.items as Record<string, unknown>).enum).toEqual(roster);
        expect(schema.required).toEqual(['subjects']);
        expect(schema.additionalProperties).toBe(false);
    });

    it('honours optional / description / default in a ToolParamSpec', () => {
        const schema = toolSchemaFrom({
            params: {
                city: {descriptor: StringContracts.NotEmpty(), description: 'the city to look up'},
                days: {descriptor: NumberContracts.Between(1, 7), optional: true, default: 3},
            },
        });
        const props = schema.properties as Record<string, Record<string, unknown>>;
        expect(props.city.description).toBe('the city to look up');
        expect(props.days.default).toBe(3);
        // `days` is optional → not required; `city` carries a constraint → required.
        expect(schema.required).toEqual(['city']);
    });

    it('recursively tightens a @Shape param via the SAME tightenObjects', () => {
        class Point {
            @Enforce.greaterThanEqual(0) x!: number;
            @Enforce.greaterThanEqual(0) y!: number;
        }
        const schema = toolSchemaFrom({params: {at: ObjectContracts.Shape(Point)}});
        const at = (schema.properties as Record<string, Record<string, unknown>>).at;
        expect(at.type).toBe('object');
        expect((at.required as string[]).slice().sort()).toEqual(['x', 'y']);
        expect(at.additionalProperties).toBe(false);
    });

    it('accepts a bare descriptor OR a spec, and a stacked-descriptor array (inside a spec)', () => {
        const schema = toolSchemaFrom({
            params: {n: {descriptor: [NumberContracts.GreaterThanEqual(1), NumberContracts.LessThanEqual(10)]}},
        });
        const n = (schema.properties as Record<string, Record<string, unknown>>).n;
        expect(n.minimum).toBe(1);
        expect(n.maximum).toBe(10);
    });

    it('throws on malformed input', () => {
        expect(() => toolSchemaFrom({} as never)).toThrow(/params/);
    });
});

describe('toolSchemaFrom runs the unsatisfiable-stack detector (round-4 §2.3 / GAP-20)', () => {
    // The trap round-3 §3.4 closed on the DECORATOR path had moved to the descriptor path the README now
    // recommends. The detector is the SAME (hoisted to Core), and — because the sink also moved to Core (C-1)
    // — a spy installed via the public `setContractDiagnosticsSink` catches the projection's emit.
    it('reports a container + primitive-enum stack as unsatisfiable', () => {
        const messages: string[] = [];
        setContractDiagnosticsSink(m => messages.push(m));
        try {
            toolSchemaFrom({
                params: {
                    subjects: {
                        descriptor: [
                            ArrayContracts.ArrayOf(StringContracts.NotEmpty()),
                            EnumContracts.OneOf(['alice', 'bob']),
                        ],
                    },
                },
            });
        } finally {
            setContractDiagnosticsSink(null);
        }
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain("parameter 'subjects'");
        expect(messages[0]).toContain('unsatisfiable');
    });

    it('stays silent for the CORRECT nested form (enum inside the container)', () => {
        const messages: string[] = [];
        setContractDiagnosticsSink(m => messages.push(m));
        try {
            toolSchemaFrom({params: {subjects: ArrayContracts.ArrayOf(EnumContracts.OneOf(['alice', 'bob']))}});
        } finally {
            setContractDiagnosticsSink(null);
        }
        expect(messages).toEqual([]);
    });
});

describe('toolSchemaFrom providerStrict — OpenAI-strict-compatible optional encoding (Q-32b, DEC-068)', () => {
    it('default (off) drops a nullable optional from required; strict KEEPS it', () => {
        const spec = {
            patientId: StringContracts.Uuid(),
            note: {descriptor: NullableContracts.Nullable(StringContracts.NotEmpty()), optional: true},
        };
        // non-strict: `note` is truly optional → not required
        expect(toolSchemaFrom({params: spec}).required).toEqual(['patientId']);
        // strict: `note` admits null → kept in `required` (with its null-union schema, so no drift)
        const strict = toolSchemaFrom({params: spec}, {providerStrict: true});
        expect((strict.required as string[]).slice().sort()).toEqual(['note', 'patientId']);
    });

    it('REFUSES a bare non-nullable optional under providerStrict (but not without it)', () => {
        const spec = {note: {descriptor: StringContracts.NotEmpty(), optional: true}};
        expect(() => toolSchemaFrom({params: spec}, {providerStrict: true})).toThrow(/nullable/i);
        expect(toolSchemaFrom({params: spec}).required).toEqual([]); // fine without the flag
    });

    it('accepts a nullable-enum optional under strict (Nullable(OneOf) → anyOf-with-null)', () => {
        const spec = {
            subject: {descriptor: NullableContracts.Nullable(EnumContracts.OneOf(['a', 'b'])), optional: true},
        };
        const strict = toolSchemaFrom({params: spec}, {providerStrict: true});
        expect(strict.required).toEqual(['subject']);
    });

    it('closes a Nullable(Shape) object under tightenObjects (D-3) so strict accepts it', () => {
        class Point {
            @Enforce.greaterThanEqual(0) x!: number;
            @Enforce.greaterThanEqual(0) y!: number;
        }
        const schema = toolSchemaFrom(
            {params: {at: {descriptor: NullableContracts.Nullable(ObjectContracts.Shape(Point)), optional: true}}},
            {providerStrict: true},
        );
        const at = (schema.properties as Record<string, Record<string, unknown>>).at;
        expect(at.type).toEqual(['object', 'null']); // stays nullable
        expect(at.additionalProperties).toBe(false); // but the object branch is CLOSED (D-3)
        expect((at.required as string[]).slice().sort()).toEqual(['x', 'y']);
        expect(schema.required).toContain('at'); // kept in required (admits null)
    });
});

describe('toolSchemaFrom providerStrict RECURSES into nested objects (DEC-069)', () => {
    const {Fields, Shape, Dictionary} = ObjectContracts;
    const {Nullable} = NullableContracts;

    it('promotes a NULLABLE optional field inside a nested Fields into the nested required', () => {
        const schema = toolSchemaFrom(
            {
                params: {
                    slot: Fields({
                        when: StringContracts.DateTime(),
                        label: {descriptor: Nullable(StringContracts.NotEmpty()), optional: true},
                    }),
                },
            },
            {providerStrict: true},
        );
        const slot = (schema.properties as Record<string, Record<string, unknown>>).slot;
        expect((slot.required as string[]).slice().sort()).toEqual(['label', 'when']); // `label` promoted
        expect(slot.additionalProperties).toBe(false);
        // `label` keeps its null-union, so the model may send null and Verify.check(Nullable(...)) accepts it
        expect((slot.properties as Record<string, Record<string, unknown>>).label.type).toEqual(['string', 'null']);
    });

    it('REFUSES a BARE optional field inside a nested Fields, naming the field', () => {
        expect(() =>
            toolSchemaFrom(
                {
                    params: {
                        slot: Fields({
                            when: StringContracts.DateTime(),
                            label: {descriptor: StringContracts.NotEmpty(), optional: true},
                        }),
                    },
                },
                {providerStrict: true},
            ),
        ).toThrow(/label[\s\S]*nullable/i);
    });

    it('recurses through DEEP nesting (Fields in Fields)', () => {
        const schema = toolSchemaFrom(
            {
                params: {
                    outer: Fields({
                        inner: Fields({
                            id: NumberContracts.Integer(),
                            note: {descriptor: Nullable(StringContracts.NotEmpty()), optional: true},
                        }),
                    }),
                },
            },
            {providerStrict: true},
        );
        const outer = (schema.properties as Record<string, Record<string, unknown>>).outer;
        const inner = (outer.properties as Record<string, Record<string, unknown>>).inner;
        expect((inner.required as string[]).slice().sort()).toEqual(['id', 'note']); // promoted DEEP
    });

    it('recurses into ArrayOf items (an array of Fields with a nullable optional)', () => {
        const schema = toolSchemaFrom(
            {
                params: {
                    slots: ArrayContracts.ArrayOf(
                        Fields({
                            when: StringContracts.DateTime(),
                            label: {descriptor: Nullable(StringContracts.NotEmpty()), optional: true},
                        }),
                    ),
                },
            },
            {providerStrict: true},
        );
        const items = (schema.properties as Record<string, Record<string, Record<string, unknown>>>).slots
            .items as Record<string, unknown>;
        expect((items.required as string[]).slice().sort()).toEqual(['label', 'when']);
    });

    it('forwards a nested optional field `default` into the strict schema (review Finding 2 shape)', () => {
        const schema = toolSchemaFrom(
            {
                params: {
                    slot: Fields({
                        when: StringContracts.DateTime(),
                        label: {descriptor: Nullable(StringContracts.NotEmpty()), optional: true, default: 'untitled'},
                    }),
                },
            },
            {providerStrict: true},
        );
        const slot = (schema.properties as Record<string, Record<string, unknown>>).slot;
        expect((slot.properties as Record<string, Record<string, unknown>>).label.default).toBe('untitled');
        expect((slot.required as string[]).slice().sort()).toEqual(['label', 'when']);
    });

    it('REFUSES an open map (@Dictionary) under strict', () => {
        expect(() =>
            toolSchemaFrom({params: {tags: Dictionary(StringContracts.NotEmpty())}}, {providerStrict: true}),
        ).toThrow(/open map/i);
    });

    it('does NOT bogus-throw on a stacked Shape whose raw fragment has no `required` (review Finding 1)', () => {
        class Point {
            @Enforce.greaterThanEqual(0) x!: number;
            @Enforce.greaterThanEqual(0) y!: number;
        }
        // A stacked [Shape, Fields] param conflicts on `properties` → an allOf that tightenObjects never descends,
        // so the Shape member reaches strictify with no `required`. Its fields are REQUIRED (not optional), so
        // strictify must not demand they be nullable.
        expect(() =>
            toolSchemaFrom(
                {params: {at: {descriptor: [Shape(Point), Fields({tag: StringContracts.NotEmpty()})]}}},
                {providerStrict: true},
            ),
        ).not.toThrow();
    });
});
