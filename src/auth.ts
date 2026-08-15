import type { Admin } from "./db";

/**
 * Credential and session decisions. No SQL here and no Hono handlers — this is
 * the file to read to know what FlarePulse does with a password.
 *
 * PBKDF2 is not a choice, it is the only password KDF workerd exposes:
 * `Object.keys(crypto.subtle)` is empty, there is no scrypt, argon2 or bcrypt,
 * and a WASM build of one would cost both a dependency and the CPU budget below.
 */
const SCHEME = "pbkdf2-sha256";
const KEY_BITS = 256;
const SALT_BYTES = 16;

/**
 * Note: 15,000 is a measured ceiling, not a recommendation. The Workers
 * Free plan allows 10 ms of CPU per invocation, and PBKDF2-SHA256 in workerd
 * costs 4 ms at 10k iterations, 33 ms at 100k and 201 ms at the OWASP-2023
 * figure of 600k — a login route at 600k would be killed before it answered.
 * 15,000 (~6 ms) leaves the request its own budget.
 *
 * The compensating controls are the 12-character minimum, the five-strike
 * lockout below, and the fact that reading this hash at all means already
 * holding the Cloudflare account. Upgrade path: raise this constant on a Paid
 * plan and change the password once — the count is stored per hash, so old and
 * new hashes both keep verifying.
 */
export const PBKDF2_ITERATIONS = 15_000;

/** Seven days. A monitoring panel is a daily habit, not a session per action. */
export const SESSION_TTL = 7 * 86_400;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_FAILURES = 5;
export const LOCK_SECONDS = 900;

const encoder = new TextEncoder();

/**
 * `timingSafeEqual` is a workerd extension to `SubtleCrypto`. It exists at
 * runtime and in `worker-configuration.d.ts`, but this file is typechecked
 * against `lib.dom` (one tsconfig covers the Worker and the React client), and
 * lib.dom's `SubtleCrypto` predates it. Declaring it is cheaper than splitting
 * the projects; the signature is copied from the generated runtime types.
 */
declare global {
  interface SubtleCrypto {
    timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
  }
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function deriveBits(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    KEY_BITS,
  );
}

/** `pbkdf2-sha256$<iterations>$<salt>$<hash>` — self-describing, so it can age. */
export async function hashPassword(
  password: string,
  iterations = PBKDF2_ITERATIONS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const bits = await deriveBits(password, salt, iterations);
  return `${SCHEME}$${iterations}$${toBase64(salt)}$${toBase64(new Uint8Array(bits))}`;
}

/**
 * Verifies against the parameters the hash was written with. A stored value
 * this cannot parse is a failed login, not an exception — the caller's answer
 * would be the same either way, and a 500 on a corrupt row tells an attacker
 * more than a 401 does.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, rawIterations, salt, hash] = stored.split("$");
  const iterations = Number(rawIterations);
  if (scheme !== SCHEME || !Number.isInteger(iterations) || iterations < 1 || !salt || !hash) {
    return false;
  }

  try {
    const bits = await deriveBits(password, fromBase64(salt), iterations);
    return crypto.subtle.timingSafeEqual(bits, fromBase64(hash));
  } catch {
    // Undecodable base64, or two lengths timingSafeEqual refuses to compare.
    return false;
  }
}

/** 32 bytes of CSPRNG as hex: cookie-safe without encoding, 128+ bits of entropy. */
export function newSessionToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The session's primary key. The token itself is never stored. */
export async function tokenId(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface LockState {
  locked: boolean;
  nextFailure: { attempts: number; lockedUntil: number | null };
}

/**
 * The lockout rule, pure. Five consecutive failures buy fifteen minutes.
 *
 * Note: on a single-admin instance this is also a self-DoS — anyone can
 * keep the owner locked out by failing five times an hour. Fifteen minutes is
 * the tradeoff that makes online guessing pointless without making recovery a
 * support ticket; Cloudflare's own rate limiting is the tier above it.
 */
export function lockState(
  admin: Pick<Admin, "failed_attempts" | "locked_until">,
  now: number,
): LockState {
  const attempts = admin.failed_attempts + 1;
  return {
    locked: admin.locked_until !== null && admin.locked_until > now,
    nextFailure: {
      attempts,
      lockedUntil: attempts >= MAX_FAILURES ? now + LOCK_SECONDS : null,
    },
  };
}
