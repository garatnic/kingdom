const rotate = (value, bits) => (value << bits) | (value >>> (32 - bits));

export function seedState(seed) {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(seed)) {
    hash = Math.imul(hash ^ byte, 16777619);
  }
  return Array.from({ length: 4 }, () => {
    hash = (hash + 0x9e3779b9) | 0;
    let z = Math.imul(hash ^ (hash >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  });
}

// xoshiro128**. The mutable array is the complete random stream state.
export function random(state) {
  const [a, b, c, d] = state;
  const result = Math.imul(rotate(Math.imul(b, 5), 7), 9) >>> 0;
  state[0] = (a ^ d ^ b) >>> 0;
  state[1] = (b ^ c ^ a) >>> 0;
  state[2] = (c ^ a ^ (b << 9)) >>> 0;
  state[3] = rotate(d ^ b, 11) >>> 0;
  return result / 2 ** 32;
}
