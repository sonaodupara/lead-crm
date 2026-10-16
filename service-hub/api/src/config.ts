import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().default('postgres://postgres@localhost:5432/servicehub'),
  JWT_SECRET: z.string().min(16).default('dev-only-secret-change-me-please'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  UPLOAD_DIR: z.string().default('./uploads'),
  WEB_DIST: z.string().default('../web/dist'),
  MAX_UPLOAD_MB: z.coerce.number().default(15),

  // Zoho (India data centre by default). Leave ZOHO_REFRESH_TOKEN empty to run
  // the app with Zoho sync switched off: documents then stay "not_synced".
  ZOHO_ACCOUNTS_URL: z.string().default('https://accounts.zoho.in'),
  ZOHO_CLIENT_ID: z.string().default(''),
  ZOHO_CLIENT_SECRET: z.string().default(''),
  ZOHO_REFRESH_TOKEN: z.string().default(''),
  ZOHO_ORG_ID: z.string().default(''),
  ZOHO_BOOKS_API_URL: z.string().default('https://www.zohoapis.in/books/v3'),
  // JSON map of app field -> Zoho custom field id, filled in after the
  // fields are created in Zoho (docs/ZOHO.md).
  ZOHO_CUSTOM_FIELD_IDS: z.string().default('{}'),
  ZOHO_SYNC_INTERVAL_SEC: z.coerce.number().default(60),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}
export const config = parsed.data;

if (config.NODE_ENV === 'production' && config.JWT_SECRET.startsWith('dev-only')) {
  console.error('JWT_SECRET must be set in production');
  process.exit(1);
}

export const zohoEnabled = Boolean(config.ZOHO_REFRESH_TOKEN && config.ZOHO_CLIENT_ID && config.ZOHO_ORG_ID);
