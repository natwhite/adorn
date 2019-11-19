/**
 * Object returned by the CreateSimpleDecorator method to ensure typings
 */
import {DecoratorFactory} from './common';

export interface ParamObject<T> {
    objectName: string,
    funcName: string,
    paramName: string,
    value: T
    signature: string
}

type ParamDeco<T = any> = (params: ParamObject<T>) => void;

interface parameterDecoratedFunction extends Function {
    parameterDecorated: boolean,
    parameterDecorators: { decorator: ParamDeco, parameterIndex: number }[],
}

/**
 * DecoratorFactory instance for simplifying the creating of parameter decorators
 */
export class ParameterDecoratorFactory {

    // TODO : Find a way to generalize the code for applying decorators to method and property decorators
    static CreateSimpleDecorator<T>(decorator: ParamDeco): (target: any, propertyKey: string, parameterIndex: number) => void {

        // TODO : Confirm the parameter type matches that of the decorator used.
        return function (target: any, propertyKey: string, parameterIndex: number) {
            // console.log('resolving decorator');

            const indexedDeco = Object.freeze({decorator, parameterIndex});

            const originalFunction = target[propertyKey] as parameterDecoratedFunction; // Preserver the original function for calling after we've done param stuff
            if (originalFunction.parameterDecorated) {
                // console.debug('Appending decorators to the decorated function ' + decorator.toString());
                originalFunction.parameterDecorators.push(indexedDeco);
                return; // Ideally, this will result in only the first decorator re-writing the object properties
            }

            console.debug('Modifying target object for decoration');
            target[propertyKey].parameterDecorated = true;
            target[propertyKey].parameterDecorators = [indexedDeco];

            const paramNames = DecoratorFactory.getParamNames(originalFunction);
            const objectName = DecoratorFactory.getObjectName(target);

            const paramConstructor = (args: any[]) => (parameterIndex: number): ParamObject<T> => ({
                objectName: objectName,
                funcName: originalFunction.name,
                paramName: paramNames[parameterIndex],
                value: args[parameterIndex],
                signature: `${objectName}.${originalFunction.name}(${paramNames.join(', ')}) parameter '${paramNames[parameterIndex]}'`
            });

            let obj = {};
            // Inner function to separate scope
            // Maintain the original function name
            obj[originalFunction.name] = function (...args: any[]) {

                // Log the previous version of the function for debugging purposes
                // This should recursively apply with the number of decorators
                // console.log(originalFunction.toString());
                console.debug('Calling modified function');

                // Construct pretty parameters for use in simple decorator calls
                const parameters = paramConstructor(args);

                // TODO : This method of cleaning up error handling assumes that decorators throw errors at their top levels
                // No point in having intentional errors redirect to our code, modify the stack and re-emit
                try {
                    // Pass parameters to wrapped decorator
                    for (const d of originalFunction.parameterDecorators) {
                        // console.log(`Running decorator ${d.decorator.toString()} with parameter index ${d.parameterIndex}`);
                        d.decorator(parameters(d.parameterIndex));
                    }
                } catch (e) {
                    const stackSteps = e.stack.split('\n');
                    e.stack = stackSteps[0] + '\n' + stackSteps.slice(3).join('\n') + '\n';
                    throw e;
                }

                // Deconstruct parameter value changes
                // args[parameterIndex] = parameters.value;

                // Use 'args' to maintain the original function parameters length
                // This ensures that the relative scope is the same
                // Return the original return value
                // Use await which has no effect unless the call needed to be awaited
                return originalFunction.apply(this, args);
            };

            // TODO : For extremely large objects this can become unwieldy, consider an alternative
            // Maintain the original scoped variables
            for (const prop in originalFunction) {
                if (originalFunction.hasOwnProperty(prop))
                    obj[originalFunction.name][prop] = originalFunction[prop];
            }

            // Maintain the original toString output
            obj[originalFunction.name].toString = () => originalFunction.toString();

            // Overwrite the original function with the modified version
            console.debug('Replacing the original function with modified copy');
            target[propertyKey] = obj[originalFunction.name];

            DecoratorFactory.OverrideObjectDefineProperty();
        };
    }
}
