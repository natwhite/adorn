/**
 * Pre- and postconditions on decorated methods.
 *
 *   @Requires — a cross-parameter PRECONDITION, checked before the body (blames the caller).
 *   @Ensures  — a closure POSTCONDITION on the result (blames the callee).
 *   @Returns  — a reified postcondition: the return value is checked by a descriptor AND projected
 *               into docs/schema, exactly like a parameter constraint.
 *
 *   Run:  npx ts-node examples/05-pre-post-conditions.ts
 */
import {Contract, Requires, Ensures, Returns, GreaterThanEqual, NumberContracts} from '../index';

@Contract()
class Bank {
    @Requires((amount: number, balance: number) => amount <= balance, 'cannot overdraw the balance')
    @Returns(NumberContracts.GreaterThanEqual(0)) // the resulting balance must never be negative
    // @Ensures types `result` as `unknown` (a closure carries no return type), so annotate + narrow:
    @Ensures((result: unknown, amount: number, balance: number) => (result as number) === balance - amount, 'balance decreases by exactly the amount')
    withdraw(@GreaterThanEqual(1) amount: number, @GreaterThanEqual(0) balance: number): number {
        return balance - amount;
    }

    // A deliberately BUGGY method, to show @Returns catching a bad OUTPUT (not a bad input):
    @Returns(NumberContracts.GreaterThanEqual(0))
    buggyRefund(@GreaterThanEqual(0) cents: number): number {
        return cents - 1000; // oops — can go negative
    }
}

const bank = new Bank();

console.log('=== a valid withdrawal ===');
console.log('new balance:', bank.withdraw(30, 100));

console.log('\n=== precondition fails: withdraw more than the balance ===');
try {
    bank.withdraw(150, 100);
} catch (e) {
    console.log('rejected:', (e as Error).message);
}

console.log('\n=== parameter constraint fails: a zero amount (@GreaterThanEqual(1)) ===');
try {
    bank.withdraw(0, 100);
} catch (e) {
    console.log('rejected:', (e as Error).message);
}

console.log('\n=== @Returns catches a bad RETURN value (the method has a bug) ===');
try {
    bank.buggyRefund(500); // returns 500 - 1000 = -500, which @Returns rejects
} catch (e) {
    console.log('rejected:', (e as Error).message);
}
