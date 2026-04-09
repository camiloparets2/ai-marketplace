// Shared rate limiting utilities for API routes.
// Uses Upstash Redis + @upstash/ratelimit. Fails open when env vars are missing
// (local dev / CI) so sellers aren't blocked.

import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";

// ─── Pre-configured limiters ─────────────────────────────────────────────────
// Each limiter is lazily initialised to avoid import-time crashes when Upstash
// env vars aren't configured yet.

let _analyzeLimiter: Ratelimit | null = null;
let _checkoutLimiter: Ratelimit | null = null;
let _connectLimiter: Ratelimit | null = null;

function makeRedis(): Redis {
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
}

/** 5 scans per user per 24 hours */
export function getAnalyzeLimiter(): Ratelimit {
  if (!_analyzeLimiter) {
    _analyzeLimiter = new Ratelimit({
      redis: makeRedis(),
      limiter: Ratelimit.fixedWindow(5, "24 h"),
      prefix: "snap2list:rl:analyze",
    });
  }
  return _analyzeLimiter;
}

/** 10 checkout attempts per IP per minute — blocks bot spam */
export function getCheckoutLimiter(): Ratelimit {
  if (!_checkoutLimiter) {
    _checkoutLimiter = new Ratelimit({
      redis: makeRedis(),
      limiter: Ratelimit.fixedWindow(10, "1 m"),
      prefix: "snap2list:rl:checkout",
    });
  }
  return _checkoutLimiter;
}

/** 5 connect onboarding attempts per user per hour */
export function getConnectLimiter(): Ratelimit {
  if (!_connectLimiter) {
    _connectLimiter = new Ratelimit({
      redis: makeRedis(),
      limiter: Ratelimit.fixedWindow(5, "1 h"),
      prefix: "snap2list:rl:connect",
    });
  }
  return _connectLimiter;
}

/** Check if Upstash is configured. If not, rate limiting is skipped. */
export function isRateLimitConfigured(): boolean {
  return !!(
    process.env.UPSTASH_REDIS_REST_URL &&
    process.env.UPSTASH_REDIS_REST_TOKEN
  );
}

/** Extract client IP from request headers (Vercel / Cloudflare / fallback) */
export function getClientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}
