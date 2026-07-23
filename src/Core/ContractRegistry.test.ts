import {
    getContract,
    getContractedClasses,
    getContracts,
    getContractsForClass,
    getEffectiveContract,
    getEffectiveContractKeys,
    getEffectiveFieldConstraints,
    getEffectiveParameterConstraints,
    getEffectivePostconditionKeys,
    getEffectivePostconditions,
    getFieldContract,
    getFieldContracts,
    getFieldContractsForClass,
    getPostconditionKeys,
    getPostconditions,
    isClassEnumerationEnabled,
    markFieldInstalled,
    markInstalled,
    Postcondition,
    recordFieldConstraint,
    recordParameterConstraint,
    recordPostcondition,
    registerContractedClass,
    resetRegistry,
    setClassEnumerationEnabled,
    setFieldMetadata,
    setParameterMetadata,
} from './ContractRegistry';
import {ConstraintDescriptor, defineConstraint, JsonObject} from './Descriptor';

interface MinParams extends JsonObject {
    min: number;
}

const min = defineConstraint<MinParams>({
    kind: 'number',
    constraint: 'test:registry:min',
    derive: params => value => (value as number) >= params.min,
    describe: params => `a number greater than or equal to ${params.min}`,
});

const maxLength = defineConstraint<JsonObject>({
    kind: 'string',
    constraint: 'test:registry:maxLength',
    derive: params => value => String(value).length <= (params.maxLength as number),
    describe: params => `a string of at most ${params.maxLength} characters`,
});

beforeEach(resetRegistry);

describe('recording and lookup', () => {
    it('returns an empty map for a target with no contracts', () => {
        expect(getContracts({}).size).toBe(0);
        expect(getContract({}, 'anything')).toBeUndefined();
    });

    it('records a constraint against a parameter position', () => {
        const target = {};
        const constraint = min({min: 0});

        recordParameterConstraint(target, 'send', 0, constraint);
        const contract = getContract(target, 'send');

        expect(contract).toBeDefined();
        expect(contract!.params).toHaveLength(1);
        expect(contract!.params[0].index).toBe(0);
        expect(contract!.params[0].constraints).toEqual([constraint]);
        expect(contract!.installed).toBe(false);
        expect(contract!.pre).toEqual([]);
        expect(contract!.post).toEqual([]);
    });

    it('accumulates several constraints on one parameter', () => {
        const target = {};
        const lower = min({min: 0});
        const upper = min({min: 5});

        recordParameterConstraint(target, 'send', 1, lower);
        recordParameterConstraint(target, 'send', 1, upper);

        expect(getContract(target, 'send')!.params[0].constraints).toEqual([lower, upper]);
    });

    it('keeps parameters ordered by index regardless of decoration order', () => {
        const target = {};

        // Parameter decorators are evaluated right-to-left, so out-of-order arrival is the norm.
        recordParameterConstraint(target, 'send', 2, min({min: 0}));
        recordParameterConstraint(target, 'send', 0, min({min: 1}));
        recordParameterConstraint(target, 'send', 1, min({min: 2}));

        expect(getContract(target, 'send')!.params.map(entry => entry.index)).toEqual([0, 1, 2]);
    });

    it('keeps methods and targets separate', () => {
        const target = {};
        const other = {};

        recordParameterConstraint(target, 'send', 0, min({min: 0}));
        recordParameterConstraint(target, 'receive', 0, min({min: 1}));
        recordParameterConstraint(other, 'send', 0, min({min: 2}));

        expect(getContracts(target).size).toBe(2);
        expect(getContracts(other).size).toBe(1);
        expect(getContract(other, 'send')!.params[0].constraints[0].params).toEqual({min: 2});
    });

    it('supports symbol method keys', () => {
        const target = {};
        const key = Symbol('send');

        recordParameterConstraint(target, key, 0, min({min: 0}));

        expect(getContract(target, key)).toBeDefined();
    });

    it('rejects a bare predicate in place of a descriptor', () => {
        expect(() => recordParameterConstraint({}, 'send', 0, ((v: number) => v > 0) as any)).toThrow(
            /ConstraintDescriptor/,
        );
    });

    it('rejects a non-integer parameter index', () => {
        expect(() => recordParameterConstraint({}, 'send', -1, min({min: 0}))).toThrow(/index/);
        expect(() => recordParameterConstraint({}, 'send', 1.5, min({min: 0}))).toThrow(/index/);
    });

    it('rejects a non-object target', () => {
        expect(() => recordParameterConstraint(null as any, 'send', 0, min({min: 0}))).toThrow(
            /target must be an object/,
        );
    });
});

