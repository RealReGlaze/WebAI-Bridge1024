import assert from "node:assert/strict";
import { fib } from "./fib.ts";

// 基本用例
assert.equal(fib(0), 0, "fib(0) should be 0");
assert.equal(fib(1), 1, "fib(1) should be 1");
assert.equal(fib(10), 55, "fib(10) should be 55");

// 非法参数
assert.throws(() => fib(-1), TypeError, "fib(-1) should throw TypeError");
assert.throws(() => fib(1.5), TypeError, "fib(1.5) should throw TypeError");
assert.throws(() => fib(NaN), TypeError, "fib(NaN) should throw TypeError");
assert.throws(
() => fib("3" as unknown as number),
TypeError,
"fib('3') should throw TypeError",
);

console.log("ALL PASSED");