/**
 * `toolSchemaForMethod(..., { providerStrict })` — OpenAI strict-mode emission on the DECORATED path
 * (DEC-071, the port of the option that previously lived only on `toolSchemaFrom`).
 *
 * These mirror the `toolSchemaFrom` strict tests for the method surface, and additionally pin the
 * diagnostic-attribution fix: a refusal must name `toolSchemaForMethod` and give DECORATOR advice
 * (`@Nullable`, `@Shape`), never the descriptor-first `Fields({...})` / `NullableContracts.Nullable`
 * phrasing — the whole reason the shared `strictifyForProvider` pass was parameterized.
 */

import {
    Contract,
    Tool,
    NotEmpty,
    GreaterThanEqual,
    Nullable,
    Shape,
    Dictionary,
    Optional,
    Enforce,
    StringContracts,
} from '../index';
import {toolSchemaForMethod} from '../schema';

// A contracted field class for @Shape — every field is a class invariant, hence always required.
class Point {
    @Enforce.greaterThanEqual(0) x!: number;
    @Enforce.greaterThanEqual(0) y!: number;
}

describe('toolSchemaForMethod providerStrict — the port (DEC-071)', () => {
    it('is a no-op when every param is already required and every object already closed', () => {
        @Contract()
        class AllRequired {
            @Tool('all required')
            m(@NotEmpty() a: string, @GreaterThanEqual(1) b: number, @Shape(Point) at: object): void {
                void a;
                void b;
                void at;
            }
        }

        // @Shape is already tightened (closed + all-required) by the normal method path, and the root is
        // already all-required, so strict changes nothing: the two documents are identical.
        const plain = toolSchemaForMethod(AllRequired, 'm');
        const strict = toolSchemaForMethod(AllRequired, 'm', {providerStrict: true});
        expect(strict).toEqual(plain);

        // And the nested @Shape is genuinely closed.
        const at = (strict.properties as Record<string, Record<string, unknown>>).at;
        expect(at.additionalProperties).toBe(false);
        expect((at.required as string[]).slice().sort()).toEqual(['x', 'y']);
    });

    it('KEEPS a nullable optional param in `required` under strict (dropped without it)', () => {
        @Contract()
        class WithNullableOpt {
            m(@NotEmpty() id: string, @Optional() @Nullable(StringContracts.NotEmpty()) note: string): void {
                void id;
                void note;
            }
        }

        // Without strict: `note` is @Optional → dropped from required.
        expect(toolSchemaForMethod(WithNullableOpt, 'm').required).toEqual(['id']);

        // With strict: `note` admits null → promoted back into required, carrying its null-union schema.
        const strict = toolSchemaForMethod(WithNullableOpt, 'm', {providerStrict: true});
        expect((strict.required as string[]).slice().sort()).toEqual(['id', 'note']);
        const note = (strict.properties as Record<string, Record<string, unknown>>).note;
        expect((note.type as string[]).slice().sort()).toEqual(['null', 'string']);
        expect(note.minLength).toBe(1); // the inner NotEmpty still enforced
    });

    it('REFUSES a bare non-nullable optional under strict — with toolSchemaForMethod + @Nullable advice', () => {
        @Contract()
        class BareOpt {
            m(@NotEmpty() id: string, @Optional() @NotEmpty() note: string): void {
                void id;
                void note;
            }
        }

        // Fine without the flag.
        expect(toolSchemaForMethod(BareOpt, 'm').required).toEqual(['id']);

        // Refused with it, and the diagnostic speaks the DECORATED idiom (DEC-071 attribution fix).
        let message = '';
        try {
            toolSchemaForMethod(BareOpt, 'm', {providerStrict: true});
        } catch (error) {
            message = (error as Error).message;
        }
        expect(message).toMatch(/note[\s\S]*nullable/i);
        expect(message).toContain('toolSchemaForMethod');
        expect(message).toContain('@Nullable');
        expect(message).not.toContain('toolSchemaFrom'); // never the wrong function
        expect(message).not.toContain('NullableContracts'); // never the descriptor idiom
    });

    it('REFUSES an open @Dictionary map under strict — with @Shape advice', () => {
        @Contract()
        class WithDict {
            m(@Dictionary(StringContracts.NotEmpty()) tags: object): void {
                void tags;
            }
        }

        // Fine without the flag — an open map is legal in the descriptive/non-strict projection.
        expect(() => toolSchemaForMethod(WithDict, 'm')).not.toThrow();

        let message = '';
        try {
            toolSchemaForMethod(WithDict, 'm', {providerStrict: true});
        } catch (error) {
            message = (error as Error).message;
        }
        expect(message).toMatch(/open map/i);
        expect(message).toContain('toolSchemaForMethod');
        expect(message).toContain('@Shape');
    });

    it('omitting providerStrict is identical to passing it false', () => {
        @Contract()
        class Plain {
            m(@Optional() @Nullable(StringContracts.NotEmpty()) note: string): void {
                void note;
            }
        }
        expect(toolSchemaForMethod(Plain, 'm', {providerStrict: false})).toEqual(
            toolSchemaForMethod(Plain, 'm'),
        );
    });
});