describe('descriptors survive round-trip retrieval', () => {
    it('returns the descriptor with its params, predicate, and message intact', () => {
        const target = {};
        recordParameterConstraint(target, 'send', 0, min({min: 10}));

        const retrieved: ConstraintDescriptor = getContract(target, 'send')!.params[0].constraints[0];

        expect(retrieved.constraint).toBe('test:registry:min');
        expect(retrieved.params).toEqual({min: 10});
        expect(retrieved.predicate(10)).toBe(true);
        expect(retrieved.predicate(9)).toBe(false);
        // No `disclose` passed, so the received value redacts by default (BUG-19 / DEC-PII-1).
        expect(retrieved.message({value: 9, paramName: 'count'})).toBe(
            'Value Error: count expected a number greater than or equal to 10 but received [REDACTED] instead',
        );
    });

    it('stores constraints of different kinds side by side', () => {
        const target = {};
        recordParameterConstraint(target, 'send', 0, maxLength({maxLength: 3}));
        recordParameterConstraint(target, 'send', 1, min({min: 1}));

        const contract = getContract(target, 'send')!;
        expect(contract.params[0].constraints[0].kind).toBe('string');
        expect(contract.params[1].constraints[0].kind).toBe('number');
    });
});

describe('own-property scoping', () => {
    it("does not let a subclass see — or corrupt — its parent's contract", () => {
        class Base {
            send(_value: number) {
                /* no-op */
            }
        }

        class Sub extends Base {}

        recordParameterConstraint(Base.prototype, 'send', 0, min({min: 0}));

        // The subclass prototype is a distinct key, so it starts empty even though `send` is
        // reachable through it. This is the fix for the inheritance bug in the current factory,
        // which reads `target[propertyKey]` and walks the prototype chain into the parent.
        //
        // **Storage stays own-scoped under DEC-022 too** — that is what makes weakening
        // unexpressible, since a descendant has no route to an ancestor's array. Inheritance is a
        // property of the *read*, which is why these assertions are unchanged by that ruling.
        expect(getContracts(Sub.prototype).size).toBe(0);
        expect(getContract(Sub.prototype, 'send')).toBeUndefined();
        // ...but the effective read already sees the parent's, before Sub declares anything at all.
        expect(getEffectiveParameterConstraints(Sub.prototype, 'send', 0)).toHaveLength(1);

        recordParameterConstraint(Sub.prototype, 'send', 0, min({min: 100}));

        expect(getContract(Base.prototype, 'send')!.params[0].constraints).toHaveLength(1);
        expect(getContract(Base.prototype, 'send')!.params[0].constraints[0].params).toEqual({min: 0});
        expect(getContract(Sub.prototype, 'send')!.params[0].constraints[0].params).toEqual({min: 100});

        // The union is base-most first, and the parent's entry is untouched by the child's.
        const effective = getEffectiveParameterConstraints(Sub.prototype, 'send', 0);
        expect(effective.map(c => c.params)).toEqual([{min: 0}, {min: 100}]);
        expect(getEffectiveParameterConstraints(Base.prototype, 'send', 0)).toHaveLength(1);
    });
});

