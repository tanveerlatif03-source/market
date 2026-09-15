/**
 * What the work cost (Q15).
 *
 * On a subscription there is no per-task dollar figure, and inventing one is
 * worse than showing nothing. Money is real in three separate ways, and the
 * rule that matters is that they are never added together:
 *
 *   metered   — Agora brokered the call and knows to the cent.
 *   reported  — the tool volunteered its token count. Its word, not ours.
 *   quota     — what actually runs out for a developer on a plan.
 *
 * A single blended total would hide exactly the difference that makes the
 * number worth anything. So `CostReport` has no `total` field, and cannot grow
 * one without someone deciding to lie.
 *
 * Action caps live elsewhere, on the lane. They are the backstop, because
 * actions are the one thing countable with certainty.
 */

export type CostProvenance = 'metered' | 'reported' | 'quota';

export interface CostEntry {
  id: string;
  laneId: string | null;
  /** The agent whose work this was. */
  agentId: string;
  provenance: CostProvenance;
  /**
   * The number. Its meaning depends on `unit`, which is why nothing here ever
   * adds entries of different units together either.
   */
  amount: number;
  /** "usd-cents", "tokens", "requests", "messages" — whatever was counted. */
  unit: string;
  /** For quota: how much there was to begin with. Null for the other two. */
  limit: number | null;
  note: string;
  at: string;
}

export interface CostLine {
  provenance: CostProvenance;
  unit: string;
  amount: number;
  /** Only ever set for quota, which is the only one with a ceiling. */
  limit: number | null;
  entries: number;
  /** How much to trust it, said plainly rather than implied by a decimal place. */
  confidence: string;
}

/**
 * Deliberately has no `total`. Three provenances, each with its own units,
 * each standing on its own.
 */
export interface CostReport {
  laneId: string | null;
  lines: CostLine[];
  /** Said out loud so nobody reads the lines as a bill. */
  caveat: string;
}

const CONFIDENCE: Record<CostProvenance, string> = {
  metered: 'Agora made these calls and counted them. Exact.',
  reported: 'The tool volunteered this. It is their count, not ours.',
  quota: 'What runs out on the plan. The thing that actually stops the work.'
};

const NO_COST =
  'Nothing has been counted for this work yet. That is not the same as it being free.';

const CAVEAT =
  'These do not add up, on purpose: they are three different things counted three ' +
  'different ways. Anything presented as one number would be made up.';

/** Everything counted for one lane, or for the room when `laneId` is null. */
export function costReport(
  entries: readonly CostEntry[],
  laneId: string | null = null
): CostReport {
  const scoped = laneId === null ? entries : entries.filter((entry) => entry.laneId === laneId);

  // Grouped by provenance *and* unit: tokens and requests are not the same
  // number either, even when the same tool reported both.
  const groups = new Map<string, CostLine>();
  for (const entry of scoped) {
    const key = `${entry.provenance}:${entry.unit}`;
    const line = groups.get(key);
    if (line === undefined) {
      groups.set(key, {
        provenance: entry.provenance,
        unit: entry.unit,
        amount: entry.amount,
        limit: entry.provenance === 'quota' ? entry.limit : null,
        entries: 1,
        confidence: CONFIDENCE[entry.provenance]
      });
      continue;
    }
    line.entries += 1;
    if (entry.provenance === 'quota') {
      // A quota is a level, not a running total: the latest reading wins.
      line.amount = entry.amount;
      line.limit = entry.limit;
    } else {
      line.amount += entry.amount;
    }
  }

  const order: CostProvenance[] = ['metered', 'reported', 'quota'];
  const lines = [...groups.values()].sort((a, b) => {
    const byProvenance = order.indexOf(a.provenance) - order.indexOf(b.provenance);
    return byProvenance !== 0 ? byProvenance : a.unit.localeCompare(b.unit);
  });

  return { laneId, lines, caveat: lines.length === 0 ? NO_COST : CAVEAT };
}

/** One line for a table cell, without ever implying a total (Q19). */
export function summarizeCost(report: CostReport): string {
  if (report.lines.length === 0) return 'not counted';
  return report.lines
    .map((line) =>
      line.provenance === 'quota' && line.limit !== null
        ? `${line.amount}/${line.limit} ${line.unit} (quota)`
        : `${line.amount} ${line.unit} (${line.provenance})`
    )
    .join(' · ');
}

/** A quota reading that has run out, or is about to. What actually stops work. */
export function quotaWarnings(report: CostReport, atFraction = 0.9): string[] {
  return report.lines
    .filter(
      (line) => line.provenance === 'quota' && line.limit !== null && line.limit > 0
    )
    .filter((line) => line.amount / (line.limit as number) >= atFraction)
    .map(
      (line) =>
        `${line.amount} of ${line.limit} ${line.unit} used. This is what runs out, and it ` +
        'stops the work rather than costing more.'
    );
}
