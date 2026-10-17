import assert from 'node:assert/strict';

/**
 * Polls `cond` until it gives something truthy, and gives that. Fails with `what` when it has not
 * within `ms`, so a test stops where what it waited for did not happen, not at a later assert.
 */
export async function until<T>(cond: () => T | Promise<T>, what: string, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await cond();
    if (value) return value;
    if (Date.now() > end) assert.fail(`timed out after ${ms} ms waiting until ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
