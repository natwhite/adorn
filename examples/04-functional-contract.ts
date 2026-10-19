/**
 * `contract()` — enforcement without a class or a decoration point.
 *
 * The functional twin of `@Contract` / `@Requires` / `@Ensures` / `@Returns`. Wrap a plain function
 * with per-parameter descriptors, cross-parameter preconditions, and postconditions — for a codebase
 * with zero classes. It runs the SAME oracles the decorator path runs, so the two can't disagree.
 *
 *   Run:  npx ts-node examples/04-functional-contract.ts
 */
import {contract, NumberContracts, StringContracts, ObjectContracts, ArrayContracts} from '../index';

interface Move {
    readonly from: string;
    readonly to: string;
}

const reschedule = contract(
    {
        // Positional descriptors; `null` is a hole (an argument with nothing to constrain).
        params: [
            null,
            ObjectContracts.Fields({
                moves: ArrayContracts.ArrayOf(
                    ObjectContracts.Fields({
                        from: StringContracts.NotEmpty(),
                        to: StringContracts.NotEmpty(),
                    }),
                ),
            }),
        ],
        // Cross-parameter precondition (caller-blamed, runs before the body):
        requires: [(_store: unknown, args: {moves: Move[]}) => args.moves.length > 0],
        // Postcondition on the result (callee-blamed, runs after):
        ensures: [(result: {applied: number}) => result.applied >= 0],
        // Reified return descriptor:
        returns: ObjectContracts.Fields({applied: NumberContracts.GreaterThanEqual(0)}),
    },
    (_store: unknown, args: {moves: Move[]}): {applied: number} => {
        return {applied: args.moves.length};
    },
);

console.log('=== a valid call ===');
console.log(reschedule({}, {moves: [{from: 'a', to: 'b'}]})); // { applied: 1 }

console.log('\n=== precondition fails (empty moves) — body never runs ===');
try {
    reschedule({}, {moves: []});
} catch (e) {
    console.log('rejected:', (e as Error).message);
}

console.log('\n=== a bad argument (a move missing `to`) ===');
try {
    reschedule({}, {moves: [{from: 'a'} as Move]});
} catch (e) {
    console.log('rejected:', (e as Error).message);
}

// contract() is async-aware: the return/postcondition band runs on the SETTLED value.
const fetchScore = contract(
    {returns: NumberContracts.Between(0, 100)},
    async (seed: number): Promise<number> => seed, // a "score" that must be 0..100
);

(async () => {
    console.log('\n=== async: a valid settled return ===');
    console.log('score:', await fetchScore(87));

    console.log('\n=== async: the settled value violates the return contract ===');
    try {
        await fetchScore(999);
    } catch (e) {
        console.log('rejected:', (e as Error).message);
    }
})();
