// Accounts & sessions, dependency-free. Passwords are scrypt-hashed; the session
// is a stateless HMAC-signed cookie (userId.signature). Google sign-in verifies a
// real Google ID token when GOOGLE_CLIENT_ID is set — otherwise the frontend uses
// a clearly-labelled demo connect, and this verifier stays dormant.

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request, Response } from 'express';
import { store } from './store.ts';
import type { Role, User } from './types.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const COOKIE = 'parley_sid';

// A stable secret: env, else generated once and persisted under data/.
function sessionSecret(): string {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = join(ROOT, 'data', 'session.secret');
  if (existsSync(f)) return readFileSync(f, 'utf8').trim();
  const s = randomBytes(32).toString('hex');
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(f, s);
  return s;
}
const SECRET = sessionSecret();

// ── passwords ────────────────────────────────────────────────────────────────

export function hashPassword(password: string): { salt: string; hash: string } {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password: string, salt: string, hash: string): boolean {
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

// ── session cookie ───────────────────────────────────────────────────────────

function sign(userId: string): string {
  const sig = createHmac('sha256', SECRET).update(userId).digest('hex');
  return `${userId}.${sig}`;
}

function unsign(value: string): string | null {
  const dot = value.lastIndexOf('.');
  if (dot === -1) return null;
  const userId = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = createHmac('sha256', SECRET).update(userId).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? userId : null;
}

function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function setSession(res: Response, userId: string): void {
  const v = encodeURIComponent(sign(userId));
  res.setHeader('Set-Cookie', `${COOKIE}=${v}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`);
}

export function clearSession(res: Response): void {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

export function currentUser(req: Request): User | undefined {
  const raw = parseCookies(req)[COOKIE];
  if (!raw) return undefined;
  const userId = unsign(raw);
  return userId ? store.getUser(userId) : undefined;
}

// ── account creation ─────────────────────────────────────────────────────────

const VALID_ROLES: Role[] = ['candidate', 'employer'];

export function createAccount(input: {
  email: string;
  password?: string;
  googleSub?: string;
  role: Role;
  displayName: string;
}): User {
  const email = input.email.trim().toLowerCase();
  if (!email.includes('@')) throw new Error('a valid email is required');
  if (!VALID_ROLES.includes(input.role)) throw new Error('role must be candidate or employer');
  if (store.getUserByEmail(email)) throw new Error('an account with that email already exists');

  const base: User = {
    id: `usr_${randomBytes(4).toString('hex')}`,
    email,
    role: input.role,
    displayName: input.displayName?.trim() || email.split('@')[0]!,
    createdAt: new Date().toISOString(),
  };

  if (input.password) {
    if (input.password.length < 6) throw new Error('password must be at least 6 characters');
    const { salt, hash } = hashPassword(input.password);
    base.salt = salt;
    base.passwordHash = hash;
  }
  if (input.googleSub) base.googleSub = input.googleSub;
  if (input.role === 'employer') base.profile = {};

  return store.putUser(base);
}

// ── Google ID-token verification (real when GOOGLE_CLIENT_ID is set) ───────────

export function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID);
}

export async function verifyGoogleIdToken(credential: string): Promise<{ sub: string; email: string; name?: string }> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error('Google sign-in is not configured (set GOOGLE_CLIENT_ID)');
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
  if (!res.ok) throw new Error('invalid Google token');
  const data = (await res.json()) as { aud?: string; sub?: string; email?: string; name?: string; exp?: string };
  if (data.aud !== clientId) throw new Error('Google token audience mismatch');
  if (!data.sub || !data.email) throw new Error('Google token missing identity');
  if (data.exp && Number(data.exp) * 1000 < Date.now()) throw new Error('Google token expired');
  return { sub: data.sub, email: data.email, name: data.name };
}

export function publicUser(u: User) {
  return {
    id: u.id, email: u.email, role: u.role, displayName: u.displayName,
    hasAgent: Boolean(u.agentId), hasProfile: Boolean(u.profile?.company),
  };
}
