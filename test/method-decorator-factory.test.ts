/**
 * P1.2 — `MethodDecoratorFactory`, the only sanctioned installation path.
 *
 * These are not characterization tests; the module is new. They pin the two
 * properties the whole DEC-005 sequence rests on:
 *
 *   1. a method decorator that RETURNS a descriptor is honoured by `__decorate`,
 *      so no global patching is needed to make a wrapper stick; and
 *   2. `installMethodWrapper` — used by the `@Contract()` class installer —
 *      produces an own property on the target and leaves the prototype chain
 *      above it alone.
 *
 * Plus wrapper identity: `.name` (BUG-7), `this`, `toString`, and own-property
 * transfer.
 */

import {
    CreateMethodDecorator,
    findMethod,
    installMethodWrapper,
    InvocationContext,
    MethodBehavior,
    wrapMethod,
} from '../src/Adapters/legacy/MethodDecoratorFactory';

const passthrough: MethodBehavior = (_context, proceed) => proceed();

describe('CreateMethodDecorator', () => {
    it('installs a wrapper by returning the descriptor, with no global patching', () => {
        const calls: string[] = [];
        const Trace = () =>
            CreateMethodDecorator((context, proceed) => {
                calls.push(String(context.propertyKey));
                return proceed();
            });

        const pristine = Object.defineProperty;

        class Task {
            @Trace()
            run(n: number) {
                return n * 2;
            }
        }

        // The mechanism: `__decorate` does `r = d(target, key, r) || r` and then
        // defines `r`. A returned descriptor is written back — which is exactly
        // what a parameter decorator could never do, and exactly why the old
        // design needed to monkey-patch `Object.defineProperty`.
        expect(Object.defineProperty).toBe(pristine);
        expect(new Task().run(21)).toBe(42);
        expect(calls).toEqual(['run']);
    });

    it('runs as an around-behaviour: proceed() controls invocation', () => {
        let invoked = false;
        const Skip = () => CreateMethodDecorator(() => 'short-circuited');

        class Task {
            @Skip()
            run() {
                invoked = true;
                return 'original';
            }
        }

        expect(new Task().run()).toBe('short-circuited');
        expect(invoked).toBe(false);
    });

    it('can wrap the result and observe both sides of the call', () => {
        const events: string[] = [];
        const Around = () =>
            CreateMethodDecorator((_context, proceed) => {
                events.push('before');
                try {
                    return proceed();
                } finally {
                    events.push('after');
                }
            });

        class Task {
            @Around()
            run() {
                events.push('body');
                return 1;
            }
        }

        expect(new Task().run()).toBe(1);
        expect(events).toEqual(['before', 'body', 'after']);
    });

    it('composes with parameter decorators in the same __decorate call', () => {
        // Parameter decorators occupy the tail of the emitted decorator array and
        // the array is applied back-to-front, so they run BEFORE the method
        // decorator. Anything they record is therefore complete by the time the
        // method decorator installs — which is what makes a per-method installer
        // viable at all.
        const order: string[] = [];
        const RecordParam = () => (_t: any, _k: string, index: number) => {
            order.push(`param:${index}`);
        };
        const Install = () => CreateMethodDecorator(passthrough);

        class Task {
            @Install()
            run(@RecordParam() a: number, @RecordParam() b: number) {
                return a + b;
            }
        }
        void Task;

        // both parameter decorators ran; the method decorator saw them all
        expect(order).toEqual(['param:1', 'param:0']);
    });

    it('rejects a non-method target with an actionable message', () => {
        expect(() => {
            CreateMethodDecorator(passthrough)({}, 'missing', {value: 42} as any);
        }).toThrow(/not a method/);
    });
});

