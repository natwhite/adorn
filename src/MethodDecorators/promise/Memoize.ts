import { Observable } from 'rxjs';
import { shareReplay } from 'rxjs/operators';
import { CreateMethodDecorator, InvocationContext } from '../../Core/MethodDecoratorFactory';

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
 *
 * **BUG-11.** Own enumerable keys describe a plain object and nothing else. `Map`, `Set`, typed
 * arrays and `ArrayBuffer` keep their contents in internal slots, so the generic branch keyed
 * every one of them as structurally empty — `f(new Map([[1, 2]]))` collided with `f(new Map())`
 * and got back the **wrong** cached Observable. Each is now described explicitly, and any other
 * exotic built-in falls back to *identity* rather than to an empty structure: a cache miss is a
 * performance loss, a wrong hit is a correctness failure, and the two are not comparable.
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

		// --- Containers whose state lives in internal slots (BUG-11) ---------------------
		//
		// Entries are keyed and then *sorted as strings*, so two Maps built in different
		// insertion orders agree. That matches the plain-object branch below, which sorts its
		// keys for the same reason, and matches how a caller thinks about `Map` equality: a
		// lookup table does not mean something different because it was filled in another
		// order. It does mean insertion order is not observable through the key — deliberate,
		// and the same trade the object branch already makes.
		if (value instanceof Map) {
			const entries = Array.from(value.entries() as Iterable<[any, any]>)
				.map(([k, v]) => keyOfArgument(k, seen) + '=>' + keyOfArgument(v, seen))
				.sort();
			return 'map:{' + entries.join(',') + '}';
		}
		if (value instanceof Set) {
			const members = Array.from(value.values() as Iterable<any>)
				.map(member => keyOfArgument(member, seen))
				.sort();
			return 'set:{' + members.join(',') + '}';
		}

		// Typed arrays and `DataView`. The constructor name is part of the key because a
		// `Uint8Array` and an `Int8Array` over identical bytes are not interchangeable
		// arguments. `DataView` is read through a byte view of its own window rather than the
		// whole buffer, so two views onto different regions do not collide.
		if (ArrayBuffer.isView(value)) {
			const name = (value.constructor && value.constructor.name) || 'ArrayBufferView';
			const bytes = value instanceof DataView
				? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
				: (value as unknown as ArrayLike<any>);
			return 'view:' + name + '[' + Array.prototype.join.call(bytes, ',') + ']';
		}
		if (value instanceof ArrayBuffer) {
			return 'buffer:[' + Array.prototype.join.call(new Uint8Array(value), ',') + ']';
		}

		// Any *other* exotic built-in — `Promise`, `WeakMap`, `WeakSet`, `Error`, a generator,
		// a boxed primitive. `Object.prototype.toString` still reports the native class tag for
		// all of them, and none of them can be described by own enumerable keys. Falling
		// through to the generic branch would key every `Promise` as `obj:Promise{}` and hand
		// the second caller the first caller's cached Observable. Identity is the only honest
		// answer available, so distinct instances miss rather than collide.
		//
		// A user class is `[object Object]` and is unaffected. The residue this leaves is a
		// user class that hides all of its state behind non-enumerable properties or prototype
		// getters — still keyed as empty, still able to collide. Recorded, not fixed here.
		const nativeTag = Object.prototype.toString.call(value);
		if (nativeTag !== '[object Object]') {
			return 'opaque:' + nativeTag + ':' + identityTag(value);
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

/** A member name that is safe to interpolate. `${symbol}` throws; `String(symbol)` does not. */
function memberName(propertyKey: string | symbol): string {
	return typeof propertyKey === 'symbol' ? propertyKey.toString() : String(propertyKey);
}

/**
 * Memoizes a method returning an RxJS `Observable`, per instance and per argument list.
 *
 * **Cold-safe.** Nothing is subscribed at decoration or at call time. The cached value is the
 * source piped through `shareReplay({bufferSize: Infinity, refCount: false})`, which stays cold
 * until the caller subscribes; the producer then runs once and later subscribers replay it.
 * Eagerly subscribing to cache a *value* would duplicate side effects and break cold Observables.
 *
 * **Why not `publishReplay()` + `refCount()` (BUG-9).** That pairing tears its connection down
 * when the subscriber count reaches zero, and rxjs 6's `ConnectableObservable` rebuilds its
 * stopped subject on the next subscribe. A source that had not completed was therefore
 * **re-executed** on resubscribe *while the stale buffer was still replayed* — the caller saw
 * old values and a second run of the producer's side effects, from something whose entire job is
 * to run once. Completing sources (an HTTP call, the intended use) never reach a refcount of zero
 * with a live source, which is why it went unnoticed. `refCount: false` holds the subscription
 * regardless of subscriber count, which is what "memoized" has to mean.
 *
 * **The cost of `refCount: false`, stated plainly.** The source subscription is established on
 * the first subscribe and is never torn down for a source that does not complete, even after
 * every subscriber has unsubscribed. An infinite stream therefore keeps producing, and the
 * replay buffer keeps growing, for as long as the cache entry lives — which is as long as the
 * instance does (BUG-3). `@Memoize` is for a call that finishes; it is not a subscription
 * manager, and it never was.
 *
 * **Failures are now retried, not pinned (BUG-10).** `shareReplay` discards its subject when the
 * source errors, so the next subscribe re-runs the producer instead of replaying the failure
 * forever. A successful retry is then cached normally. The old pairing memoized the error
 * permanently and left the caller no way back.
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
export function Memoize(): MethodDecorator {
	return function (target: any, propertyKey: string | symbol, descriptor: PropertyDescriptor) {
		// Checked here rather than left to the factory so the message stays the one this
		// decorator has always given. The factory's own guard is about method decoration in
		// general; this one names `Memoize` and its intended use.
		if (!descriptor || typeof descriptor.value !== 'function') {
			throw new Error('use MemoizeDecorator only on services methods');
		}

		const member = memberName(propertyKey);

		// Per-decoration, per-instance. `WeakMap` entries are ephemerons: an entry survives
		// only while its key is reachable independently of this map, so a cached Observable
		// closing over its own instance — the common case — is still collectable.
		const cachesByInstance = new WeakMap<object, Map<string, Observable<any>>>();
		// Detached calls (`const f = svc.method; f(1)`) have no object to key on. They share
		// one cache rather than throwing out of `WeakMap.set`.
		const detachedCache = new Map<string, Observable<any>>();

		// BUG-13: installed through the factory rather than by assigning `descriptor.value`
		// directly, so the wrapper keeps the method's `.name` and its `toString` (which
		// parameter-name recovery reads — SMELL-1) instead of reporting as an anonymous
		// function. Arity is still 0; restoring `length` belongs to the factory (P1.6), not
		// here.
		return (CreateMethodDecorator(function (context: InvocationContext, proceed: () => any) {
			const owner = context.thisArg;
			const keyable = owner !== null && owner !== undefined
				&& (typeof owner === 'object' || typeof owner === 'function');

			let cache: Map<string, Observable<any>>;
			if (keyable) {
				cache = cachesByInstance.get(owner as object);
				if (!cache) {
					cache = new Map<string, Observable<any>>();
					cachesByInstance.set(owner as object, cache);
				}
			} else {
				cache = detachedCache;
			}

			const key = cacheKeyOf(context.args);
			if (cache.has(key)) {
				return cache.get(key);
			}

			const returnedObservable = proceed();

			// Reported here, at the point of misuse, rather than as an obscure failure later.
			// A throwing call caches nothing, so the mistake is not sticky.
			if (!isObservableLike(returnedObservable)) {
				throw new TypeError(
					`method decorated with Memoize must return an Observable: '${member}' returned ${describeValue(returnedObservable)}`,
				);
			}

			const memoized = returnedObservable.pipe(shareReplay({bufferSize: Infinity, refCount: false}));
			cache.set(key, memoized);

			return memoized;
		}) as any)(target, propertyKey, descriptor);
	} as MethodDecorator;
}


// ---------------------------------------------------------------------------
// @Log
// ---------------------------------------------------------------------------

/**
 * Render a value for a log line without ever throwing (BUG-13).
 *
 * `JSON.stringify` is not total. It raises on a circular structure and on a `BigInt`, and the
 * original `@Log` called it unguarded on both the arguments *and* the return value — so a method
 * returning a self-referential object had its return **destroyed by its own logger**, and a
 * method *taking* one was never called at all, because the argument line was built first. A
 * logging decorator that can change whether a method succeeds is worse than no logging.
 *
 * Cycles are detected against the current ancestor chain rather than a flat "already seen" set,
 * so a value referenced by two siblings renders normally instead of being mislabelled
 * `[Circular]` — the usual bug in the quick version of this function.
 */
function safeStringify(value: any): string {
	if (value === undefined) return 'undefined';

	const ancestors: any[] = [];
	try {
		const json = JSON.stringify(value, function (this: any, _key: string, val: any) {
			if (typeof val === 'bigint') return String(val) + 'n';
			if (typeof val === 'function') return '[Function: ' + (val.name || 'anonymous') + ']';
			if (typeof val === 'symbol') return val.toString();
			if (val === null || typeof val !== 'object') return val;

			// `this` is the object `val` was read from. Unwind to it, so entries left behind
			// by a completed branch do not masquerade as ancestors of this one.
			while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
			if (ancestors.indexOf(val) !== -1) return '[Circular]';
			ancestors.push(val);
			return val;
		});
		// `JSON.stringify` returns `undefined` for a function or a lone symbol at the top level.
		return json === undefined ? String(value) : json;
	} catch {
		// Belt and braces. Whatever this was, it is not worth failing a method over.
		return '[unserializable]';
	}
}

/** Describes a thrown value for the log line. A throw is not required to be an `Error`. */
function describeThrown(error: any): string {
	if (error instanceof Error) return error.name + ': ' + error.message;
	return safeStringify(error);
}

/** Writing the log must not be able to fail the call either — a sink can be broken too. */
function write(line: string): void {
	try {
		if (typeof console !== 'undefined' && typeof console.log === 'function') console.log(line);
	} catch {
		// Ignored, deliberately. See `safeStringify`.
	}
}

/**
 * Logs each call to the decorated method — its arguments, and how it finished.
 *
 * **It cannot change what the method does.** Every part of the logging path is total: values are
 * rendered by {@link safeStringify}, the write itself is guarded, and a throw is logged and then
 * re-thrown unchanged. That is the whole contract of a logging decorator and the original did not
 * meet it (BUG-13).
 *
 * A throwing call is reported rather than silently omitted. The original logged only on the
 * success path, so a failing method left no trace at all — the one case a reader of the log is
 * most likely to be looking for.
 */
export function Log(): MethodDecorator {
	return CreateMethodDecorator(function (context: InvocationContext, proceed: () => any) {
		const member = memberName(context.propertyKey);
		// Rendered before the call, so what is logged is what the method was actually handed
		// rather than whatever it may have mutated its arguments into.
		const params = context.args.map(arg => safeStringify(arg)).join(',');

		let result: any;
		try {
			result = proceed();
		} catch (error) {
			write(`Call: ${member}(${params}) threw ${describeThrown(error)}`);
			throw error;
		}

		write(`Call: ${member}(${params}) => ${safeStringify(result)}`);
		return result;
	});
}