describe('effective (inheritance-aware) method reads — DEC-022 / Q-15', () => {
    /**
     * The registry half of the ruling. These are deliberately plain objects and `Object.create`
     * chains wherever the class-ness is not the point, because the union is a property of the
     * *registry's* prototype walk, not of `class` syntax — the same thing DEC-021's field tests
     * prove with a plain-object chain.
     */

    it('unions every declaration on the chain, base-most first', () => {
        const base = {};
        const middle = Object.create(base) as object;
        const leaf = Object.create(middle) as object;

        recordParameterConstraint(base, 'send', 0, min({min: 0}));
        recordParameterConstraint(middle, 'send', 0, min({min: 10}));
        recordParameterConstraint(leaf, 'send', 0, min({min: 100}));

        expect(getEffectiveParameterConstraints(leaf, 'send', 0).map(c => c.params)).toEqual([
            {min: 0},
            {min: 10},
            {min: 100},
        ]);
        // Each level sees only itself and its ancestors — the walk goes up, never down.
        expect(getEffectiveParameterConstraints(middle, 'send', 0).map(c => c.params)).toEqual([
            {min: 0},
            {min: 10},
        ]);
        expect(getEffectiveParameterConstraints(base, 'send', 0).map(c => c.params)).toEqual([{min: 0}]);
    });

    it('treats "declares nothing" and "declares an empty list" identically — neither displaces a parent', () => {
        // The crux of the undecorated-override case. A level that records *no* entry and a level
        // that records an entry carrying no constraints are the same statement about preconditions,
        // and neither may clear an ancestor's. Keying the union on "has constraints" rather than on
        // "has a registry entry" is what makes a phantom entry — one conjured by metadata capture
        // for an undecorated position — unable to masquerade as an empty precondition.
        const base = {};
        const declaresNothing = Object.create(base) as object;
        const declaresEmpty = Object.create(base) as object;

        recordParameterConstraint(base, 'send', 0, min({min: 5}));

        // `setParameterMetadata` creates a registry entry with an empty constraint list.
        setParameterMetadata(declaresEmpty, 'send', 0, {name: 'value'});
        expect(getContract(declaresEmpty, 'send')).toBeDefined();
        expect(getContract(declaresEmpty, 'send')!.params[0].constraints).toHaveLength(0);
        expect(getContract(declaresNothing, 'send')).toBeUndefined();

        // Both inherit the parent's constraint, unchanged.
        expect(getEffectiveParameterConstraints(declaresNothing, 'send', 0).map(c => c.params)).toEqual([
            {min: 5},
        ]);
        expect(getEffectiveParameterConstraints(declaresEmpty, 'send', 0).map(c => c.params)).toEqual([
            {min: 5},
        ]);
    });

    it('resolves each parameter position independently', () => {
        const base = {};
        const sub = Object.create(base) as object;

        recordParameterConstraint(base, 'send', 0, min({min: 0}));
        recordParameterConstraint(base, 'send', 1, min({min: 1}));
        recordParameterConstraint(sub, 'send', 1, min({min: 50}));

        const contract = getEffectiveContract(sub, 'send')!;
        expect(contract.params.map(p => p.index)).toEqual([0, 1]);
        expect(contract.params[0].constraints.map(c => c.params)).toEqual([{min: 0}]);
        expect(contract.params[1].constraints.map(c => c.params)).toEqual([{min: 1}, {min: 50}]);
    });

    it('takes name, type and installed from the nearest declaration', () => {
        const base = {};
        const sub = Object.create(base) as object;

        recordParameterConstraint(base, 'send', 0, min({min: 0}));
        setParameterMetadata(base, 'send', 0, {name: 'baseName', type: Number});
        markInstalled(base, 'send');

        recordParameterConstraint(sub, 'send', 0, min({min: 5}));
        setParameterMetadata(sub, 'send', 0, {name: 'subName'});

        const contract = getEffectiveContract(sub, 'send')!;
        expect(contract.params[0].name).toBe('subName');
        // `type` falls through independently — Sub supplied a name but no reflected type.
        expect(contract.params[0].type).toBe(Number);
        // The subclass's own accessor is the one a call reaches, and it is not installed yet.
        expect(contract.installed).toBe(false);
    });

    it('returns the stored contract itself when there is no contracted ancestor', () => {
        const target = {};
        recordParameterConstraint(target, 'send', 0, min({min: 0}));

        // Not merely equal — the same object, so the common case allocates nothing.
        expect(getEffectiveContract(target, 'send')).toBe(getContract(target, 'send'));
    });

    it('returns undefined / empty when nothing on the chain declares the method', () => {
        const base = {};
        const sub = Object.create(base) as object;

        expect(getEffectiveContract(sub, 'send')).toBeUndefined();
        expect(getEffectiveParameterConstraints(sub, 'send', 0)).toEqual([]);
        expect(getEffectiveContractKeys(sub)).toEqual([]);
    });

    it('collects chain keys own-most first, deduplicated', () => {
        const base = {};
        const sub = Object.create(base) as object;

        recordParameterConstraint(base, 'shared', 0, min({min: 0}));
        recordParameterConstraint(base, 'baseOnly', 0, min({min: 0}));
        recordParameterConstraint(sub, 'shared', 0, min({min: 1}));
        recordParameterConstraint(sub, 'subOnly', 0, min({min: 1}));

        const keys = getEffectiveContractKeys(sub);
        expect(keys).toEqual(['shared', 'subOnly', 'baseOnly']);
        // A redeclared method appears once — two declarations are one contract once resolved.
        expect(keys.filter(k => k === 'shared')).toHaveLength(1);
    });

    it('does not leak across the method and field bands on a shared key', () => {
        const base = {};
        const sub = Object.create(base) as object;

        recordParameterConstraint(base, 'value', 0, min({min: 0}));
        recordFieldConstraint(base, 'value', min({min: 99}));

        expect(getEffectiveParameterConstraints(sub, 'value', 0).map(c => c.params)).toEqual([{min: 0}]);
        expect(getEffectiveFieldConstraints(sub, 'value').map(c => c.params)).toEqual([{min: 99}]);
    });
});

