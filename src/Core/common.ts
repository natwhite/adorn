// Custom decorator type wrappers

export type AdornClassDecorator = ClassDecorator;
export type AdornPropertyDecorator = PropertyDecorator
export type AdornMethodDecorator = MethodDecorator
export type AdornParameterDecorator = ParameterDecorator


const STRIP_COMMENTS = /(\/\/.*$)|(\/\*[\s\S]*?\*\/)|(\s*=[^,)]*(('(?:\\'|[^'\r\n])*')|("(?:\\"|[^"\r\n])*"))|(\s*=[^,)]*))/mg;
const ARGUMENT_NAMES = /([^\s,]+)/g;

export abstract class DecoratorFactory {
    static getParamNames(func) {
        const fnStr = func.toString().replace(STRIP_COMMENTS, '');
        const result = fnStr.slice(fnStr.indexOf('(') + 1, fnStr.indexOf(')')).match(ARGUMENT_NAMES);
        return result === null ? [] : result;
    }

    static getObjectName(object: Object) {
        return object && object.constructor && object.constructor.name;
    }

// TODO : Find out if there is a PURE way to accomplish this without overriding built-in functionality
    static OverrideObjectDefineProperty() {
        const ogDefine = Object.defineProperty;

        // console.log('Overriding Object.defineProperty to preserve changes...');
        // The cast is required from TS 4.0 onward: Object.defineProperty's lib
        // signature became generic (<T>(o: T, ...) => T), so a boolean-returning
        // arrow is no longer assignable. Type-level only; no runtime change.
        // This whole method is deleted at P1.4 (see DEC-005), which removes the issue.
        Object.defineProperty = ((...args) => {
            Object.defineProperty = ogDefine;
            // console.log('Restoring Object.defineProperty...');
            return true;
        }) as typeof Object.defineProperty;
    }
}
