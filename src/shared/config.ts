import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_URL: z.url().default('http://localhost:3000'),
  APP_ORIGIN: z.url().default('http://localhost:5173'),
  ORG_ID: z.uuid().default('00000000-0000-4000-8000-000000000001'),
  ORG_NAME: z.string().default('Служба поддержки'),
  ORG_TIMEZONE: z.string().default('Asia/Krasnoyarsk'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  ENCRYPTION_KEY: z.string().regex(/^[a-f0-9]{64}$/i),
  GATEWAY_SECRET: z.string().min(32),
  GATEWAY_URL: z.url().default('http://localhost:3001'),
  GATEWAY_PORT: z.coerce.number().default(3001),
  MAX_MODE: z.enum(['mock', 'live']).default('mock'),
  MAX_API_URL: z.url().default('https://platform-api2.max.ru'),
  MAX_BOT_TOKEN: z.string().default(''),
  MAX_WEBHOOK_SECRET: z.string().min(32),
  MAX_MEDIA_HOSTS: z.string().default(''),
  POLICY_VERSION: z.string().min(1),
  POLICY_URL: z.url(),
  ALTERNATIVE_CONTACT: z.string().min(1),
  AI_ENABLED: bool,
  AI_MODE: z.enum(['mock', 'live']).default('mock'),
  AI_API_URL: z.url().default('https://api.openai.com/v1/chat/completions'),
  AI_API_KEY: z.string().default(''),
  AI_MODEL: z.string().default(''),
  AI_MAX_CONCURRENCY: z.coerce.number().int().min(10).max(15).default(12),
  AI_TRIAGE_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(90).default(45),
  AI_LEARNING_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(120).default(90),
  AI_INPUT_CHARS: z.coerce.number().int().min(4000).max(100000).default(24000),
  MEMORY_ENABLED: bool,
  AGENTMEMORY_URL: z.url().default('http://localhost:3111'),
  AGENTMEMORY_SECRET: z.string().min(32),
  STORAGE_MODE: z.enum(['local', 's3']).default('local'),
  STORAGE_PATH: z.string().default('.data/attachments'),
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('support-private'),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  SCANNER_MODE: z.enum(['clamav', 'mock']).default('clamav'),
  CLAMAV_HOST: z.string().default('127.0.0.1'),
  CLAMAV_PORT: z.coerce.number().int().default(3310),
  BOOTSTRAP_MAX_USER_ID: z.string().default(''),
  BOOTSTRAP_NAME: z.string().default('Администратор'),
  DEV_AUTH_ENABLED: bool,
});
export type Config = z.infer<typeof schema>;
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const c = schema.parse(env);
  new Intl.DateTimeFormat('ru', { timeZone: c.ORG_TIMEZONE });
  if (c.MAX_MODE === 'live' && !c.MAX_BOT_TOKEN) {
    throw new Error('MAX_BOT_TOKEN required for live MAX');
  }
  if (c.AI_ENABLED && c.AI_MODE === 'live' && (!c.AI_API_KEY || !c.AI_MODEL)) {
    throw new Error('AI_API_KEY and AI_MODEL required');
  }
  if (c.NODE_ENV === 'production') {
    if (
      c.DEV_AUTH_ENABLED ||
      c.MAX_MODE !== 'live' ||
      c.SCANNER_MODE !== 'clamav' ||
      c.STORAGE_MODE !== 's3'
    ) {
      throw new Error('Unsafe production mode');
    }
    if (c.AI_ENABLED && c.AI_MODE !== 'live') {
      throw new Error('Mock AI forbidden in production');
    }
    for (const url of [c.PUBLIC_URL, c.APP_ORIGIN, c.POLICY_URL, c.MAX_API_URL, c.AI_API_URL]) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.hostname.endsWith('.invalid')) {
        throw new Error('Production requires configured HTTPS URLs');
      }
    }
    if (c.POLICY_VERSION.startsWith('dev-')) {
      throw new Error('Publish approved consent policy before production');
    }
  }
  return c;
}

/** Hosts MAX serves client media from (the only hosts media is fetched from or uploaded to). */
export function mediaHosts(config: Config): string[] {
  return config.MAX_MEDIA_HOSTS.split(',')
    .map((host) => host.trim())
    .filter(Boolean);
}
