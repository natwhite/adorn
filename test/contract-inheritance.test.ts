/**
 * DEC-022 / Q-15 — an overridden method inherits its parent's parameter preconditions.
 *
 * ## What this file exists to stop coming back
 *
 * Before DEC-022, overriding a contracted method was a **silent way to delete its contract**.
 * `getContracts` is own-scoped, so a subclass prototype held no entry for a method it merely
 * overrode; nothing was collected, nothing was installed, and the override — which shadows the
 * base's wrapper — ran completely unchecked. Declaring a *weaker* constraint replaced the parent's
 * outright for the same reason. Only the un-overridden case stayed guarded, and it stayed guarded by
 * accident: the wrapper on the base prototype is still what a call reaches through the chain.
 *
 * The ruling is the same shape DEC-021 gave fields: effective constraints at a method are the
 * **union** of every declaration on the prototype chain, base-most first. The undecorated case falls
 * out of it — a subclass declaring nothing has an empty own list, so the effective set is its
 * parent's.
 *
 * ## The theoretical tension, recorded rather than hidden
 *
 * Unlike a field constraint (a class invariant, where conjunction is plainly right), a method
 * parameter constraint genuinely **is** a Meyer precondition, and classical DbC permits a subclass to
 * *weaken* one contravariantly by disjunction. This ruling forecloses that deliberately — see
 * DEC-022. What it does **not** do is endorse the old behaviour: no reading of DbC treats "declare
 * nothing" as "check nothing". `icontract` and `decorator-contracts` both implement weakening as an
 * explicit disjunction. Explicit weakening therefore remains an **additive** future feature, not a
 * reversal of this rule.
 */

import {Contract, Validate} from '../src/Adapters/legacy/ContractInstaller';
import {GreaterThanEqual, StringMinLength} from '../src/ParameterDecorators/Constraints';
import {ParameterDecoratorFactory} from '../src/Adapters/legacy/ParameterDecoratorFactory';
import {getContract, getContractsForClass} from '../src/Core/ContractRegistry';
import {resetContractDiagnostics, setContractDiagnosticsSink} from '../src/Adapters/legacy/ContractDiagnostics';

