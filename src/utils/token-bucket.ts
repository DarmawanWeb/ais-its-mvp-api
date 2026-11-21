/**
 * Token bucket: allows bursts of up to `capacity` events and a sustained rate
 * of `ratePerSecond` events per second.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly capacity: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.lastRefill = now();
  }

  /** Takes one token; false when the rate is exceeded. */
  tryRemoveToken(): boolean {
    const currentTime = this.now();
    const elapsedSeconds = (currentTime - this.lastRefill) / 1000;
    this.tokens = Math.min(
      this.capacity,
      this.tokens + elapsedSeconds * this.ratePerSecond,
    );
    this.lastRefill = currentTime;

    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
