/**
 * `Enforce.*` statics for the new descriptor kinds (round-3 §7 / GAP-21 / DEC-062).
 *
 * `@Enforce.*` is where a consumer decorates a FIELD, and it previously stopped at number/string
 * primitives — so a compositional field forced the verbose `@CreateFieldDecorator(ArrayOf(...))`, which
 * bit `@Shape` (its prerequisite is decorating a field class). These pin the new statics and the
 * end-to-end ergonomic path: a field class decorated with `@Enforce.arrayOf`, then read by `@Shape`.
 */

import {Enforce, StringContracts, ObjectContracts, Verify} from '../index';
import {resetConfiguration} from '../src/Core/Configuration';

beforeEach(resetConfiguration);

describe('Enforce.* — the new membership/format/composition statics (DEC-062)', () => {
    it('Enforce.oneOf enforces membership on assignment', () => {
        class Cfg {
            @Enforce.oneOf(['celsius', 'fahrenheit']) unit!: string;
        }
        const c = new Cfg();
        c.unit = 'celsius';
        expect(c.unit).toBe('celsius');
        expect(() => {
            c.unit = 'kelvin';
        }).toThrow();
    });

    it('Enforce.const and Enforce.uuid enforce', () => {
        class Reading {
            @Enforce.const('v2') version!: string;
            @Enforce.uuid() id!: string;
        }
        const r = new Reading();
        r.version = 'v2';
        expect(() => {
            r.version = 'v1';
        }).toThrow();
        r.id = '123e4567-e89b-42d3-a456-426614174000';
        expect(() => {
            r.id = 'not-a-uuid';
        }).toThrow();
    });

    it('Enforce.arrayOf enforces every element on assignment', () => {
        class Filter {
            @Enforce.arrayOf(StringContracts.NotEmpty()) tags!: string[];
        }
        const f = new Filter();
        f.tags = ['a', 'b'];
        expect(f.tags).toEqual(['a', 'b']);
        expect(() => {
            f.tags = ['a', ''];
        }).toThrow();
    });

    it('Enforce.dictionary enforces every value on assignment', () => {
        class Slots {
            @Enforce.dictionary(StringContracts.NotEmpty()) input!: Record<string, string>;
        }
        const s = new Slots();
        s.input = {a: 'x'};
        expect(() => {
            s.input = {a: ''};
        }).toThrow();
    });

    it('the ergonomic @Shape path: a field class decorated with @Enforce.arrayOf is readable by @Shape', () => {
        class Filter {
            @Enforce.arrayOf(StringContracts.NotEmpty()) tags!: string[];
        }
        // @Shape reads Filter's field contracts — previously this needed @CreateFieldDecorator(ArrayOf(...)).
        const shape = ObjectContracts.Shape(Filter);
        expect(Verify.check(shape, 'filter', {tags: ['a', 'b']}).ok).toBe(true);
        expect(Verify.check(shape, 'filter', {tags: ['']}).ok).toBe(false);
    });
});