describe('parameter metadata', () => {
    it('attaches a name and reflected type independently of constraints', () => {
        const target = {};

        setParameterMetadata(target, 'send', 0, {name: 'count', type: Number});

        const parameter = getContract(target, 'send')!.params[0];
        expect(parameter.name).toBe('count');
        expect(parameter.type).toBe(Number);
        expect(parameter.constraints).toEqual([]);
    });

    it('merges with constraints recorded for the same position', () => {
        const target = {};

        recordParameterConstraint(target, 'send', 0, min({min: 0}));
        setParameterMetadata(target, 'send', 0, {name: 'count'});

        const contract = getContract(target, 'send')!;
        expect(contract.params).toHaveLength(1);
        expect(contract.params[0].name).toBe('count');
        expect(contract.params[0].constraints).toHaveLength(1);
    });
});

describe('installation flag', () => {
    it('starts false and flips on markInstalled', () => {
        const target = {};
        recordParameterConstraint(target, 'send', 0, min({min: 0}));

        expect(getContract(target, 'send')!.installed).toBe(false);

        markInstalled(target, 'send');

        expect(getContract(target, 'send')!.installed).toBe(true);
    });

    it('makes the "contracts recorded but never installed" case detectable', () => {
        // This is what P1.3's missing-@Contract() dev warning keys off. Without it, forgetting the
        // annotation is a silent no-op — and silently absent from generated artifacts too.
        const target = {};
        recordParameterConstraint(target, 'send', 0, min({min: 0}));

        const uninstalled: string[] = [];
        getContracts(target).forEach((contract, key) => {
            if (!contract.installed) uninstalled.push(String(key));
        });

        expect(uninstalled).toEqual(['send']);
    });
});

