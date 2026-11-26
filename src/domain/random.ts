// Seeded pseudo-random numbers (mulberry32). Pure.
//
// FLOW-33: the New interview screen draws its question set with a seed (drawBalanced in plan.ts),
// so a draw can be repeated in tests.

/** A random 32-bit seed. */
export function newSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

/** Returns a function giving numbers in [0, 1), the same sequence for the same seed. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
