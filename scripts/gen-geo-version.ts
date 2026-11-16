#!/usr/bin/env tsx
/**
 * gen-geo-version.ts — the ONLY writer of GEO_VERSION.txt.
 *
 * WHY: the runbook's pre-flight is `md5sum -c GEO_VERSION.txt` and its abort
 * rule is "a geo change invalidates the map". That check was only ever
 * half-alive: the stamp listed 15 files while `src/geo` grew a 16th
 * (`feedPlaceAudit.ts`) that no stamp mentioned, and after three legitimate geo
 * commits the three changed files failed while the missing file passed by
 * absence. A stamp whose coverage is a hand-maintained list rots silently, and
 * the pre-flight then either blocks a run that is fine or, worse, passes a run
 * whose geo engine nobody stamped.
 *
 * So coverage is DISCOVERED, never listed: every `src/geo/*.ts` is stamped, and
 * a `--check` run also fails when a file exists that the stamp does not know
 * (that is the case the old manual list could not express).
 *
 * Usage:
 *   npx tsx scripts/gen-geo-version.ts           # rewrite GEO_VERSION.txt
 *   npx tsx scripts/gen-geo-version.ts --check   # verify, change nothing
 *
 * Exit: 0 ok, 1 stamp wrong (--check), 2 environment error.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');
const GEO_DIR = path.join(REPO_ROOT, 'src', 'geo');
const STAMP = path.join(REPO_ROOT, 'GEO_VERSION.txt');

interface Entry {
  /** Repo-relative POSIX path, exactly as md5sum(1) prints it. */
  file: string;
  md5: string;
}

/** Every top-level `.ts` in src/geo, sorted — a subdirectory would be missed, so
 *  it is an error rather than a silent omission. */
function discover(): string[] {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(GEO_DIR, { withFileTypes: true });
  } catch (e) {
    console.error(`✗ cannot read ${GEO_DIR}: ${(e as Error).message}`);
    process.exit(2);
  }
  const subdir = dirents.find(d => d.isDirectory());
  if (subdir) {
    console.error(`✗ ${path.join('src/geo', subdir.name)} is a directory — the stamp covers src/geo/*.ts only.`);
    console.error('  Teach this script to recurse before adding geo modules in subdirectories.');
    process.exit(2);
  }
  return dirents
    .filter(d => d.isFile() && d.name.endsWith('.ts'))
    .map(d => path.posix.join('src', 'geo', d.name))
    .sort();
}

function stampEntries(): Entry[] {
  return discover().map(file => ({
    file,
    md5: crypto.createHash('md5').update(fs.readFileSync(path.join(REPO_ROOT, file))).digest('hex'),
  }));
}

function render(entries: Entry[]): string {
  // `md5sum -c` format: "<md5>  <path>" (two spaces).
  return entries.map(e => `${e.md5}  ${e.file}`).join('\n') + '\n';
}

/** Parse an existing stamp into a map, tolerating the historical hand-kept file. */
function readStamp(): Map<string, string> | undefined {
  let text: string;
  try {
    text = fs.readFileSync(STAMP, 'utf8');
  } catch {
    return undefined;
  }
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{32})\s+(\S+)$/.exec(line.trim());
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

function main(): number {
  const check = process.argv.includes('--check');
  const entries = stampEntries();
  if (entries.length === 0) {
    console.error('✗ no src/geo/*.ts found — refusing to write an empty stamp');
    return 2;
  }

  if (!check) {
    fs.writeFileSync(STAMP, render(entries));
    console.log(`✓ wrote GEO_VERSION.txt — ${entries.length} file(s) stamped`);
    return 0;
  }

  const old = readStamp();
  if (old === undefined) {
    console.error('✗ GEO_VERSION.txt is missing — run: npx tsx scripts/gen-geo-version.ts');
    return 1;
  }
  const now = new Map(entries.map(e => [e.file, e.md5]));
  const problems: string[] = [];
  for (const e of entries) {
    const was = old.get(e.file);
    if (was === undefined) problems.push(`  + ${e.file} is NOT stamped (a geo module the stamp never saw)`);
    else if (was !== e.md5) problems.push(`  ~ ${e.file} changed`);
  }
  for (const file of old.keys()) {
    if (!now.has(file)) problems.push(`  - ${file} is stamped but does not exist`);
  }
  if (problems.length === 0) {
    console.log(`✓ GEO_VERSION.txt matches src/geo — ${entries.length} file(s)`);
    return 0;
  }
  console.error(`✗ GEO_VERSION.txt does not match src/geo (${problems.length} problem(s)):`);
  for (const p of problems) console.error(p);
  console.error('\nA geo change invalidates the map. Re-stamp ONLY after the geo change is');
  console.error('reviewed and its tests pass:  npx tsx scripts/gen-geo-version.ts');
  return 1;
}

process.exit(main());