describe('enumeration (DEC-011)', () => {
    it('is empty until a class is explicitly registered', () => {
        class Task {}

        recordParameterConstraint(Task.prototype, 'send', 0, min({min: 0}));

        // Recording constraints is not enough: enumeration reports the classes an installer
        // annotated, which is exactly the set whose contracts are actually enforced.
        expect(getContractedClasses()).toEqual([]);

        registerContractedClass(Task);

        expect(getContractedClasses()).toEqual([Task]);
    });

    it('answers the question a WeakMap cannot: which classes have contracts', () => {
        class First {}

        class Second {}

        registerContractedClass(First);
        registerContractedClass(Second);

        const constrained = getContractedClasses().map(entry => ({
            name: entry.name,
            methods: Array.from(getContracts(entry.prototype).keys()),
        }));

        expect(constrained).toEqual([
            {name: 'First', methods: []},
            {name: 'Second', methods: []},
        ]);
    });

    it('deduplicates repeat registrations', () => {
        class Task {}

        registerContractedClass(Task);
        registerContractedClass(Task);

        expect(getContractedClasses()).toHaveLength(1);
    });

    it('returns a snapshot that callers cannot use to mutate the registry', () => {
        class Task {}

        registerContractedClass(Task);

        const snapshot = getContractedClasses();
        snapshot.push(function Injected() {
            /* no-op */
        });

        expect(getContractedClasses()).toHaveLength(1);
    });

    it('rejects a non-constructor', () => {
        expect(() => registerContractedClass({} as any)).toThrow(/constructor/);
    });

    it('can be opted out of, which drops the strong references it holds', () => {
        class Task {}

        registerContractedClass(Task);
        expect(getContractedClasses()).toHaveLength(1);

        setClassEnumerationEnabled(false);

        expect(isClassEnumerationEnabled()).toBe(false);
        expect(getContractedClasses()).toEqual([]);

        registerContractedClass(Task);
        expect(getContractedClasses()).toEqual([]);
    });

    it('still supports per-target lookup while enumeration is disabled', () => {
        class Task {}

        setClassEnumerationEnabled(false);
        recordParameterConstraint(Task.prototype, 'send', 0, min({min: 0}));

        expect(getContract(Task.prototype, 'send')).toBeDefined();
    });
});

describe('constraint position within a parameter (SMELL-13)', () => {
    it('appends by default', () => {
        const target = {};
        const first = min({min: 1});
        const second = min({min: 2});

        recordParameterConstraint(target, 'send', 0, first);
        recordParameterConstraint(target, 'send', 0, second);

        expect(getContract(target, 'send')!.params[0].constraints).toEqual([first, second]);
    });

    it('prepends on request, so an adapter receiving decorators bottom-up records source order', () => {
        const target = {};
        const declaredFirst = min({min: 1});
        const declaredSecond = min({min: 2});

        // `__decorate` applies its array back-to-front, so the SECOND-declared
        // decorator arrives first. Prepending each one restores declaration order
        // in the store itself, rather than leaving the registry reversed and
        // compensating at enforcement time.
        recordParameterConstraint(target, 'send', 0, declaredSecond, 'prepend');
        recordParameterConstraint(target, 'send', 0, declaredFirst, 'prepend');

        expect(getContract(target, 'send')!.params[0].constraints).toEqual([declaredFirst, declaredSecond]);
    });

    it('rejects an unknown position', () => {
        expect(() => recordParameterConstraint({}, 'send', 0, min({min: 0}), 'sideways' as any)).toThrow(
            /position must be/,
        );
    });
});

