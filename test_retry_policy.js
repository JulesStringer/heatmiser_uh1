/**
 * Wraps an asynchronous operation (a Promise) with a timeout.
 * * @param {Promise<T>} promise The promise to execute and potentially timeout.
 * @param {number} ms The timeout duration in milliseconds.
 * @param {string} timeoutMessage Optional message for the timeout rejection.
 * @returns {Promise<T>} A new promise that resolves with the original promise's value
 * or rejects if the timeout is reached.
 */
const {RetryPolicy} = require('./retry_policy.js');

// --- Example Usage (Simulating RS485 Read) ---

// This function simulates a successful RS485 read that takes a variable amount of time.
function rs485Read(durationMs, do_fail) {
    if ( do_fail ){
        throw(new Error('Forced error'));
    }
    return new Promise((resolve) => {
        setTimeout(() => {
            resolve(`Data received after ${durationMs}ms`);
        }, durationMs);
    });
}

async function runTest() {
    const TIMEOUT_MS = 2000; // 2 second timeout

    let retry_policy = new RetryPolicy(3, 2000, 'fast Timeout (not expected)');

    let fast = await retry_policy.retry(rs485Read, 1000, false).catch((err) => {
        console.error(`${err.code} ${err.message}`);
    });
    console.log('fast: ' + fast);
    let slow = await retry_policy.retry(rs485Read, 3000, false).catch((err) => {
        console.error(`${err.code} ${err.message}`);
    });
    console.log('slow: ' + slow);
}

runTest();