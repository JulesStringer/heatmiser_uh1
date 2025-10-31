const E_TIMEOUT = 'E_TIMEOUT';

class RetryPolicy {
    /**
     * @param {number} max_retry Maximum number of attempts.
     * @param {number} ms The timeout duration for each attempt.
     * @param {string} timeoutMessage Message for the final timeout rejection.
     */
    constructor(max_retry = 5, ms = 2000, timeoutMessage = 'Operation timed out') {
        this.max_retry = max_retry;
        this.ms = ms;
        this.timeoutMessage = timeoutMessage;
    }

    /**
     * 1. Internal helper method for enforcing a timeout on a single promise.
     * * @param {Promise<T>} promise The promise to execute and potentially timeout.
     * @returns {Promise<T>} A promise that resolves or rejects, possibly with E_TIMEOUT.
     */
    #timeoutPromise(promise) {
        let timeoutHandle;
        
        // Create the timeout error
        let err = new Error(this.timeoutMessage);
        err.code = E_TIMEOUT;

        const timeout = new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => {
                reject(err);
            }, this.ms); // Uses the class's 'ms' property
        });

        // Race the original promise against the timeout timer
        return Promise.race([promise, timeout])
            .finally(() => {
                clearTimeout(timeoutHandle);
            });
    }

    /**
     * 2. Public method that manages the retry loop.
     * * @param {function(...args: any[]): Promise<T>} promiseFactory A function that returns a fresh Promise instance.
     * @param {...any} args Arguments to be passed to the promiseFactory function on each call.
     * @returns {Promise<T>} The resolved value of the successful promise.
     */
    async retry(promiseFactory, ...args) {
        for (let retries = 0; retries < this.max_retry; retries++) {
            try {
                // Call the internal timeout method, which uses the class's 'ms' value
                const freshPromise = promiseFactory(...args);
                return await this.#timeoutPromise(freshPromise); 

            } catch (e) {
                if (e.code === E_TIMEOUT) {
                    // Log and retry
                    console.warn(`Attempt ${retries + 1}/${this.max_retry} failed with timeout. Retrying...`);
                } else {
                    // Non-timeout error: throw immediately
                    throw e;
                }
            }
        }
        
        // Final failure after all retries are exhausted
        let message = `${this.max_retry} retries failed due to: ${this.timeoutMessage}`;
        let error = new Error(message);
        error.code = E_TIMEOUT;
        throw error;
    }
}

exports.RetryPolicy = RetryPolicy;
exports.E_TIMEOUT = E_TIMEOUT;