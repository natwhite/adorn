import { Observable } from 'rxjs';
import { publishReplay, refCount } from 'rxjs/operators';

// Memoizes the results of the decorated method T() => Observable<T>

/*Should this convert an asynchronous method call to a cached call?
 * But that would change the signature
 * It's probably best just to have overloads for each possible type of method*/

/**
 * Identity tags for values that cannot be described structurally — functions, and objects
 * that reappear inside their own graph. Keys are held weakly, so tagging an argument never
 * keeps it alive.
 */
const identityTags = new WeakMap<object, number>();
let nextIdentityTag = 0;

function identityTag(value: object): number {
	let tag = identityTags.get(value);
	if (tag === undefined) {
		tag = nextIdentityTag++;
		identityTags.set(value, tag);
	}
	return tag;
}

/**
 * Builds a stable string key for a single argument.
 *
 * Keying is *structural*, not by identity: two separately-constructed but equal objects hit
 * the same cache entry, which is what a caller memoizing `find({id: 1})` expects. Each kind
 * is tagged so that values which merely stringify alike stay distinct — `1` from `'1'`,
 * `null` from `undefined`, `0` from `-0`.
 *
 * `seen` guards against cycles. It holds only the current ancestor chain (entries are removed
 * on the way back up), so a value shared between two siblings is still keyed structurally and
 * only a genuine back-reference falls back to identity.
 */
function keyOfArgument(value: any, seen: WeakSet<object>): string {
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';

	switch (typeof value) {
		case 'string':
			return 'str:' + JSON.stringify(value);
		case 'number':
			// `Object.is` separates -0 from 0; `String` renders NaN and +/-Infinity distinctly.
			return 'num:' + (Object.is(value, -0) ? '-0' : String(value));
		case 'boolean':
			return 'bool:' + String(value);
		case 'bigint':
			return 'big:' + String(value);
		case 'symbol':
			// Symbols are not valid WeakMap keys at this lib target, so identity cannot be
			// tagged; two symbols sharing a description collide. Documented, not fixed.
			return 'sym:' + String(value);
		case 'function':
			return 'fn:' + identityTag(value);
	}

	if (seen.has(value)) {
		// A back-reference into the chain above us. Recursing would not terminate.
		return 'cycle:' + identityTag(value);
	}
	seen.add(value);

	try {
		if (value instanceof Date) return 'date:' + value.getTime();
		if (value instanceof RegExp) return 'regexp:' + String(value);

		if (Array.isArray(value)) {
			return 'arr:[' + value.map(item => keyOfArgument(item, seen)).join(',') + ']';
		}

		// Own enumerable keys, sorted so {a, b} and {b, a} agree. The constructor tag keeps
		// instances of different classes apart even when their fields match.
		const tag = (value.constructor && value.constructor.name) || 'Object';
		const entries = Object.keys(value)
			.sort()
			.map(key => JSON.stringify(key) + ':' + keyOfArgument(value[key], seen));
		return 'obj:' + tag + '{' + entries.join(',') + '}';
	} finally {
		seen.delete(value);
	}
}

/** Joins the per-argument keys. Arity is significant: `f()` and `f(undefined)` differ. */
function cacheKeyOf(args: any[]): string {
	const seen = new WeakSet<object>();
	return args.map(arg => keyOfArgument(arg, seen)).join('|');
}

/**
 * `instanceof` first, then duck-typing — so a second copy of rxjs in `node_modules` (where
 * `instanceof` fails across realms) and interop observables still pass. `pipe` is required
 * as well as `subscribe`, because we go on to call it.
 */
function isObservableLike(value: any): value is Observable<any> {
	if (value instanceof Observable) return true;
	return !!value && typeof value.subscribe === 'function' && typeof value.pipe === 'function';
}

/** Describes a wrong return value well enough to locate the mistake. */
function describeValue(value: any): string {
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';

	const type = typeof value;
	if (type !== 'object' && type !== 'function') return `${type} (${String(value)})`;

	const name = value.constructor && value.constructor.name;
	return name ? `${type} (${name})` : type;
}

/**
 * Memoizes a method returning an RxJS `Observable`, per instance and per argument list.
 *
 * **Cold-safe.** Nothing is subscribed at decoration or at call time. The cached value is the
 * source piped through `publishReplay()` + `refCount()`, which stays cold until the caller
 * subscribes; the producer then runs once and later subscribers replay it. Eagerly subscribing
 * to cache a *value* would duplicate side effects and break cold Observables.
 *
 * **Storage.** A `WeakMap` keyed by the instance, held in the decorator closure — one per
 * decorated method. The instance is never written to, and when it becomes garbage its cache
 * goes with it. Only the derived string key is retained, never the arguments themselves, so
 * memoizing on a large object does not pin that object in memory.
 *
 * **Not provided:** invalidation, TTL, and size limits. A cache entry lives as long as its
 * instance. That is deliberate — see the memoization vocabulary in `docs/vision.md`, which is
 * a later item; this decorator fixes correctness only.
 */
export function Memoize() {
	return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
		const method = descriptor.value; // references the method being decorated

		// the Observable function
		if (typeof method !== 'function') {
			throw new Error('use MemoizeDecorator only on services methods');
		}

		// Per-decoration, per-instance. `WeakMap` entries are ephemerons: an entry survives
		// only while its key is reachable independently of this map, so a cached Observable
		// closing over its own instance — the common case — is still collectable.
		const cachesByInstance = new WeakMap<object, Map<string, Observable<any>>>();
		// Detached calls (`const f = svc.method; f(1)`) have no object to key on. They share
		// one cache rather than throwing out of `WeakMap.set`.
		const detachedCache = new Map<string, Observable<any>>();

		descriptor.value = function (...args) {
			const owner = this;
			const keyable = owner !== null && (typeof owner === 'object' || typeof owner === 'function');

			let cache: Map<string, Observable<any>>;
			if (keyable) {
				cache = cachesByInstance.get(owner);
				if (!cache) {
					cache = new Map<string, Observable<any>>();
					cachesByInstance.set(owner, cache);
				}
			} else {
				cache = detachedCache;
			}

			const key = cacheKeyOf(args);
			if (cache.has(key)) {
				return cache.get(key);
			}

			const returnedObservable = method.apply(this, args);

			// Reported here, at the point of misuse, rather than as an obscure failure later.
			// A throwing call caches nothing, so the mistake is not sticky.
			if (!isObservableLike(returnedObservable)) {
				throw new TypeError(
					`method decorated with Memoize must return an Observable: '${propertyKey}' returned ${describeValue(returnedObservable)}`,
				);
			}

			const memoized = returnedObservable.pipe(publishReplay(), refCount(),);
			cache.set(key, memoized);

			return memoized;
		};
	};
}


export function Log() {
	return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
		const method = descriptor.value;

		descriptor.value = function (...args: any[]) {

			// convert list of greet arguments to string
			const params = args.map(a => JSON.stringify(a)).join();

			// invoke greet() and get its return value
			const result = method.apply(this, args);

			// convert result to string
			const r = JSON.stringify(result);

			// display in console the function call details
			console.log(`Call: ${propertyKey}(${params}) => ${r}`);

			// return the result of invoking the method
			return result;
		};
		// return descriptor;
	};
}