describe('wrapper identity', () => {
    function original(a: number, b: number) {
        return a + b;
    }

    it('preserves the function name (BUG-7)', () => {
        const wrapper = wrapMethod(original, {}, 'original', passthrough);
        expect(wrapper.name).toBe('original');
    });

    it('reports the original source through toString', () => {
        const wrapper = wrapMethod(original, {}, 'original', passthrough);
        expect(wrapper.toString()).toBe(original.toString());
    });

    it('does NOT restore arity — that is P1.6', () => {
        const wrapper = wrapMethod(original, {}, 'original', passthrough);
        expect(original.length).toBe(2);
        expect(wrapper.length).toBe(0);
    });

    it('copies own properties by descriptor, including non-enumerable and symbol keys', () => {
        // SMELL-10: the old implementation used `for...in` + assignment, which
        // silently dropped non-enumerables and symbols.
        const marker = Symbol('marker');
        const source: any = function tagged() {
            return 1;
        };
        source.visible = 'yes';
        Object.defineProperty(source, 'hidden', {value: 'also', enumerable: false});
        source[marker] = 'symbolic';

        const wrapper = wrapMethod(source, {}, 'tagged', passthrough) as any;

        expect(wrapper.visible).toBe('yes');
        expect(wrapper.hidden).toBe('also');
        expect(wrapper[marker]).toBe('symbolic');
        expect(Object.getOwnPropertyDescriptor(wrapper, 'hidden')!.enumerable).toBe(false);
    });

    it('forwards `this` and the full argument list', () => {
        const seen: InvocationContext[] = [];
        const host = {
            greeting: 'hi',
            greet(name: string, punctuation: string) {
                return `${this.greeting} ${name}${punctuation}`;
            },
        };

        host.greet = wrapMethod(host.greet, host, 'greet', (context, proceed) => {
            seen.push(context);
            return proceed();
        }) as typeof host.greet;

        expect(host.greet('there', '!')).toBe('hi there!');
        expect(seen[0].thisArg).toBe(host);
        expect(seen[0].args).toEqual(['there', '!']);
    });

    it('lets a behaviour mutate arguments before the method sees them', () => {
        const Double = wrapMethod(
            function scale(n: number) {
                return n;
            },
            {},
            'scale',
            (context, proceed) => {
                context.args[0] = (context.args[0] as number) * 2;
                return proceed();
            },
        );

        expect((Double as any)(21)).toBe(42);
    });

    it('does not touch an exception thrown by the method itself', () => {
        // The factory deliberately puts no try/catch around `proceed()`. A
        // failure inside the method is the caller's business and its stack must
        // survive intact; only a behaviour knows which failures are its own.
        const boom = new Error('from the method');
        const originalStack = boom.stack;
        const wrapper = wrapMethod(
            function fails() {
                throw boom;
            },
            {},
            'fails',
            passthrough,
        );

        let caught: any;
        try {
            (wrapper as any)();
        } catch (e) {
            caught = e;
        }
        expect(caught).toBe(boom);
        // byte-identical: nothing rewrote it on the way out
        expect(caught.stack).toBe(originalStack);
    });
});

describe('installMethodWrapper', () => {
    it('replaces the method with an own, non-enumerable, configurable property', () => {
        class Task {
            run(n: number) {
                return n;
            }
        }

        installMethodWrapper(Task.prototype, 'run', (context, proceed) => `${proceed()}!`);

        const descriptor = Object.getOwnPropertyDescriptor(Task.prototype, 'run')!;
        expect(descriptor.enumerable).toBe(false);
        expect(descriptor.configurable).toBe(true);
        expect(descriptor.writable).toBe(true);
        expect(new Task().run(1) as any).toBe('1!');
    });

    it('shadows an inherited method rather than mutating the parent', () => {
        // The inheritance hazard from plan P1.6: reading `target[key]` walks the
        // prototype chain, so a naive installer would find and modify the
        // PARENT's method, corrupting the base class for every other subclass.
        class Base {
            run(n: number) {
                return `base:${n}`;
            }
        }
        class Sub extends Base {}
        class Other extends Base {}

        const baseImplementation = Base.prototype.run;

        installMethodWrapper(Sub.prototype, 'run', (_context, proceed) => `wrapped(${proceed()})`);

        expect(Object.getOwnPropertyDescriptor(Sub.prototype, 'run')).toBeDefined();
        expect(Base.prototype.run).toBe(baseImplementation);
        expect(new Sub().run(1)).toBe('wrapped(base:1)');
        expect(new Other().run(1)).toBe('base:1');
    });

    it('installs over a static method on the constructor', () => {
        class Task {
            static parse(input: string) {
                return input.trim();
            }
        }

        installMethodWrapper(Task, 'parse', (_context, proceed) => `[${proceed()}]`);
        expect(Task.parse('  x  ')).toBe('[x]');
    });

    it('gives an actionable error for an arrow-function class property', () => {
        // `foo = (x) => ...` is an instance field: absent from the prototype when
        // a class decorator runs. Supporting it needs per-instance installation
        // (Tier 2); until then the failure must at least be legible instead of a
        // bare "cannot read property of undefined".
        class Task {
            arrow = (n: number) => n;
        }

        expect(() => installMethodWrapper(Task.prototype, 'arrow', passthrough)).toThrow(
            /arrow-function class property/,
        );
    });

    it('refuses a non-configurable property instead of throwing an opaque error', () => {
        const host: any = {};
        Object.defineProperty(host, 'frozen', {value: () => 1, configurable: false});

        expect(() => installMethodWrapper(host, 'frozen', passthrough)).toThrow(/non-configurable/);
    });
});

describe('findMethod', () => {
    class Base {
        inherited() {
            return 'base';
        }
    }
    class Sub extends Base {
        own() {
            return 'sub';
        }
    }

    it('finds own and inherited methods', () => {
        expect(findMethod(Sub.prototype, 'own')).toBe(Sub.prototype.own);
        expect(findMethod(Sub.prototype, 'inherited')).toBe(Base.prototype.inherited);
    });

    it('returns undefined for a missing member or a non-function property', () => {
        expect(findMethod(Sub.prototype, 'nope')).toBeUndefined();
        expect(findMethod({value: 42}, 'value')).toBeUndefined();
    });
});
