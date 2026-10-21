/**
 * One declaration, many artifacts — the projections.
 *
 * The SAME contracted class the runtime enforces is projected into Markdown documentation, a
 * descriptive JSON Schema (draft 2020-12), and a privacy/telemetry report — each read from the one
 * registry, so none can drift from what actually runs.
 *
 *   Run:  npx ts-node examples/06-projections.ts
 *
 * (`generate*` render every contract registered in the process; this file registers just the one
 *  class below, so that is all you see. There are per-class forms too: `documentClass`,
 *  `schemaForClass`, `telemetryForClass`.)
 */
import {Contract, Tool, Describe, NotEmpty, Between, Sensitive} from '../index';
import {generateMarkdown, generateSchema} from '../schema'; // in your own project: `from 'adorn/schema'`
import {generateTelemetryReport} from '../privacy'; // `from 'adorn/privacy'`

@Contract()
class UserService {
    @Tool('Create a user account.')
    createUser(
        @Describe('the display name') @NotEmpty() name: string,
        @Describe('age in years') @Between(13, 120) age: number,
        @Sensitive() @NotEmpty() password: string,
    ): string {
        return `created ${name} (${age})`;
    }
}
void UserService;

console.log('========== Markdown documentation ==========\n');
console.log(generateMarkdown());

console.log('\n========== JSON Schema (draft 2020-12) ==========\n');
console.log(generateSchema());

console.log('\n========== Privacy / telemetry report ==========\n');
console.log(generateTelemetryReport());