describe('getContractsForClass — both key bands (Q-9)', () => {
    it('returns instance and static contracts together, each tagged', () => {
        class Task {
            send(_message: string) {
                /* no-op */
            }

            static parse(_input: string) {
                /* no-op */
            }
        }

        recordParameterConstraint(Task.prototype, 'send', 0, min({min: 0}));
        recordParameterConstraint(Task, 'parse', 0, min({min: 1}));

        const entries = getContractsForClass(Task);

        expect(entries.map(entry => ({key: entry.key, isStatic: entry.isStatic}))).toEqual([
            {key: 'send', isStatic: false},
            {key: 'parse', isStatic: true},
        ]);
        expect(entries[0].target).toBe(Task.prototype);
        expect(entries[1].target).toBe(Task);
    });

    it('finds statics even when the class has no instance contracts at all', () => {
        // This is the case a projection walking only `constructor.prototype`
        // silently drops — producing an artifact that looks complete and is
        // missing every static method, with nothing thrown to reveal it.
        class StaticsOnly {
            static parse(_input: string) {
                /* no-op */
            }
        }

        recordParameterConstraint(StaticsOnly, 'parse', 0, min({min: 0}));

        const entries = getContractsForClass(StaticsOnly);
        expect(entries).toHaveLength(1);
        expect(entries[0].isStatic).toBe(true);
        expect(entries[0].contract.params[0].constraints).toHaveLength(1);
    });

    it('returns an empty array for a class with nothing recorded', () => {
        class Bare {}

        expect(getContractsForClass(Bare)).toEqual([]);
    });

    it('lists an inherited method contract a subclass never redeclares (DEC-022)', () => {
        // This test asserted `getContractsForClass(Sub)` was `[]` — that it was "own-scoped,
        // exactly as the per-target reads are" — until DEC-022 settled Q-15. It is **inverted
        // deliberately**, not adjusted, and the reason is the one DEC-016 gives and BUG-16 was:
        // `new Sub().run(-1)` throws, so a document that omits `run` from `Sub` is behind what is
        // actually enforced — enforced-but-undocumented, which never surfaces on its own because
        // nothing ever throws to reveal it. The per-target reads *are* still own-scoped (see the
        // 'own-property scoping' block); it is this class-level projection read that resolves the
        // chain, exactly as `getFieldContractsForClass` has since DEC-021.
        class Base {
            run(_n: number) {
                /* no-op */
            }
        }

        class Sub extends Base {}

        recordParameterConstraint(Base.prototype, 'run', 0, min({min: 0}));

        expect(getContractsForClass(Base)).toHaveLength(1);

        const inherited = getContractsForClass(Sub);
        expect(inherited).toHaveLength(1);
        expect(inherited[0].key).toBe('run');
        expect(inherited[0].isStatic).toBe(false);
        // Reported against the class asked about, not the one that declared it.
        expect(inherited[0].target).toBe(Sub.prototype);
        expect(inherited[0].contract.params[0].constraints[0].params).toEqual({min: 0});
    });

    it('carries the same MethodContract the per-target read returns', () => {
        class Task {
            run(_n: number) {
                /* no-op */
            }
        }

        recordParameterConstraint(Task.prototype, 'run', 0, min({min: 0}));
        markInstalled(Task.prototype, 'run');

        const entry = getContractsForClass(Task)[0];
        expect(entry.contract).toBe(getContract(Task.prototype, 'run'));
        expect(entry.contract.installed).toBe(true);
    });

    it('rejects a non-constructor', () => {
        expect(() => getContractsForClass({} as any)).toThrow(/constructor/);
    });
});

describe('the field band (GAP-9)', () => {
    it('records a field constraint as data', () => {
        const target = {};
        const constraint = min({min: 0});

        recordFieldConstraint(target, 'count', constraint);
        const contract = getFieldContract(target, 'count')!;

        expect(contract.constraints).toEqual([constraint]);
        expect(contract.installed).toBe(false);
        expect(contract.type).toBeUndefined();
    });

    it('refuses a bare closure, exactly as the parameter band does', () => {
        // The whole reason the band exists is so field contracts are *projectable*. Accepting a
        // closure here would reintroduce SMELL-14 on a band that has never had it (DEC-006).
        expect(() => recordFieldConstraint({}, 'count', (() => true) as any)).toThrow(/ConstraintDescriptor/);
    });

    it('honours prepend, so an adapter can normalise __decorate ordering as it writes', () => {
        const target = {};
        const lower = min({min: 0});
        const upper = maxLength({maxLength: 10});

        // Decorators arrive bottom-up; prepending each lands them in declaration order (DEC-017).
        recordFieldConstraint(target, 'count', upper, 'prepend');
        recordFieldConstraint(target, 'count', lower, 'prepend');

        expect(getFieldContract(target, 'count')!.constraints).toEqual([lower, upper]);
    });

    it('rejects an unknown position', () => {
        expect(() => recordFieldConstraint({}, 'count', min({min: 0}), 'sideways' as any)).toThrow(
            /position must be/,
        );
    });

    it('keeps metadata and the installed flag independent of the constraints', () => {
        const target = {};
        recordFieldConstraint(target, 'count', min({min: 0}));

        setFieldMetadata(target, 'count', {type: Number});
        markFieldInstalled(target, 'count');

        const contract = getFieldContract(target, 'count')!;
        expect(contract.type).toBe(Number);
        expect(contract.installed).toBe(true);
        expect(contract.constraints).toHaveLength(1);
    });

    it('leaves a stored type alone when handed undefined', () => {
        // Honest degradation: a toolchain that emits no `design:type` must not erase one that a
        // different route already supplied.
        const target = {};
        setFieldMetadata(target, 'count', {type: Number});
        setFieldMetadata(target, 'count', {type: undefined});

        expect(getFieldContract(target, 'count')!.type).toBe(Number);
    });

    it('is own-scoped and does not collide with the method band', () => {
        const base = {};
        const derived = Object.create(base);

        recordFieldConstraint(base, 'count', min({min: 0}));
        recordParameterConstraint(base, 'count', 0, min({min: 5}));

        expect(getFieldContract(base, 'count')!.constraints[0].params).toEqual({min: 0});
        // A method and a field may share a name; the bands must not read each other.
        expect(getContract(base, 'count')!.params[0].constraints[0].params).toEqual({min: 5});
        expect(getFieldContract(derived, 'count')).toBeUndefined();
    });

    it('returns empty rather than undefined for an untouched target', () => {
        expect(getFieldContracts({}).size).toBe(0);
        expect(getFieldContract({}, 'anything')).toBeUndefined();
    });
});

