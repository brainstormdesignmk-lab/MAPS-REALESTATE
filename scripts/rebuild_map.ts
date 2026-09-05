import { buildSkopjeDb } from '../src/geo/offlineMap';

buildSkopjeDb('data/skopje-pois.db')
  .then(s => { console.log(`DONE: ${s.pois} POIs, ${s.addresses} addresses, ${(s.bytes / 1e6).toFixed(1)} MB`); })
  .catch(e => { console.error('BUILD FAILED:', e.message); process.exit(1); });
