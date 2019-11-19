export class Verify {
    /**
     * Returns the value if it's positive or throws an error
     *
     * @param keyName - The name of the variable being assigned (for logging)
     * @param value - The value being assigned
     */
    static positive(keyName, value) {
        if (value > 0) {
            throw new Error(`ValueError: ${String(keyName)} is expected to be a positive number, got '${value}'`);
        }
        return value;
    }

    static lessThanEqual(key, target, constraint) {
        if (target > constraint) {
            throw new Error(`ValueError: ${String(key)} is expected to be less than or equal to '${constraint}', got '${target}'`);
        }
    }

    static greaterThanEqual(key, target, constraint) {
        if (target < constraint) {
            throw new Error(`ValueError: ${String(key)} is expected to be greater than or equal to '${constraint}', got '${target}'`);
        }
    }
}
