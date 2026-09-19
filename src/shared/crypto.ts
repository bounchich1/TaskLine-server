import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** SHA-256, hex. */
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** 256 random bits, URL-safe: session, CSRF and download tokens. */
export const token = () => randomBytes(32).toString('base64url');

/** Constant-time string comparison (for secrets). */
export function equal(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/** AES-256-GCM of the value's JSON: base64 of IV (12 bytes) + tag (16 bytes) + ciphertext. */
export function encrypt(value: unknown, key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}
/** Inverse of encrypt. The caller states the type it encrypted. */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed JSON.parse
export function decrypt<T>(value: string, key: string): T {
  const buf = Buffer.from(value, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), buf.subarray(0, 12));
  cipher.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([cipher.update(buf.subarray(28)), cipher.final()]).toString('utf8'),
  ) as T;
}
