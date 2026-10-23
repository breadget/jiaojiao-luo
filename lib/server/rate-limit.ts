type Bucket = { expiresAt: number; count: number };

/** Bounded per-process limiter; a full table never evicts an active client's limit. */
export class RateLimitBuckets {
  private readonly buckets = new Map<string, Bucket>();
  private nextSweepAt = 0;

  constructor(private readonly maxBuckets = 10_000) {}

  /** Returns the retry delay in seconds, or null when the request is allowed. */
  consume(
    key: string,
    limit: number,
    windowMs: number,
    now = Date.now(),
  ): number | null {
    if (now >= this.nextSweepAt) {
      for (const [bucketKey, bucket] of this.buckets) {
        if (now >= bucket.expiresAt) this.buckets.delete(bucketKey);
      }
      this.nextSweepAt = now + 1_000;
    }
    let bucket = this.buckets.get(key);
    if (bucket && now >= bucket.expiresAt) {
      this.buckets.delete(key);
      bucket = undefined;
    }
    if (!bucket) {
      if (this.buckets.size >= this.maxBuckets) return 1;
      bucket = { expiresAt: now + windowMs, count: 0 };
      this.buckets.set(key, bucket);
    }
    bucket.count = Math.min(bucket.count + 1, limit + 1);
    return bucket.count <= limit
      ? null
      : Math.max(1, Math.ceil((bucket.expiresAt - now) / 1_000));
  }
}
