import {Observable} from 'rxjs';
import {publishReplay, refCount} from 'rxjs/operators';

// Memoizes the results of the decorated method T() => Observable<T>

/*Should this convert an asynchronous method call to a cached call?
* But that would change the signature
* It's probably best just to have overloads for each possible type of method*/

export function Memoize() {
    return function (
        target: any,
        propertyKey: string,
        descriptor: PropertyDescriptor,
    ) {
        const method = descriptor.value; // references the method being decorated
        let cacheMember = propertyKey + 'CacheMember';

        // the Observable function
        if (!descriptor.value) {
            throw new Error('use MemoizeDecorator only on services methods');
        }

        descriptor.value = function (...args) {
            if (!target[cacheMember]) {
                let returnedObservable = method.apply(this, args);
                if (!(returnedObservable instanceof Observable)) {
                    throw new Error(
                        `method decorated with Memoized Decorator must return Observable`,
                    );
                }

                target[cacheMember] = returnedObservable.pipe(
                    publishReplay(),
                    refCount(),
                );
            }

            return target[cacheMember];
        };
    };
}


export function Log(
    target: Object,
    propertyName: string,
    propertyDesciptor: PropertyDescriptor): PropertyDescriptor {
    // target === Employee.prototype
    // propertyName === "greet"
    // propertyDesciptor === Object.getOwnPropertyDescriptor(Employee.prototype, "greet")
    const method = propertyDesciptor.value;

    propertyDesciptor.value = function (...args: any[]) {

        // convert list of greet arguments to string
        const params = args.map(a => JSON.stringify(a)).join();

        // invoke greet() and get its return value
        const result = method.apply(this, args);

        // convert result to string
        const r = JSON.stringify(result);

        // display in console the function call details
        console.log(`Call: ${propertyName}(${params}) => ${r}`);

        // return the result of invoking the method
        return result;
    };
    return propertyDesciptor;
}
