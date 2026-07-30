/**
 * `@Optional` (enforcement-aware) + `@Default` — DEC-051, resolving Q-28.
 *
 * `@Optional` makes an **absent** (`undefined`) argument satisfy a position and drops it from the tool
 * schema's `required`; `@Default` annotates a JSON default (`{default}`) and implies `@Optional`. Both
 * effects — enforcement and the schema — derive from the SAME effective read
 * (`getEffectiveParameterOptional`), so they cannot drift (DEC-006).
 *
 * ## The load-bearing property these pin: inheritance is REQUIRED-WINS (S2 / DEC-016 / DEC-022)
 *
 * `@Optional` is a precondition *weakening*, so a subclass must never be able to silently weaken a value
 * its base genuinely constrains. The four invariants below are the spec; each is pinned.
 *
 * Classes are declared *inside* each test (SMELL-18 convention) so the suite is independent of registry
 * accumulation order; no `resetRegistry` is needed (each class is a fresh constructor).
 */

import {Contract} from '../src/Adapters/legacy/ContractInstaller';
import {ArrayOf, GreaterThanEqual, LessThanEqual, NotEmpty} from '../src/ParameterDecorators/Constraints';
import {Optional} from '../src/Markers/Optional';
import {Default} from '../src/Markers/Default';
import {schemaForClass, toolSchemaForMethod} from '../src/Projections/schema';
import {getEffectiveParameterOptional} from '../src/Core/ContractRegistry';
import * as StringContracts from '../src/Contracts/string';
import {JsonObject} from '../src/Core/Descriptor';

// ---------------------------------------------------------------------------
// Enforcement — "absent, OR satisfies the constraint when present"
// ---------------------------------------------------------------------------

describe('@Optional enforcement (DEC-051)', () => {
    it('lets an absent (undefined) argument pass, still throws on a present-but-invalid one', () => {
        @Contract()
        class Scheduler {
            schedule(@Optional() @GreaterThanEqual(1) days: number): string {
                return days === undefined ? 'default' : `in ${days} days`;
            }
        }
        const s = new Scheduler();

        // Absent — both the explicit `undefined` and the omitted-argument forms.
        expect(s.schedule(undefined as unknown as number)).toBe('default');
        expect((s.schedule as () => string)()).toBe('default');
        // Present and valid.
        expect(s.schedule(5)).toBe('in 5 days');
        // Present and invalid still throws — @Optional does not weaken a present value.
        expect(() => s.schedule(0)).toThrow();
    });

    it('treats null as PRESENT, not absent — a present null runs the checks and is rejected', () => {
        @Contract()
        class Scheduler {
            schedule(@Optional() @GreaterThanEqual(1) days: number): string {
                return `in ${days} days`;
            }
        }
        // null is a present value; the total numeric predicate rejects it (null ≠ absent).
        expect(() => new Scheduler().schedule(null as unknown as number)).toThrow();
    });

    it('skips ALL stacked constraints when absent, checks ALL of them when present', () => {
        @Contract()
        class Ranged {
            take(@Optional() @GreaterThanEqual(1) @LessThanEqual(10) n: number): string {
                return n === undefined ? 'absent' : `n=${n}`;
            }
        }
        const r = new Ranged();

        expect(r.take(undefined as unknown as number)).toBe('absent'); // whole position skipped
        expect(r.take(5)).toBe('n=5'); // present valid → both bounds checked and hold
        expect(() => r.take(0)).toThrow(); // present → lower bound bites
        expect(() => r.take(11)).toThrow(); // present → upper bound bites
    });

    it('does not change which violation OTHER positions report', () => {
        @Contract()
        class Two {
            act(@NotEmpty() label: string, @Optional() @GreaterThanEqual(1) n: number): string {
                return `${label}:${n}`;
            }
        }
        // `n` absent, but `label` still enforced normally — the guard only short-circuits its own index.
        expect(() => new Two().act('', undefined as unknown as number)).toThrow(/length|empty|NotEmpty/i);
    });
});

// ---------------------------------------------------------------------------
// The four inheritance invariants — each pinned (S2, the safety fix)
// ---------------------------------------------------------------------------

