import bcrypt from 'bcryptjs';
import { pool } from './db.js';
import { migrate } from './migrate.js';

/** First-run setup: an owner login and a few starter warranty templates. Safe to re-run. */
export async function seedBase(email = process.env.SEED_OWNER_EMAIL, password = process.env.SEED_OWNER_PASSWORD) {
  const users = (await pool.query('select count(*)::int n from users')).rows[0].n;
  if (!users) {
    if (!email || !password || password.length < 8)
      throw new Error('Set SEED_OWNER_EMAIL and SEED_OWNER_PASSWORD (min 8 chars) to create the first owner');
    await pool.query(`insert into users (name,email,role,password_hash) values ('Owner',$1,'owner',$2)`, [email, await bcrypt.hash(password, 10)]);
    console.log(`created owner ${email}`);
  }
  const templates = [
    ['STD-1Y', 'Standard 1 year (parts & labour)', 12, 12, 0, 'Covers manufacturing defects. Warranty starts on the invoice date.'],
    ['PARTS-1Y', '1 year parts only', 12, 0, 0, 'Parts replaced free of charge; labour chargeable.'],
    ['ONSITE-2Y', '2 years with on-site service', 24, 24, 24, 'On-site service included.'],
  ] as const;
  for (const [code, name, p, l, o, terms] of templates)
    await pool.query(
      `insert into warranty_templates (code,name,parts_months,labour_months,onsite_months,coverage,terms_text,extendable)
       values ($1,$2,$3,$4,$5,$6,$7,true) on conflict (code) do nothing`,
      [code, name, p, l, o, JSON.stringify([p && 'parts', l && 'labour', o && 'onsite'].filter(Boolean)), terms]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().then(() => seedBase()).then(() => pool.end()).catch((e) => { console.error(e.message); process.exit(1); });
}
