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
        Object.defineProperty = (...args) => {
            Object.defineProperty = ogDefine;
            // console.log('Restoring Object.defineProperty...');
            return true;
        };
    }
}
