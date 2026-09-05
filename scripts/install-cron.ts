#!/usr/bin/env tsx
/**
 * install-cron.ts — installs the fire-and-forget cron lines (T60 ONLY!).
 *
 * This repo is the WORKSTATION (Lenovo). The cron must run on the T60 deploy
 * machine. After rsyncing this repo over, run `npx tsx scripts/install-cron.ts
 * --install` THERE — never on the workstation. This file only exists here so
 * the activation step is code, not tribal knowledge.
 *
 * The two lines (from the Phase B spec):
 *   0 4 1 * *  monthly refresh  — POI restore + SerpApi top-up + queue drain + poison sweep
 *   0 5 * * *  daily healthcheck — read-only state snapshot into logs/health.log
 *
 * Usage:
 *   npx tsx scripts/install-cron.ts            → --check (default): report which
 *                                                lines are installed, change nothing
 *   npx tsx scripts/install-cron.ts --check    → same
 *   npx tsx scripts/install-cron.ts --install  → idempotently append the missing
 *                                                lines + mkdir logs/ (T60 only)
 */

import { execSync } from 'child_process';

// Hub app dir — override with MAPS_APP_DIR if the repo lives elsewhere
// (default: the conventional T60 location).
const APP_DIR = process.env.MAPS_APP_DIR ?? '/srv/app';

// Node bin dir — hubs with a SELF-CONTAINED .node/ inside the repo (T60/T620
// pattern) set MAPS_NODE_BIN=<repo>/.node/bin so the cron line gets an
// ABSOLUTE path. Cron runs with a minimal env: a bare `npx` only works when
// node is on the system PATH.
const NODE_BIN = process.env.MAPS_NODE_BIN ?? '';
const TSX = NODE_BIN ? `${NODE_BIN}/npx tsx` : 'npx tsx';

const LINES = [
  // Monthly refresh — POI restore (OSM), SerpApi top-up, queue drain, poison sweep
  `0 4 1 * * cd ${APP_DIR} && ${TSX} scripts/refresh-monthly.ts >> logs/refresh.log 2>&1`,
  // Daily healthcheck — read-only state snapshot (POIs by source, landmark tiers, queue)
  `0 5 * * * cd ${APP_DIR} && ${TSX} scripts/healthcheck.ts >> logs/health.log 2>&1`,
];

function currentCrontab(): string {
  try {
    return execSync('crontab -l', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return ''; // no crontab yet — treated as empty
  }
}

function installedLines(cron: string): Array<{ line: string; installed: boolean }> {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const existing = cron.split('\n').map(norm).filter(Boolean);
  return LINES.map(line => ({ line, installed: existing.includes(norm(line)) }));
}

function check(): number {
  const cron = currentCrontab();
  const status = installedLines(cron);
  const all = status.every(s => s.installed);
  console.log(`cron for ${APP_DIR} — ${all ? 'ACTIVE' : 'NOT ACTIVE'} on this machine`);
  for (const s of status) {
    console.log(`  [${s.installed ? 'installed' : 'missing   '}] ${s.line}`);
  }
  if (!all) {
    console.log('\nTo activate (T60 only): npx tsx scripts/install-cron.ts --install');
  }
  return all ? 0 : 1;
}

function install(): number {
  const cron = currentCrontab();
  const status = installedLines(cron);
  const missing = status.filter(s => !s.installed);
  if (missing.length === 0) {
    console.log('All cron lines already installed — nothing to do.');
    return 0;
  }
  // Append only the missing lines; never duplicate existing ones.
  const additions = missing.map(s => s.line).join('\n');
  const next = cron.trimEnd() + (cron.trimEnd() ? '\n' : '') + additions + '\n';
  execSync(`crontab -`, { input: next, encoding: 'utf8' });
  execSync(`mkdir -p '${APP_DIR}/logs'`); // >> logs/x.log fails without the dir
  console.log(`Installed ${missing.length} cron line(s):`);
  for (const s of missing) console.log(`  ${s.line}`);
  console.log('Logs land in logs/refresh.log + logs/health.log (created by cron).');
  return 0;
}

const arg = process.argv[2] ?? '--check';
if (arg === '--install') {
  process.exit(install());
} else if (arg === '--check') {
  process.exit(check());
} else {
  console.error(`Unknown arg: ${arg} (use --check or --install)`);
  process.exit(2);
}