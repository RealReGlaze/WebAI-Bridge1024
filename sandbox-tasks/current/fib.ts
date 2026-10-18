export function fib(n: number): number {
if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
throw new TypeError(`fib(n) requires a non-negative integer, got: ${String(n)}`);
}
let a = 0;
let b = 1;
for (let i = 0; i < n; i++) {
const next = a + b;
a = b;
b = next;
}
return a;
}