// THE POLICY, PINNED — both halves of it.
//
// "No schedules anywhere" is only true if something checks, and "the owner sync
// stays" is only true if something checks THAT too. This machine was carrying a
// live nightly landmark resolver, and the hub was documented to run a monthly
// SerpApi pass, a daily snapshot, a weekly map rebuild and a 5-minute price
// sync — so the classifier and the stripper are the load-bearing part of the
// decision, not the prose.
//
// The 5-minute Hermes sync is NOT map work: Lina contacts owners, and every
// price they correct AND every address they correct (Turn 0 of the visit
// protocol) goes through it to the app. On 2026-10-14 a no-cron sweep deleted it
// as if it were one of the map jobs. These tests exist so that cannot happen again:
//
// [ ] every SCHEDULED MAP JOB we ever shipped is classified 'forbidden'
// [ ] the owner price sync is 'sync' — required, never stripped, and its
//     ABSENCE is reported as a defect
// [ ] a PARKED (commented-out) cron line is stripped too — it is one uncomment
//     away from running again
// [ ] the @reboot boot line is NOT a job: kept by default, removable on request
// [ ] unrelated lines survive untouched, and stripping is idempotent

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCronLine,
  classifyCrontab,
  stripForbidden,
  violations,
  missingSync,
  installedSync,
  BOOT_MARKER,
} from '../scripts/cron-policy';

const PRICE_SYNC = '*/5 * * * * /home/u/PROJECTS/LINA/scripts/hermes-price.sh >/dev/null 2>&1';
const BOOT = '@reboot cd /home/atom/PROJECTS/LINA && nohup node dist/index.js >> logs/lina-stdout.log 2>&1 & # LINA_ATOM';

/** Every MAP job that was ever installed — all of them must be forbidden. */
const FORBIDDEN_HISTORY = [
  '0 4 1 * * cd /srv/app && npx tsx scripts/refresh-monthly.ts --full >> logs/refresh.log 2>&1',
  '0 5 * * * cd /srv/app && npx tsx scripts/healthcheck.ts >> logs/health.log 2>&1',
  '17 3 * * * /home/u/PROJECTS/LINA/scripts/hermes-nightly.sh',
  '17 3 * * 0 /home/u/PROJECTS/LINA/scripts/skopje-map-weekly.sh',
  '30 0 * * * cd /home/u/inbound_final && ./scripts/enrich-cron.sh',
  '0 4 1 * * /srv/app/scripts/cron-if-primary.sh 192.168.1.20',
];

test('every scheduled MAP job this cluster ever shipped is classified forbidden', () => {
  for (const line of FORBIDDEN_HISTORY) {
    const c = classifyCronLine(line);
    assert.equal(c.kind, 'forbidden', `must be forbidden: ${line}`);
    assert.equal(c.active, true);
    assert.ok(c.why.length > 0, 'a violation must say what it would do');
  }
});

test('the owner sync is REQUIRED: never forbidden, never stripped, and missed when absent', () => {
  const c = classifyCronLine(PRICE_SYNC);
  assert.equal(c.kind, 'sync', 'the owner sync must never be treated as map work');
  assert.equal(c.active, true);
  assert.ok(/price/i.test(c.why) && /address/i.test(c.why),
    'it must say that BOTH queues ride this job');
  assert.deepEqual(violations(`${PRICE_SYNC}\n`), [], 'it is not a violation');

  // A cleanup sweep must leave it alone…
  const { text, removed } = stripForbidden(`${PRICE_SYNC}\n17 3 * * * /home/u/scripts/hermes-nightly.sh\n${BOOT}\n`);
  assert.equal(removed.length, 1, 'only the map job is removed');
  assert.ok(text.includes('hermes-price'), 'the price sync survives the sweep');
  assert.equal(text.split('\n').filter(l => l.includes('hermes-price')).length, 1);

  // …and its absence must be reported, not silently accepted (2026-10-14).
  const missing = missingSync('MAILTO=root\n');
  assert.equal(missing.length, 1, 'a machine without the owner sync is incomplete');
  assert.ok(/owner sync/i.test(missing[0].what));
  assert.equal(missingSync(`${PRICE_SYNC}\n`).length, 0, 'installed and active = satisfied');
  assert.equal(installedSync(`${PRICE_SYNC}\n`).length, 1);

  // A PARKED sync line does not count as installed — it is not running.
  const parked = `# ${PRICE_SYNC}`;
  assert.equal(classifyCronLine(parked).kind, 'sync');
  assert.equal(classifyCronLine(parked).active, false);
  assert.equal(missingSync(`${parked}\n`).length, 1, 'commented out = not syncing');
  assert.equal(installedSync(`${parked}\n`).length, 0);
});

