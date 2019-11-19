import {Positive, StringMinLength, GreaterThanEqual, LessThanEqual} from './ParameterDecorators/Constraints';

// console.debug = (message: string) => '';

class Task {
    private testing: string = ' yolo';
    // @timeIt()
    // @Memoize()
    static promise = async () => new Promise<string>(resolve => setTimeout(() => resolve('after'), 1000));

    // We imagine that by invoking decorators that there will be no other side effects other that those explicitly desired.
    // For this reason, decorators should be decorated using Functional Programming paradigms
    test(@StringMinLength(10) message: string, @GreaterThanEqual(100) @LessThanEqual(1000) someNumber: number) {
        console.log(message + this.testing);
        // await new Promise<void>(resolve => setTimeout(() => resolve(console.log('inbetween')), 1000));
        console.log(someNumber);
        // return Task.promise();
    }
}

const task = new Task();

(async () => {
    const value = await task.test('addsodifhisfl1', 101);
    console.log(value);
})();


