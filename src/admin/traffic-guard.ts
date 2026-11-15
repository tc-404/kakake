import type { Request, Response, NextFunction } from 'express';
import express from 'express';
import { remoteAddressOf } from '../core/net-address.js';

const WINDOW_MS = 1000;
const IP_RATE = 100;
const IP_BURST = 400;
const GLOBAL_RATE = 800;
const GLOBAL_BURST = 3000;
const MAX_BUCKETS = 4096;
const WEIGHT_UNIT_BYTES = 256 * 1024;
const MAX_WEIGHT = 64;

type Bucket = { tokens: number; at: number };

const buckets = new Map<string, Bucket>();
const globalBucket: Bucket = { tokens: GLOBAL_BURST, at: Date.now() };

function refill(bucket: Bucket, rate: number, burst: number, now: number): void {
  const elapsed = now - bucket.at;
  if (elapsed <= 0) return;
  const next = bucket.tokens + (elapsed * rate) / WINDOW_MS;
  bucket.tokens = next > burst ? burst : next;
  bucket.at = now;
}

function take(bucket: Bucket, rate: number, burst: number, cost: number, now: number): boolean {
  refill(bucket, rate, burst, now);
  if (bucket.tokens < cost) return false;
  bucket.tokens -= cost;
  return true;
}

function bucketOf(ip: string, now: number): Bucket {
  const hit = buckets.get(ip);
  if (hit) return hit;
  if (buckets.size >= MAX_BUCKETS) {
    const oldest = buckets.keys().next().value;
    if (oldest !== undefined) buckets.delete(oldest);
  }
  const fresh: Bucket = { tokens: IP_BURST, at: now };
  buckets.set(ip, fresh);
  return fresh;
}

function costOf(req: Request): number {
  const type = String(req.headers['content-type'] || '');
  if (!type.includes('json')) return 1;
  const raw = Number(req.headers['content-length'] || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const weight = 1 + Math.floor(raw / WEIGHT_UNIT_BYTES);
  return weight > MAX_WEIGHT ? MAX_WEIGHT : weight;
}

function reject(req: Request, res: Response): void {
  res.status(429);
  res.setHeader('Retry-After', '1');
  res.setHeader('Connection', 'close');
  if ((req.path || '').startsWith('/api/')) {
    res.json({ ok: false, code: -1, message: '请求过于频繁，请稍后再试' });
    return;
  }
  res.type('text').send('请求过于频繁，请稍后再试');
}

export function trafficGuard() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const cost = costOf(req);
    const ip = remoteAddressOf(req) || 'unknown';
    if (!take(bucketOf(ip, now), IP_RATE, IP_BURST, cost, now)) {
      reject(req, res);
      return;
    }
    if (!take(globalBucket, GLOBAL_RATE, GLOBAL_BURST, cost, now)) {
      reject(req, res);
      return;
    }
    next();
  };
}

export function jsonBodyReader(isAuthed: (req: Request) => boolean) {
  const build = (limit: string) => express.json({
    limit,
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = buf;
    },
  });
  const large = build('10mb');
  const medium = build('1mb');
  const tiny = build('4kb');
  return (req: Request, res: Response, next: NextFunction): void => {
    const pathname = req.path || '';
    if (pathname.startsWith('/api/auth/')) {
      tiny(req, res, next);
      return;
    }
    if (pathname.startsWith('/api/') && !isAuthed(req)) {
      medium(req, res, next);
      return;
    }
    large(req, res, next);
  };
}
