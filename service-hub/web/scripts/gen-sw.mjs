// After `vite build`: stamp the list of built files (and a version) into dist/sw.js so the whole app shell
// is cached when the service worker installs. Without this, files loaded before the worker took control
// would be missing from the cache and the app would not open offline.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname;
const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
const assets = walk(join(dist, 'assets')).map((f) => '/' + f.slice(dist.length));
const version = createHash('sha1').update(assets.join('|') + readFileSync(join(dist, 'index.html'))).digest('hex').slice(0, 10);

const sw = readFileSync(join(dist, 'sw.js'), 'utf8')
  .replace('/*__PRECACHE__*/[]', JSON.stringify(assets))
  .replace("'dev'", JSON.stringify(version));
writeFileSync(join(dist, 'sw.js'), sw);
console.log(`sw.js: precaching ${assets.length} files, version ${version}`);