describe('an overridden method inherits its parent constraints (DEC-022)', () => {
    it('checks an override that declares no constraints at all — the headline case', () => {
        @Contract()
        class Base {
            send(@StringMinLength(5) message: string) {
                return `base:${message}`;
            }
        }

        @Contract()
        class Sub extends Base {
            // No decorators whatsoever. Before DEC-022 this accepted 'ab'.
            send(message: string) {
                return `sub:${message}`;
            }
        }

        expect(new Sub().send('long enough')).toBe('sub:long enough');
        expect(() => new Sub().send('ab')).toThrow(/length greater than 5/);
        // The base is untouched and still enforces for itself.
        expect(() => new Base().send('ab')).toThrow(/length greater than 5/);
    });

    it('cannot be weakened by redeclaring a looser constraint', () => {
        @Contract()
        class Base {
            send(@StringMinLength(5) message: string) {
                return message;
            }
        }

        @Contract()
        class Sub extends Base {
            send(@StringMinLength(1) message: string) {
                return message;
            }
        }

        // The looser bound is not rejected — it is simply redundant. Weakening is unexpressible
        // rather than diagnosed, exactly as DEC-021 made it for fields, and for the same reason:
        // relative strength of two arbitrary predicates is undecidable in general.
        expect(() => new Sub().send('ab')).toThrow(/length greater than 5/);
        expect(new Sub().send('long enough')).toBe('long enough');
    });

    it('strengthens: both the inherited and the added constraint fire', () => {
        @Contract()
        class Base {
            run(@GreaterThanEqual(0) n: number) {
                return `base:${n}`;
            }
        }

        @Contract()
        class Sub extends Base {
            run(@GreaterThanEqual(100) n: number) {
                return `sub:${n}`;
            }
        }

        expect(new Sub().run(500)).toBe('sub:500');
        // Fails only the subclass's own addition.
        expect(() => new Sub().run(5)).toThrow(/greater than or equal to 100/);
        // Fails both: the base-most broken constraint is the one reported.
        expect(() => new Sub().run(-1)).toThrow(/greater than or equal to 0/);
    });

    it('reports the base-most broken constraint first', () => {
        @Contract()
        class Base {
            run(@GreaterThanEqual(0) n: number) {
                return n;
            }
        }

        @Contract()
        class Middle extends Base {
            run(@GreaterThanEqual(10) n: number) {
                return n;
            }
        }

        @Contract()
        class Leaf extends Middle {
            run(@GreaterThanEqual(100) n: number) {
                return n;
            }
        }

        expect(() => new Leaf().run(-1)).toThrow(/greater than or equal to 0/);
        expect(() => new Leaf().run(5)).toThrow(/greater than or equal to 10/);
        expect(() => new Leaf().run(50)).toThrow(/greater than or equal to 100/);
        expect(new Leaf().run(100)).toBe(100);
    });

    it('unions three deep through a level that declares nothing', () => {
        @Contract()
        class Base {
            run(@GreaterThanEqual(0) n: number) {
                return n;
            }
        }

        @Contract()
        class Middle extends Base {
            // Declares nothing; must neither clear the base's constraint nor block the leaf's.
            run(n: number) {
                return n;
            }
        }

        @Contract()
        class Leaf extends Middle {
            run(@GreaterThanEqual(100) n: number) {
                return n;
            }
        }

        expect(() => new Middle().run(-1)).toThrow(/greater than or equal to 0/);
        expect(() => new Leaf().run(-1)).toThrow(/greater than or equal to 0/);
        expect(() => new Leaf().run(5)).toThrow(/greater than or equal to 100/);
        expect(new Leaf().run(100)).toBe(100);
    });

    it('applies to static methods, which live on the constructor band', () => {
        @Contract()
        class Base {
            static parse(@GreaterThanEqual(10) n: number) {
                return `base:${n}`;
            }
        }

        @Contract()
        class Sub extends Base {
            static parse(n: number) {
                return `sub:${n}`;
            }
        }

        // `Object.getPrototypeOf(Sub) === Base`, so the constructor band walks the same chain the
        // prototype band does. Checking only the prototype would have left this half unfixed.
        expect(Sub.parse(50)).toBe('sub:50');
        expect(() => Sub.parse(1)).toThrow(/greater than or equal to 10/);
        expect(() => Base.parse(1)).toThrow(/greater than or equal to 10/);
    });

    it('inherits hand-written CreateSimpleDecorator closures too', () => {
        // SMELL-14 closures never reach the registry, so leaving the staging table own-scoped would
        // have left Q-15 alive for exactly the authoring form that is already invisible to every
        // projection — the one where it is hardest to notice.
        const NoBlanks = ParameterDecoratorFactory.CreateSimpleDecorator<string>(params => {
            if (params.value.trim() === '') throw new Error(`${params.signature} must not be blank`);
        });

        @Contract()
        class Base {
            send(@NoBlanks message: string) {
                return `base:${message}`;
            }
        }

        @Contract()
        class Sub extends Base {
            send(message: string) {
                return `sub:${message}`;
            }
        }

        expect(new Sub().send('ok')).toBe('sub:ok');
        expect(() => new Sub().send('   ')).toThrow(/must not be blank/);
    });

    it('works through @Validate() on the override', () => {
        @Contract()
        class Base {
            send(@StringMinLength(5) message: string) {
                return `base:${message}`;
            }
        }

        class Sub extends Base {
            @Validate()
            send(message: string) {
                return `sub:${message}`;
            }
        }

        expect(new Sub().send('long enough')).toBe('sub:long enough');
        expect(() => new Sub().send('ab')).toThrow(/length greater than 5/);
    });

    it('leaves an un-overridden method to the base wrapper rather than double-wrapping it', () => {
        @Contract()
        class Base {
            run(@GreaterThanEqual(0) n: number) {
                return `base:${n}`;
            }
        }

        @Contract()
        class Sub extends Base {}

        // Sub does not own `run`, so the call reaches Base's wrapper through the chain and is
        // already enforced. Installing anyway would check every inherited constraint twice and
        // conjure an own property onto a prototype that had none — changing what
        // `Object.getOwnPropertyNames` reports and re-attributing the violation message from the
        // declaring class to the inheriting one.
        expect(Object.prototype.hasOwnProperty.call(Sub.prototype, 'run')).toBe(false);
        expect(new Sub().run(5)).toBe('base:5');
        expect(() => new Sub().run(-1)).toThrow(/Base\.run/);
    });

    it('does not write to an ancestor: the parent registry entry is untouched', () => {
        @Contract()
        class Base {
            run(@GreaterThanEqual(0) n: number) {
                return n;
            }
        }

        @Contract()
        class Sub extends Base {
            run(@GreaterThanEqual(100) n: number) {
                return n;
            }
        }

        @Contract()
        class Undecorated extends Base {
            run(n: number) {
                return n;
            }
        }

        // Storage stays own-scoped — that is the whole mechanism. A subclass can only add conjuncts
        // to its own list and has no write API that reaches an ancestor, so weakening is
        // unexpressible rather than rejected.
        expect(getContract(Base.prototype, 'run')!.params[0].constraints).toHaveLength(1);
        expect(getContract(Sub.prototype, 'run')!.params[0].constraints).toHaveLength(1);

        // An override declaring nothing conjures **no** own entry. This is what keeps "declares no
        // precondition" distinguishable from "declares an empty one" in the own-scoped read: the
        // installer marks nothing and metadata capture stays own-scoped, so `getContracts` remains
        // the honest answer to "what does this class declare?".
        expect(getContract(Undecorated.prototype, 'run')).toBeUndefined();
    });

    it('is reported by getContractsForClass, so a document is not behind enforcement', () => {
        @Contract()
        class Base {
            run(@GreaterThanEqual(0) n: number) {
                return n;
            }
        }

        @Contract()
        class Sub extends Base {
            run(@GreaterThanEqual(100) n: number) {
                return n;
            }
        }

        const entries = getContractsForClass(Sub);
        expect(entries).toHaveLength(1);
        expect(entries[0].key).toBe('run');
        expect(entries[0].contract.params[0].constraints.map(c => c.params)).toEqual([{min: 0}, {min: 100}]);
    });
});

