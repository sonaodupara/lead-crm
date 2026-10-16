import pg from 'pg';

/** Fresh empty database for every test run. Needs TEST_DATABASE_URL pointing at a throwaway database. */
export default async function setup() {
  const target = new URL(process.env.TEST_DATABASE_URL!);
  const dbName = target.pathname.slice(1);
  if (!/test/i.test(dbName)) throw new Error(`Refusing to reset "${dbName}": the test database name must contain "test"`);
  const admin = new URL(target);
  admin.pathname = '/postgres';
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  await c.query(`drop database if exists "${dbName}" with (force)`);
  await c.query(`create database "${dbName}"`);
  await c.end();
}
