"""A token bucket for rate limiting API calls."""
import time


class TokenBucket:
    """Allow bursts of up to `capacity` requests, refilled at `rate` tokens per second.

    - The bucket starts full.
    - Tokens refill continuously with elapsed time, never above `capacity`.
    - allow(cost=1) takes `cost` tokens and returns True when there are at least `cost` tokens;
      otherwise it takes nothing and returns False.
    - A cost larger than `capacity` can never be allowed.
    - A negative cost raises ValueError.
    - If the clock goes backwards, no tokens are added.
    - `clock` is injectable (a function returning seconds) so behaviour can be tested without sleeping.
    """

    def __init__(self, capacity: float, rate: float, clock=time.monotonic):
        if capacity <= 0 or rate < 0:
            raise ValueError("capacity must be positive and rate non-negative")
        self.capacity = float(capacity)
        self.rate = float(rate)
        self.clock = clock
        self.tokens = float(capacity)
        self.last = clock()

    def _refill(self) -> None:
        now = self.clock()
        elapsed = max(0.0, now - self.last)
        self.tokens = min(self.capacity, self.tokens + elapsed * self.rate)
        self.last = now

    def allow(self, cost: float = 1) -> bool:
        if cost < 0:
            raise ValueError("cost must not be negative")
        self._refill()
        if cost > self.capacity or self.tokens < cost:
            return False
        self.tokens -= cost
        return True
