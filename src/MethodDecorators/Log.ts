/**
 * `@Log` — logs each call to the decorated method and how it finished.
 *
 * **Moved here from `promise/Memoize.ts`.** `@Memoize` was removed along with the `rxjs`
 * dependency (see the IDEA entry in `docs/ISSUES.md`); `Log` shared that file only by accident of
 * history and never had anything to do with promises or with rxjs, so the `promise/` directory
 * was collapsed rather than left holding one unrelated decorator. The code below is unchanged.
 */

import {CreateMethodDecorator, InvocationContext} from '../Core/MethodDecoratorFactory';

/** A member name that is safe to interpolate. `${symbol}` throws; `String(symbol)` does not. */
function memberName(propertyKey: string | symbol): string {
	return typeof propertyKey === 'symbol' ? propertyKey.toString() : String(propertyKey);
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
