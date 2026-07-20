/**
 * adorn — manual demonstration script (`npm run demo`).
 *
 * This is NOT a test. Assertions live in `test/**` and `src/**\/*.test.ts` and run under Jest
 * (`npm test`). This file exists to be *read* and *run by a human*: it shows what a decorated
 * class looks like and lets you see enforcement fire against real output.
 *
 * Relocated from `src/Tests.ts` (plan P0.4 / GAP-6). It lived under `src/` for historical
 * reasons, which meant `tsc` compiled it into `dist/src/Tests.js` and the published package
 * shipped a demo script. `examples/` is excluded from the build, so it no longer does.
 *
 * What it demonstrates, in order:
 *   1. `@Contract()` installs enforcement — the parameter constraints below are inert without it.
 *   2. A *passing* call, satisfying every constraint.
 *   3. A *violating* call, so you can see the thrown contract error and its message.
 *
 * Note the rxjs import: `@Log` pulls rxjs in, which is why rxjs remains a devDependency here
 * even though it is now an optional peer for consumers (P0.2).
 */
import { from } from 'rxjs';
import {Positive, StringMinLength, GreaterThanEqual, LessThanEqual} from '../src/ParameterDecorators/Constraints';
import { Log, Memoize } from '../src/MethodDecorators/promise/Memoize';
import { Contract } from '../src/Core/ContractInstaller';

// P1.3 (BREAKING): parameter decorators now only RECORD their constraints; `@Contract()` is what
// installs the enforcing wrapper. Without it the constraints below are silently inert — running
// this demo would print a development-mode warning naming this class and nothing would be checked.
@Contract()
class Task {
    private testing: string = ' yolo';
    // @timeIt()
    static promise = async () => new Promise<string>(resolve => setTimeout(() => resolve('after'), 1000));

    // We imagine that by invoking decorators that there will be no other side effects other that those explicitly desired.
    // For this reason, decorators should be decorated using Functional Programming paradigms
    // @Memoize()
    test(@StringMinLength(10) message: string, @GreaterThanEqual(100) @LessThanEqual(1000) someNumber: number) {
        console.log(message + this.testing);
        // await new Promise<void>(resolve => setTimeout(() => resolve(console.log('inbetween')), 1000));
        console.log(someNumber);
        // return Task.promise();
    }

    @Log()
    test2(str = "string", num = 7) {
        return "input is " + str + " and number is " + num + "";
    }

    // @Memoize()
    async test3(waitTime: number = 1000) {
        const prom = new Promise<string>(resolve => setTimeout(() => resolve('after'), waitTime));
        return from(prom);
    }
}

const task = new Task();

(async () => {
    // --- 1. A call that satisfies every constraint -------------------------
    // 'addsodifhisfl1' is 14 chars (>= 10); 101 is within [100, 1000].
    console.log('--- valid call (should pass) ---');
    const value = await task.test('addsodifhisfl1', 101);
    console.log(value);

    const value3 = task.test2("SomeInput", 12);
    console.log(value3);

    // --- 2. A call that violates a constraint ------------------------------
    // Without this the demo installs enforcement but never shows it firing.
    // 'short' is 5 chars, below the @StringMinLength(10) floor.
    console.log('--- invalid call (should throw) ---');
    try {
        await task.test('short', 101);
        console.error('NO VIOLATION RAISED — enforcement is not installed!');
        process.exitCode = 1;
    } catch (e) {
        console.log('caught as expected:', (e as Error).message);
    }
})();


