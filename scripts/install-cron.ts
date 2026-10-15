#!/usr/bin/env tsx
/**
 * install-cron.ts — THE NO-CRON ENFORCER.
 *
 * NO MAP JOB IS SCHEDULED. The map is a FIXED ARTIFACT: it is finished and
 * deployed by a human, and it stays exactly that until a human decides to run
 * the SerpApi pass again. Nothing may change it, rebuild it, resolve a landmark,
 * spend a search or enrich a reply on a timer.
 *
 * ONE JOB MUST STAY: `hermes-price.sh`, every 5 minutes, on the atom. It is not
 * map work — it drains the two queues of owner-dictated facts:
 *   `price_changes`   (Lina asks the owner the CURRENT price) and
 *   `address_changes` (Lina confirms the ADDRESS with the owner at Turn 0 of the
 *                      visit protocol; when the owner names a different street,
 *                      the owner owns the building).
 * Both are pushed through the T60 Hub (the only app writer). A no-cron sweep
 * deleted this job on 2026-10-14: every published price froze AND every
 * corrected address was stranded in a local table. It is classified 'sync'
 * (required, never stripped) and its ABSENCE is a defect `--require-sync` reports.
 *
 * This file used to be the opposite: it INSTALLED a monthly `refresh-monthly.ts`
 * (SerpApi spending) and a daily `healthcheck.ts` on the hub. Keeping the same
 * path with inverted semantics is deliberate — an old runbook, a stale habit or
 * a `git pull` on another box must land on a REFUSAL that explains the policy,
 * not on "command not found" (which someone would then "fix" by reinstalling).
 *
 * Usage:
 *   npx tsx scripts/install-cron.ts            → --check (default): FAIL if any
 *                                                forbidden line is installed
 *   npx tsx scripts/install-cron.ts --check    → same
 *   npx tsx scripts/install-cron.ts --remove   → strip every forbidden line
 *                                                (idempotent; keeps the boot line)
 *   npx tsx scripts/install-cron.ts --remove --remove-reboot
 *                                              → also drop the @reboot boot line
 *                                                (a rebooted atom will stay down)
 *   npx tsx scripts/install-cron.ts --install  → REFUSES, with the policy text
 *   npx tsx scripts/install-cron.ts --require-sync
 *                                              → --check, AND fail if the owner
 *                                                price sync is missing (use on atoms)
 *
 * Exit code: 0 = compliant (no forbidden jobs, and the required sync present
 * when --require-sync), 1 = violations found, sync missing, or nothing to
 * remove / removal failed, 2 = bad usage.
 *
 * Run it on EVERY machine you own an account on — hub, workstation, each atom:
 *   npm run cron:check                 # must be clean (map jobs gone)
 *   npm run cron:check -- --require-sync   # …and the owner sync is running (atoms)
 *   npm run cron:remove                # makes it clean
 */

import { execSync } from 'child_process';
import { POLICY, violations, stripForbidden, classifyCrontab, missingSync, installedSync, type CronLine } from './cron-policy';

function currentCrontab(): string {
  try {
    return execSync('crontab -l', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return ''; // no crontab yet (or no crontab binary) — treated as empty
  }
}

function writeCrontab(text: string): void {
  if (text.trim() === '') execSync('crontab -r', { stdio: ['ignore', 'pipe', 'pipe'] });
  else execSync('crontab -', { input: text, encoding: 'utf8' });
}

function printLines(lines: CronLine[]): void {
  for (const l of lines) console.log(`  [${l.active ? 'ACTIVE' : 'parked'}] ${l.raw.trim()}\n            ↳ ${l.why}`);
}

function check(requireSync: boolean): number {
  const cron = currentCrontab();
  const bad = violations(cron);
  const sync = installedSync(cron);
  const missing = requireSync ? missingSync(cron) : [];
  console.log(POLICY);

  if (sync.length > 0) {
    console.log(`cron: owner sync INSTALLED — ${sync.length} required line(s) that must stay:`);
    for (const l of sync) console.log(`  [ACTIVE] ${l.raw.trim()}`);
  }

  if (bad.length > 0) {
    console.log(`cron: ${bad.length} SCHEDULED MAP JOB(S) INSTALLED — this machine violates the policy:`);
    printLines(bad);
    console.log('\nRun: npm run cron:remove');
    return 1;
  }

  if (missing.length > 0) {
    // Not a nicety: without this line every owner correction Lina collects —
    // price AND address — sits pending in the local queue and the app never
    // hears about it.
    console.log('cron: ✗ OWNER SYNC MISSING — owner price AND address corrections are NOT reaching the app:');
    for (const m of missing) console.log(`  MISSING → ${m.what}`);
    console.log('\nIt is the one job that must run. Install it with:');
    console.log('  */5 * * * * /home/atom/Documents/PROJECTS/LINA/scripts/hermes-price.sh >/dev/null 2>&1');
    return 1;
  }

  const boot = classifyCrontab(cron).filter(l => l.kind === 'boot');
  console.log('cron: COMPLIANT — no scheduled map jobs on this machine.');
  if (boot.length > 0) console.log(`  (the boot autostart line is present — not a job: ${boot.length})`);
  return 0;
}

function remove(removeReboot: boolean): number {
  const cron = currentCrontab();
  const { text, removed } = stripForbidden(cron, { reboot: removeReboot });
  console.log(POLICY);
  if (removed.length === 0) {
    console.log('cron: already compliant — nothing to remove.');
    return 1;
  }
  writeCrontab(text);
  console.log(`cron: removed ${removed.length} line(s):`);
  printLines(removed);
  if (removeReboot) {
    console.log('\n⚠ the boot autostart line is gone too — a rebooted machine will NOT come back on its own.');
  } else {
    console.log('\n(kept on purpose: the @reboot boot autostart — not a job — and the owner');
    console.log(' price sync, which is required: Lina\'s owner corrections must reach the app)');
  }
  return 0;
}

function refuseInstall(): number {
  console.log(POLICY);
  console.log('\nREFUSING to install a schedule.');
  console.log('The monthly refresh, the daily healthcheck, the nightly landmark resolver,');
  console.log('the weekly map pull and the enrichment pass are all MANUAL now. They run');
  console.log('when YOU run them, on the machine you are standing on:');
  console.log('');
  console.log('  npm run refresh          # the map pass (spends SerpApi only because you asked)');
  console.log('  npm run health           # the read-only state snapshot');
  console.log('  npm run census           # street coverage');
  console.log('  npm run cron:check       # prove no schedule has crept back');
  console.log('');
  console.log('See docs/november-runbook.md §10 (NO CRONS).');
  return 1;
}

const args = process.argv.slice(2);
const removeReboot = args.includes('--remove-reboot');
const requireSync = args.includes('--require-sync');

if (args.includes('--install')) {
  process.exit(refuseInstall());
} else if (args.includes('--remove')) {
  process.exit(remove(removeReboot));
} else if (args.length === 0 || args.includes('--check') || requireSync) {
  process.exit(check(requireSync));
} else {
  console.error(`Unknown arg(s): ${args.join(' ')} (use --check [--require-sync] | --remove [--remove-reboot])`);
  process.exit(2);
}
