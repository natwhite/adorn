/**
 * Tests for the load-then-project path (DEC-007) — the CLI's hard part.
 *
 * The registry is a singleton populated only when a decorated module is imported. These tests point
 * the loader at a real decorated fixture (`test/cli-fixtures/order-source.ts`) and assert that (a)
 * nothing is visible until it is loaded, and (b) once loaded, the CLI's render is byte-for-byte what
 * `generateMarkdown()` / `generateSchema()` produce over the same registry — i.e. the CLI adds only
 * the loading, and the projection itself is untouched.
 *
 * Under jest, `require`-ing the fixture goes through ts-jest and resolves its `../../src` imports to
 * the same source `ContractRegistry` these projections read, so the singleton is shared. The fixture
 * is `require`-cached, so it populates the registry once; the tests are ordered to load it exactly
 * once and then read the populated state, and never `resetRegistry` (which would empty a store a
 * cached re-require could not refill).
 */

import * as path from 'path';
import {renderDocs, renderSchema} from './commands';
import {loadEntries} from './load';
import {CliError} from './errors';
import {generateMarkdown} from '../Projections/docs';
import {generateSchema} from '../Projections/schema';

const FIXTURE = path.resolve(__dirname, '../../test/cli-fixtures/order-source.ts');

describe('docs — load then project', () => {
    it('is empty before loading, then documents the loaded class (DEC-007)', () => {
        // Before any entry is imported the registry is empty — the projection says so out loud rather
        // than emitting a bare heading, which is the DEC-007 symptom of a forgotten entry.
        expect(generateMarkdown()).toContain('_No contracted classes are registered._');

        const markdown = renderDocs([FIXTURE]);

        expect(markdown).toContain('## Order');
        expect(markdown).toContain('### Order.place(sku, quantity)');
        expect(markdown).toContain('a string of length greater than 3');
        expect(markdown).toContain('a number greater than 0');
        expect(markdown).toContain('a number less than or equal to 100');
    });

    it('adds only the loading — its output equals generateMarkdown() over the same registry', () => {
        // The fixture is already loaded (require cache); renderDocs re-projects the populated registry.
        expect(renderDocs([FIXTURE])).toBe(generateMarkdown());
    });
});

describe('schema — load then project', () => {
    it('emits a draft-2020-12 document for the loaded class', () => {
        const json = renderSchema([FIXTURE]);
        const doc = JSON.parse(json);

        expect(doc.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
        expect(Object.keys(doc.$defs)).toContain('Order');
        expect(doc.$defs.Order.methods.place.prefixItems[0]).toMatchObject({
            type: 'string',
            minLength: 3,
        });
    });

    it('adds only the loading — its output equals generateSchema() over the same registry', () => {
        expect(renderSchema([FIXTURE])).toBe(generateSchema());
    });
});

describe('entry loading failures are reported clearly', () => {
    it('wraps a missing entry as a CliError naming the entry', () => {
        try {
            loadEntries([path.resolve(__dirname, 'no-such-entry.ts')]);
            throw new Error('expected a throw');
        } catch (error) {
            expect(error).toBeInstanceOf(CliError);
            expect((error as CliError).message).toMatch(/Failed to load entry/);
            expect((error as CliError).message).toMatch(/no-such-entry\.ts/);
        }
    });
});
