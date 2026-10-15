// cron-policy — THE POLICY, as code: no MAP job is ever scheduled, and the
// atom's owner-sync job always is.
//
// THE DECISION (2026-10-14), in two halves:
//
//   1. THE MAP IS A FIXED ARTIFACT. It is finished and deployed by a human, and
//      it stays exactly that until a human decides to run the SerpApi pass again.
//      No timer may ever change the map, rebuild it, resolve a landmark on it,
//      spend a search or enrich a reply on its own.
//
//   2. THE OWNER SYNC MUST KEEP RUNNING. `scripts/hermes-price.sh` every 5
//      minutes is NOT map work and must never be removed. It is the atom's one
//      carrier of owner-dictated facts to the app, and it drains TWO queues:
//        • `price_changes`   — Lina asks the owner the CURRENT price; a different
//          one is recorded and pushed (public price follows the owner's word).
//        • `address_changes` — Lina confirms the ADDRESS with the owner before a
//          visit; when the owner gives a different one, the owner owns the
//          building and the listing learns the real street.
//      Both go through the T60 Hub (the only writer to the app). Deleting this
//      job silently freezes every published price AND strands every corrected
//      address in a local table nobody reads.
//
// WHY THIS FILE EXISTS AT ALL: "no crons" is not a preference that survives in
// prose. It has already been violated BOTH ways — this workstation had a live
// nightly `hermes-nightly.sh` (LLM landmark resolution, writing rows), the hub
// was documented to run a monthly `refresh-monthly.ts` (SerpApi spending), a
// daily `healthcheck.ts`, a weekly `map:pull` and a 5-minute price sync — and on
// 2026-10-14 the price sync was removed by a no-cron sweep that could not tell it
// apart from map work. That is why the classifier has THREE job kinds, not two.
//
// So the policy is enforced by a classifier + a stripper (this file, unit
// tested) driven by scripts/install-cron.ts:
//   --check   (default) → FAIL if any forbidden line is installed
//   --remove            → strip them (idempotent)
//   --install           → REFUSE, and say why
//   --require-sync      → also FAIL if the owner sync is missing (use on atoms)
//
// THE ONE NAMED EXCEPTION AMONG NON-JOBS: the `@reboot … # LINA_ATOM` line is
// NOT a scheduled job. It runs no map work, spends nothing and learns nothing —
// it only brings the bot back after a power cut, and removing it means a
// rebooted atom stays dead until somebody notices. It is classified separately
// and KEPT unless you say `--remove-reboot`.

/** A cron line the policy forbids, and what it would do if left installed. */
export const FORBIDDEN: ReadonlyArray<{ re: RegExp; what: string }> = [
  { re: /refresh-monthly/, what: 'monthly POI refresh — restores OSM, spends SerpApi, drains the queue (the map changes itself)' },
  { re: /healthcheck/, what: 'daily state snapshot — read-only, but still a timer nobody asked for' },
  { re: /hermes-nightly/, what: 'nightly landmark resolver — LLM calls and landmark writes' },
  { re: /skopje-map-weekly/, what: 'weekly map pull — REBUILDS skopje-pois.db from OSM behind your back' },
  { re: /enrich-cron|enrich-bank/, what: 'bank enrichment pass — spends Gemini and changes what Lina replies' },
  { re: /cron-if-primary/, what: 'failover cron guard — exists only to schedule other jobs' },
  { re: /LINA_ENRICH/, what: 'legacy atom-side enrichment line' },
  { re: /map:pull/, what: 'offline map rebuild' },
];

/**
 * A cron line that MUST be installed and running on the atom — never stripped,
 * and its ABSENCE is itself a defect. These carry live owner/customer data the
 * app would otherwise never receive; they touch no map, no search and no model.
 */
export const REQUIRED_SYNC: ReadonlyArray<{ re: RegExp; what: string }> = [
  {
    re: /hermes-price/,
    what: 'owner sync (every 5 min) — pushes each pending `price_changes` AND `address_changes` row from Lina\'s owner conversation through the T60 Hub to the app. Removing it freezes every published price and strands every owner-corrected address.',
  },
];