describe('getFieldContractsForClass — both key bands (GAP-9)', () => {
    it('returns instance and static fields together, each tagged', () => {
        class Config {}

        recordFieldConstraint(Config.prototype, 'count', min({min: 0}));
        recordFieldConstraint(Config, 'limit', min({min: 1}));

        const entries = getFieldContractsForClass(Config);

        expect(entries.map(entry => ({key: entry.key, isStatic: entry.isStatic}))).toEqual([
            {key: 'count', isStatic: false},
            {key: 'limit', isStatic: true},
        ]);
        expect(entries[0].target).toBe(Config.prototype);
        expect(entries[1].target).toBe(Config);
    });

    it('finds static fields even when the class has no instance fields', () => {
        // The same silent-omission failure `getContractsForClass` exists to prevent (DEC-018): a
        // projection walking only the prototype emits a document missing every static field, and
        // nothing throws to say so.
        class StaticsOnly {}

        recordFieldConstraint(StaticsOnly, 'limit', min({min: 0}));

        const entries = getFieldContractsForClass(StaticsOnly);
        expect(entries).toHaveLength(1);
        expect(entries[0].isStatic).toBe(true);
    });

    it('returns an empty array for a class with no field contracts', () => {
        class Bare {}

        expect(getFieldContractsForClass(Bare)).toEqual([]);
    });

    it('rejects a non-constructor', () => {
        expect(() => getFieldContractsForClass({} as any)).toThrow(/constructor/);
    });
});

describe('resetRegistry', () => {
    it('clears per-target contracts, enumeration, and the opt-out flag', () => {
        class Task {}

        recordParameterConstraint(Task.prototype, 'send', 0, min({min: 0}));
        registerContractedClass(Task);
        setClassEnumerationEnabled(false);

        resetRegistry();

        expect(getContracts(Task.prototype).size).toBe(0);
        expect(getContractedClasses()).toEqual([]);
        expect(isClassEnumerationEnabled()).toBe(true);
    });

    it('clears the field band too', () => {
        class Config {}

        recordFieldConstraint(Config.prototype, 'count', min({min: 0}));

        resetRegistry();

        expect(getFieldContracts(Config.prototype).size).toBe(0);

        // NOTE the consequence documented on `resetRegistry`: field enforcement reads the registry
        // on every assignment, so a field accessor installed before this call silently stops
        // checking. Method enforcement is planned into closures at install time and is unaffected.
        // Any suite that resets must declare its contracted classes inside the test.
    });
});

