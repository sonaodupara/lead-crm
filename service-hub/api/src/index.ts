import { config, zohoEnabled } from './config.js';
import { pool } from './db.js';
import { migrate } from './migrate.js';
import { buildApp } from './server.js';
import { ZohoClient } from './zoho/client.js';
import { runSyncCycle } from './zoho/sync.js';
import { generateDueVisitJobs } from './lib/amcService.js';
import { tx } from './db.js';

await migrate();
const api = zohoEnabled ? new ZohoClient() : null;
const app = await buildApp({ zoho: api });

if (api) {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try { await runSyncCycle(api); } catch (e) { app.log.error(e, 'zoho sync cycle failed'); } finally { running = false; }
  }, config.ZOHO_SYNC_INTERVAL_SEC * 1000);
  app.log.info(`Zoho sync enabled (${config.ZOHO_PRODUCT})`);
} else {
  app.log.warn('Zoho sync is OFF (no credentials) — documents will stay "not synced"');
}

// Create jobs for AMC visits that fall due soon; also expires finished contracts.
const dailyAmc = async () => {
  try {
    const owner = (await pool.query(`select id from users where role='owner' and active order by created_at limit 1`)).rows[0];
    if (!owner) return;
    const n = await tx((c) => generateDueVisitJobs(c, owner.id, 14));
    if (n) app.log.info(`AMC: created ${n} visit job(s)`);
  } catch (e) { app.log.error(e, 'AMC tick failed'); }
};
setInterval(dailyAmc, 6 * 3600 * 1000);
void dailyAmc();

const stop = async () => { await app.close(); await pool.end(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

await app.listen({ port: config.PORT, host: config.HOST });
