// Crypto randomness for game codes and rolls (SPEC.md §4, §5). Rejection sampling
// avoids the modulo bias of `value % max`.
export function cryptoRandomInt(max: number): number {
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    const value = buffer[0]!;
    if (value < limit) return value % max;
  }
}