describe('postcondition band — Q-11 (own + effective, DEC-022 conjunction)', () => {
    // Identified by `description` so the effective-order assertions read clearly.
    const post = (description: string): Postcondition => ({predicate: () => true, description});
    const descriptions = (list: ReadonlyArray<Postcondition>) => list.map(p => p.description);

    it('records a postcondition against a method, own-scoped', () => {
        const target = {};
        const p = post('the id is positive');

        recordPostcondition(target, 'save', p);

        expect(getPostconditions(target, 'save')).toEqual([p]);
        expect(getPostconditions(target, 'other')).toEqual([]);
        expect(getPostconditions({}, 'save')).toEqual([]);
    });

    it('rejects a non-function predicate', () => {
        expect(() => recordPostcondition({}, 'm', {predicate: 42 as never})).toThrow(TypeError);
    });

    it('keeps declaration order as recorded (append) and prepend for the reversed adapter', () => {
        const target = {};
        recordPostcondition(target, 'm', post('a'));
        recordPostcondition(target, 'm', post('b'));
        // `prepend` is what the @Ensures adapter uses to normalise __decorate's reversal.
        recordPostcondition(target, 'm', post('z'), 'prepend');

        expect(descriptions(getPostconditions(target, 'm'))).toEqual(['z', 'a', 'b']);
    });

    it('does not leave the reserved descriptor `post` slot populated (own band only)', () => {
        const target = {};
        recordPostcondition(target, 'm', post('a'));

        // The postcondition lives in its own band; the reserved MethodContract.post slot is untouched
        // — no MethodContract entry is conjured for a postcondition-only method.
        expect(getContract(target, 'm')).toBeUndefined();
    });

    it('unions every declaration on the chain, base-most first (3-deep)', () => {
        const base = {};
        const middle = Object.create(base) as object;
        const leaf = Object.create(middle) as object;

        recordPostcondition(base, 'm', post('base'));
        recordPostcondition(middle, 'm', post('middle'));
        recordPostcondition(leaf, 'm', post('leaf'));

        expect(descriptions(getEffectivePostconditions(leaf, 'm'))).toEqual(['base', 'middle', 'leaf']);
        // Each level sees only itself and its ancestors.
        expect(descriptions(getEffectivePostconditions(middle, 'm'))).toEqual(['base', 'middle']);
        expect(descriptions(getEffectivePostconditions(base, 'm'))).toEqual(['base']);
    });

    it('conjoins a subclass override AND the parent, base-most first (the covariant-strengthen case)', () => {
        const base = {};
        const sub = Object.create(base) as object;

        recordPostcondition(base, 'm', post('parent promise'));
        recordPostcondition(sub, 'm', post('subclass promise'));

        // Both are in force on the subclass — strengthening, never replacement (DEC-022 for post).
        expect(descriptions(getEffectivePostconditions(sub, 'm'))).toEqual([
            'parent promise',
            'subclass promise',
        ]);
        // The parent's own read is untouched by the subclass.
        expect(descriptions(getEffectivePostconditions(base, 'm'))).toEqual(['parent promise']);
    });

    it('skips a level that declares an empty list — neither displaces an ancestor', () => {
        const base = {};
        const declaresEmpty = Object.create(base) as object;

        recordPostcondition(base, 'm', post('base'));
        // Create an entry, then leave it empty (the phantom-entry case).
        recordPostcondition(declaresEmpty, 'm', post('temp'));
        (getPostconditions(declaresEmpty, 'm') as Postcondition[]).length = 0;

        expect(descriptions(getEffectivePostconditions(declaresEmpty, 'm'))).toEqual(['base']);
    });

    it('returns the stored array itself when there is no contracted ancestor', () => {
        const target = {};
        recordPostcondition(target, 'm', post('a'));

        // Not merely equal — the same array, so the common case allocates nothing.
        expect(getEffectivePostconditions(target, 'm')).toBe(getPostconditions(target, 'm'));
    });

    it('collects keys own and effective, own-most first and deduplicated', () => {
        const base = {};
        const sub = Object.create(base) as object;

        recordPostcondition(base, 'shared', post('b'));
        recordPostcondition(base, 'baseOnly', post('b'));
        recordPostcondition(sub, 'shared', post('s'));
        recordPostcondition(sub, 'subOnly', post('s'));

        expect(getPostconditionKeys(sub).sort()).toEqual(['shared', 'subOnly'].sort());

        const effective = getEffectivePostconditionKeys(sub);
        expect(effective).toEqual(['shared', 'subOnly', 'baseOnly']);
        expect(effective.filter(k => k === 'shared')).toHaveLength(1);
    });

    it('is cleared by resetRegistry', () => {
        const target = {};
        recordPostcondition(target, 'm', post('a'));
        resetRegistry();
        expect(getPostconditions(target, 'm')).toEqual([]);
        expect(getEffectivePostconditions(target, 'm')).toEqual([]);
    });
});
