/**
 * The `docs` and `schema` command bodies: load the entries so the registry fills, then run the
 * projection over it.
 *
 * The projections are imported **directly** from `../Projections/*`, never through the library's
 * `index.ts` barrel. Two reasons: `index.ts` is being rewired concurrently and a CLI must not depend
 * on that churn; and the CLI is a separate entry point, not part of the runtime export surface, so it
 * should reach the projection functions at their source rather than through the public re-export.
 *
 * Each renderer is `load-then-project` and nothing more — the two lines are the whole of the DEC-007
 * shape. They return the artifact as a string; writing it to a file or stdout is the dispatcher's job,
 * which keeps these pure enough to assert against directly (a test can compare `renderDocs(entry)` to
 * `generateMarkdown()` run over the same freshly-loaded registry).
 */

import {generateMarkdown} from '../Projections/docs';
import {generateSchema} from '../Projections/schema';
import {loadEntries} from './load';

/**
 * Load `entries`, then render the markdown documentation projection over the resulting registry.
 * Equivalent to `generateMarkdown()` once the entries are imported — the CLI adds only the loading.
 */
export function renderDocs(entries: string[]): string {
    loadEntries(entries);
    return generateMarkdown();
}

/**
 * Load `entries`, then render the JSON Schema projection (draft 2020-12) over the resulting registry.
 * Equivalent to `generateSchema()` once the entries are imported.
 */
export function renderSchema(entries: string[]): string {
    loadEntries(entries);
    return generateSchema();
}