describe('@Optional inheritance is required-wins (S2 / DEC-016 / DEC-022)', () => {
    it('INVARIANT 1: @Optional on a class, required by no class on the chain → OPTIONAL', () => {
        @Contract()
        class One {
            m(@Optional() @GreaterThanEqual(1) x: number): string {
                return x === undefined ? 'absent' : `x=${x}`;
            }
        }

        expect(getEffectiveParameterOptional(One.prototype, 'm', 0)).toBe(true);
        // Absent passes; present-invalid still throws.
        expect(new One().m(undefined as unknown as number)).toBe('absent');
        expect(() => new One().m(0)).toThrow();
        // Schema agrees: in properties, absent from required.
        const schema = toolSchemaForMethod(One, 'm');
        expect(schema.properties).toHaveProperty('x');
        expect(schema.required).toEqual([]);
    });

    it('INVARIANT 2 (safety): constrained-required BASE, @Optional subclass override → REQUIRED', () => {
        @Contract()
        class Base {
            handle(@GreaterThanEqual(1) n: number): string {
                return `base:${n}`;
            }
        }
        @Contract()
        class Sub extends Base {
            handle(@Optional() n: number): string {
                return `sub:${n}`;
            }
        }

        // The subclass CANNOT silently weaken: the position stays required.
        expect(getEffectiveParameterOptional(Sub.prototype, 'handle', 0)).toBe(false);
        expect(() => (new Sub().handle as () => string)()).toThrow(); // absent → still rejected
        expect(() => new Sub().handle(0)).toThrow(); // present invalid → rejected
        expect(new Sub().handle(5)).toBe('sub:5');
        expect(toolSchemaForMethod(Sub, 'handle').required).toEqual(['n']);
    });

    it('INVARIANT 3: @Optional BASE, constrained-without-@Optional subclass override → REQUIRED', () => {
        @Contract()
        class Base {
            act(@Optional() @NotEmpty() name: string): string {
                return name === undefined ? 'base:absent' : `base:${name}`;
            }
        }
        @Contract()
        class Sub extends Base {
            act(@NotEmpty() name: string): string {
                return `sub:${name}`;
            }
        }

        // The base is optional for its own calls.
        expect(getEffectiveParameterOptional(Base.prototype, 'act', 0)).toBe(true);
        expect(new Base().act(undefined as unknown as string)).toBe('base:absent');
        expect(() => new Base().act('')).toThrow();

        // The subclass strengthened (added a constraint, no @Optional) → required again.
        expect(getEffectiveParameterOptional(Sub.prototype, 'act', 0)).toBe(false);
        expect(() => (new Sub().act as () => string)()).toThrow(); // absent → rejected
        expect(() => new Sub().act('')).toThrow();
        expect(new Sub().act('hi')).toBe('sub:hi');
        expect(toolSchemaForMethod(Sub, 'act').required).toEqual(['name']);
    });

    it('INVARIANT 4: enforcement and the tool-schema required derive from the SAME read', () => {
        @Contract()
        class Api {
            call(@NotEmpty() url: string, @Optional() @GreaterThanEqual(1) retries: number): string {
                return `${url}#${retries}`;
            }
        }
        const api = new Api();
        const schema = toolSchemaForMethod(Api, 'call');

        // The schema-omittable position (retries) is EXACTLY the one enforcement accepts absent…
        expect(schema.required).not.toContain('retries');
        expect(api.call('u', undefined as unknown as number)).toBe('u#undefined');
        // …and the schema-required position (url) is EXACTLY the one enforcement rejects absent.
        expect(schema.required).toContain('url');
        expect(() => api.call(undefined as unknown as string, 3)).toThrow();
    });
});

// ---------------------------------------------------------------------------
// Tool schema — optionality reflected in `required`
// ---------------------------------------------------------------------------

describe('toolSchemaForMethod reflects @Optional in required (DEC-051)', () => {
    it('keeps an @Optional constrained param in properties but drops it from required', () => {
        @Contract()
        class Api {
            fetch(@NotEmpty() url: string, @Optional() @GreaterThanEqual(1) retries: number): string {
                return `${url}#${retries}`;
            }
        }
        const schema = toolSchemaForMethod(Api, 'fetch');

        expect(schema.properties).toEqual({
            url: {type: 'string', minLength: 1},
            retries: {type: 'number', minimum: 1}, // still fully in properties, constraint intact
        });
        expect(schema.required).toEqual(['url']); // retries dropped
    });

    it('drops an @ArrayOf + @Optional param from required while keeping its array fragment', () => {
        @Contract()
        class Tagger {
            tag(@ArrayOf(StringContracts.NotEmpty(), {minItems: 1}) @Optional() tags: string[]): void {
                void tags;
            }
        }
        const schema = toolSchemaForMethod(Tagger, 'tag');

        expect((schema.properties as Record<string, JsonObject>).tags).toEqual({
            type: 'array',
            items: {type: 'string', minLength: 1},
            minItems: 1,
        });
        expect(schema.required).toEqual([]); // optional → absent from required
    });

    it('schemaForClass (descriptive) is UNCHANGED by @Optional — an explicit no-op', () => {
        @Contract()
        class Api {
            fetch(@NotEmpty() url: string, @Optional() @GreaterThanEqual(1) retries: number): string {
                return `${url}#${retries}`;
            }
        }
        const classSchema = schemaForClass(Api);

        // The root instance schema never emits required/additionalProperties (DEC-029), optional or not.
        expect(classSchema.required).toBeUndefined();
        expect(classSchema.additionalProperties).toBeUndefined();
        // The method's positional tuple still carries the retries constraint fragment, unchanged.
        const method = (classSchema.methods as Record<string, JsonObject>).fetch;
        expect((method.prefixItems as JsonObject[])[1]).toEqual({type: 'number', minimum: 1});
    });
});

