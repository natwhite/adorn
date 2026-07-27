/**
 * A decorated fixture for the CLI's load-then-project tests.
 *
 * It imports adorn's decorators from **source** (`../../src/...`) rather than from `dist`, so that when
 * ts-jest loads it inside a jest run its `@Contract()` writes to the very same `ContractRegistry`
 * singleton the projection under test reads. That shared instance is the whole point — it is the
 * in-repo stand-in for a real consumer whose entry imports the published `adorn` while the CLI reads
 * the same published build (the module-identity requirement `src/cli/load.ts` documents).
 *
 * This is not a test file (no `.test.ts` suffix), so jest never executes it as a suite; it is required
 * on demand by the CLI's loader, exactly as a user entry module would be.
 */

import {Contract} from '../../src/Adapters/legacy/ContractInstaller';
import {StringMinLength, GreaterThan, LessThanEqual} from '../../src/ParameterDecorators/Constraints';

@Contract()
export class Order {
    place(@StringMinLength(3) sku: string, @GreaterThan(0) @LessThanEqual(100) quantity: number): void {
        void sku;
        void quantity;
    }
}
