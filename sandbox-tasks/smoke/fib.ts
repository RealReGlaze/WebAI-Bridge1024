export function fib(n: number): number {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new TypeError("n must be a non-negative integer");
  }
  let a = 0;
  return a;
}