import { defineConfig } from 'vitest/config';

const url = process.env.TEST_DATABASE_URL;

export default defineConfig({
  test: {
    globalSetup: url ? ['./test/globalSetup.ts'] : [],
    env: {
      NODE_ENV: 'test',
      ...(url ? { DATABASE_URL: url } : {}),
      JWT_SECRET: 'test-secret-test-secret-test-secret',
      UPLOAD_DIR: './.test-uploads',
      // Enables the app-side Zoho code paths; the tests inject a fake API instead of the real client.
      ZOHO_REFRESH_TOKEN: 'x', ZOHO_CLIENT_ID: 'x', ZOHO_ORG_ID: '1',
      ZOHO_CUSTOM_FIELD_IDS: JSON.stringify({
        'invoice.cf_warranty_start': 'cf1', 'invoice.cf_warranty_terms': 'cf2', 'invoice.cf_serial_numbers': 'cf3', 'invoice.cf_app_ref': 'cf4',
        'item.cf_warranty_template': 'cf5',
      }),
    },
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
