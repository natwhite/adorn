import {Verify} from '../Validation/Verify';

export class Enforce {
    private static generator(func: (v, k?, t?) => void) {
        return (target, key) => {
            Object.defineProperty(target, key, {
                configurable: false,
                set: v => func(v, key, target),
            });
        };
    }

    /**
     * Enforces positive number assignments only
     */
    static positive = () => Enforce.generator((v, k) => Verify.positive(k, v));
}