describe('the subclass that lacks @Contract() (DEC-022, stated limit)', () => {
    beforeEach(() => {
        resetContractDiagnostics();
    });

    afterEach(() => resetContractDiagnostics());

    it('is NOT enforced, because adorn is never invoked for such a class', () => {
        @Contract()
        class Base {
            send(@StringMinLength(5) message: string) {
                return `base:${message}`;
            }
        }

        // Not a policy choice — a mechanical limit. `class Sub extends Base` carrying no adorn
        // decorator at all runs no adorn code at any point in its evaluation, so there is no moment
        // at which a wrapper could be installed and nothing to warn from. The override shadows the
        // base's wrapper and runs unchecked.
        //
        // This is the residue of DEC-014: `@Contract()` is the installer, and forgetting it disables
        // every contract on the class. DEC-022 narrows that hole substantially — an *annotated*
        // subclass can no longer shed a contract by overriding — but it cannot close it, and
        // pretending otherwise in a document would be worse than stating it.
        class Sub extends Base {
            send(message: string) {
                return `sub:${message}`;
            }
        }

        expect(new Sub().send('ab')).toBe('sub:ab');
    });

    it('warns truthfully when the subclass decorates the override but forgets @Contract()', () => {
        const warnings: string[] = [];
        setContractDiagnosticsSink(message => warnings.push(message));

        @Contract()
        class Base {
            send(@StringMinLength(5) message: string) {
                return message;
            }
        }
        void Base;

        // Here adorn *is* invoked — the parameter decorator runs — so the pending set knows about
        // the class and the existing diagnostic fires. Its claim that the constraints "will never
        // run" remains true: nothing installed a wrapper on Sub.
        class Sub extends Base {
            send(@StringMinLength(10) message: string) {
                return message;
            }
        }

        return Promise.resolve().then(() => {
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain('Contracts on Sub are NOT being enforced');
            expect(warnings[0]).toContain('send');
            expect(new Sub().send('ab')).toBe('ab');
        });
    });
});