test('a parked (commented) schedule is a violation too — one uncomment from running', () => {
  const parked = '# 30 0 * * * cd /home/u/inbound_final && ./scripts/enrich-cron.sh';
  const c = classifyCronLine(parked);
  assert.equal(c.kind, 'forbidden');
  assert.equal(c.active, false, 'it is not currently running…');
  // …and it still must not survive a cleanup.
  const { text, removed } = stripForbidden(`MAILTO=root\n${parked}\n`);
  assert.equal(removed.length, 1);
  assert.ok(!text.includes('enrich-cron'));
});

test('the @reboot boot line is not a job: kept by default, removable on request', () => {
  assert.equal(classifyCronLine(BOOT).kind, 'boot');
  assert.ok(BOOT.includes(BOOT_MARKER));

  const kept = stripForbidden(`${BOOT}\n`);
  assert.equal(kept.removed.length, 0);
  assert.equal(kept.text.trim(), BOOT, 'the boot line survives a normal cleanup');

  const dropped = stripForbidden(`${BOOT}\n`, { reboot: true });
  assert.equal(dropped.removed.length, 1);
  assert.equal(dropped.text.trim(), '');
});

test('unrelated lines survive untouched, and stripping is idempotent', () => {
  const body = [
    'MAILTO=root',
    'PATH=/usr/bin:/bin',
    `${PRICE_SYNC}`,                       // must stay
    FORBIDDEN_HISTORY[2],                  // the live nightly we must kill
    '0 6 * * * /home/u/backup-notes.sh',   // somebody else's job — not ours to touch
  ].join('\n') + '\n';

  const first = stripForbidden(body);
  assert.equal(first.removed.length, 1);
  assert.ok(first.text.includes('MAILTO=root'));
  assert.ok(first.text.includes('backup-notes.sh'), 'an unrelated job is not ours to remove');
  assert.ok(first.text.includes('hermes-price'), 'the required sync is kept');
  assert.ok(!first.text.includes('hermes-nightly'));

  const second = stripForbidden(first.text);
  assert.equal(second.removed.length, 0, 'idempotent');
  assert.equal(second.text, first.text);

  assert.deepEqual(violations(first.text), []);
  assert.equal(violations(body).length, 1);
});

test('an empty crontab stays empty (no stray blank lines)', () => {
  assert.equal(stripForbidden('').text, '');
  assert.equal(stripForbidden('\n\n').text, '');
  const onlyMapJobs = stripForbidden(FORBIDDEN_HISTORY.slice(0, 4).join('\n') + '\n').text;
  assert.equal(onlyMapJobs, '', 'everything removed leaves a genuinely empty crontab');
});

test('crontab classification covers active, parked and unrecognised lines', () => {
  const lines = classifyCrontab([
    '',
    '# a plain comment',
    'MAILTO=root',
    FORBIDDEN_HISTORY[1],
    PRICE_SYNC,
  ].join('\n'));
  assert.deepEqual(lines.map(l => l.kind), ['other', 'other', 'other', 'forbidden', 'sync']);
  assert.deepEqual(lines.map(l => l.active), [false, false, true, true, true]);
});