// ---------------------------------------------------------------------------
// @Default — annotate, imply optional, never inject
// ---------------------------------------------------------------------------

describe('@Default (DEC-051)', () => {
    it('emits {default} into the tool schema and drops the param from required (implies @Optional)', () => {
        @Contract()
        class Query {
            run(@NotEmpty() sql: string, @Default(10) limit: number): string {
                return `${sql} limit ${limit}`;
            }
        }
        const schema = toolSchemaForMethod(Query, 'run');

        expect((schema.properties as Record<string, JsonObject>).limit.default).toBe(10);
        // @Default implies @Optional, so limit is dropped from required (and carried no constraint anyway).
        expect(schema.required).toEqual(['sql']);
        expect(getEffectiveParameterOptional(Query.prototype, 'run', 1)).toBe(true);
    });

    it('emits {default} alongside a real constraint fragment (canonical order: default last)', () => {
        @Contract()
        class Paged {
            list(@Default(20) @GreaterThanEqual(1) limit: number): void {
                void limit;
            }
        }
        const props = toolSchemaForMethod(Paged, 'list').properties as Record<string, JsonObject>;
        // Fragment carries both the bound and the annotation; @Default also drops it from required.
        expect(props.limit).toEqual({type: 'number', minimum: 1, default: 20});
        expect(toolSchemaForMethod(Paged, 'list').required).toEqual([]);
    });

    it('does NOT inject the default at runtime — even on a @Contract-wrapped method', () => {
        let seen: unknown = 'unset';
        @Contract()
        class Sink {
            take(@NotEmpty() label: string, @Default(42) n: number): void {
                seen = n;
            }
        }
        // Omit `n`: the wrapped method body sees `undefined`, NOT the annotated default 42.
        new Sink().take('x', undefined as unknown as number);
        expect(seen).toBeUndefined();
        // A present value flows through untouched.
        new Sink().take('y', 7);
        expect(seen).toBe(7);
    });

    it('serialises a null / array / object default faithfully', () => {
        @Contract()
        class Cfg {
            set(@NotEmpty() key: string, @Default(null) fallback: unknown): void {
                void key;
                void fallback;
            }
        }
        const props = toolSchemaForMethod(Cfg, 'set').properties as Record<string, JsonObject>;
        // A null default is a real, distinct value — not "no default".
        expect('default' in props.fallback).toBe(true);
        expect(props.fallback.default).toBeNull();
    });

    it('rejects a non-JSON-serialisable default at authoring time', () => {
        expect(() => Default((() => 0) as unknown as number)).toThrow(/JSON-serialisable/);
        expect(() => Default(undefined as unknown as number)).toThrow(/JSON-serialisable/);
        expect(() => Default(NaN as unknown as number)).toThrow(/JSON-serialisable/);
        expect(() => Default(Symbol('x') as unknown as number)).toThrow(/JSON-serialisable/);
        // Valid JSON values are accepted.
        expect(() => Default(null)).not.toThrow();
        expect(() => Default([1, 'a', true])).not.toThrow();
        expect(() => Default({a: 1, b: [2, 3]})).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// Misuse — both markers must land on a parameter
// ---------------------------------------------------------------------------

describe('@Optional / @Default reject non-parameter placement', () => {
    it('@Optional throws when not applied to a parameter', () => {
        expect(() => (Optional() as (t: object, k?: string) => void)({}, 'method')).toThrow(
            /must be applied to a parameter/,
        );
    });

    it('@Default throws when not applied to a parameter', () => {
        expect(() => (Default(1) as (t: object, k?: string) => void)({}, 'method')).toThrow(
            /must be applied to a parameter/,
        );
    });
});