/** The boot line's own marker (`… & # LINA_ATOM`). */
export const BOOT_MARKER = 'LINA_ATOM';

export type CronKind = 'forbidden' | 'sync' | 'boot' | 'other';

export interface CronLine {
  /** The line exactly as it appears in the crontab. */
  raw: string;
  /** true = a real schedule. false = blank, or a comment (a PARKED schedule —
   *  still stripped, because an old cron line that is only commented out is one
   *  uncomment away from running again). */
  active: boolean;
  kind: CronKind;
  /** Why it is classified this way / what it would do. */
  why: string;
}

export function classifyCronLine(raw: string): CronLine {
  const trimmed = raw.trim();
  const active = trimmed.length > 0 && !trimmed.startsWith('#');

  // The boot exception is checked FIRST: it must never be mistaken for a job.
  if (/@reboot/.test(trimmed) && trimmed.includes(BOOT_MARKER)) {
    return {
      raw,
      active,
      kind: 'boot',
      why: 'boot autostart (not a job: no map work, no spend, no learning) — kept by default',
    };
  }

  // The owner sync is checked BEFORE the forbidden list. It is the one job that
  // must stay installed; a sweep that cannot tell it from map work is how the
  // public prices went silent on 2026-10-14.
  for (const p of REQUIRED_SYNC) {
    if (p.re.test(trimmed)) return { raw, active, kind: 'sync', why: p.what };
  }

  for (const p of FORBIDDEN) {
    if (p.re.test(trimmed)) return { raw, active, kind: 'forbidden', why: p.what };
  }
  if (!active) return { raw, active, kind: 'other', why: 'comment/blank' };
  return { raw, active, kind: 'other', why: 'unrecognised line (left untouched)' };
}

export function classifyCrontab(text: string): CronLine[] {
  return text.split('\n').map(classifyCronLine);
}

/**
 * Remove every forbidden line from a crontab body, preserving unrelated lines
 * AND the required sync lines (and the trailing newline). `reboot: true` also
 * drops the boot line. Idempotent: stripping a stripped crontab changes nothing.
 */
export function stripForbidden(
  text: string,
  opts: { reboot?: boolean } = {},
): { text: string; removed: CronLine[] } {
  const removed: CronLine[] = [];
  const kept: string[] = [];
  for (const line of classifyCrontab(text)) {
    const drop = line.kind === 'forbidden' || (opts.reboot === true && line.kind === 'boot');
    if (drop) removed.push(line);
    else kept.push(line.raw);
  }
  // Re-trim ONLY the trailing blank lines the split produced, so a crontab with
  // no entries left reads as empty instead of a run of newlines.
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  return { text: kept.length === 0 ? '' : kept.join('\n') + '\n', removed };
}

/** The lines that make a machine non-compliant (for --check and reporting). */
export function violations(text: string): CronLine[] {
  return classifyCrontab(text).filter(l => l.kind === 'forbidden');
}

/** The sync lines actually installed and ACTIVE on this machine. */
export function installedSync(text: string): CronLine[] {
  return classifyCrontab(text).filter(l => l.kind === 'sync' && l.active);
}

/**
 * A required sync job that is NOT installed (or only parked as a comment).
 * Empty means every owner-facing sync is running. `--require-sync` turns a
 * non-empty result into a failure — that check is what stops a future cleanup
 * from silently deleting the atom's price sync again.
 */
export function missingSync(text: string): Array<{ re: RegExp; what: string }> {
  const lines = classifyCrontab(text);
  return REQUIRED_SYNC.filter(req =>
    !lines.some(l => l.kind === 'sync' && l.active && req.re.test(l.raw)),
  );
}

/** The policy, in one string — printed by --check/--remove/--install alike. */
export const POLICY =
  'NO MAP JOB IS SCHEDULED: the map is a fixed artifact — finished and deployed by a human, '
  + 'and unchanged until a human runs the SerpApi pass again. The atom\'s owner sync '
  + '(*/5 hermes-price.sh) is the one job that must stay: it carries the owner\'s price AND '
  + 'address corrections to the app.';
