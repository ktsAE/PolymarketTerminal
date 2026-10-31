/**
 * Evidence ladder for suspected match-fixing / insider cases.
 *
 * The point of this module is to keep "proven" and "alleged" apart in code: a case can only
 * hold a tier its sources justify (see validateEvent), and tiers are time-stamped so a
 * backtest can ask "what was known at time T" without hindsight (see tierAsOf).
 */

export const TIERS = [
  'SANCTIONED', // final ruling by an integrity body, league operator, court or regulator, with published findings
  'ORGANIZER_ACTION', // organizer/operator punished participants but published no documentation
  'INVESTIGATING', // official investigation or provisional suspension, no finding yet
  'ALLEGED_CONCRETE', // named source presents checkable specifics (bet size/odds, clips, chats)
  'ALLEGED_UNSUPPORTED', // named person/outlet makes an allegation without artifacts others can check
  'RUMOR', // anonymous / community talk ("322" in chat), nothing checkable
  'CLEARED', // official body looked and found no violation
] as const;
export type EvidenceTier = (typeof TIERS)[number];

export type SourceKind =
  | 'integrity_body'
  | 'organizer'
  | 'league_operator'
  | 'court'
  | 'regulator'
  | 'journalism'
  | 'analyst_post'
  | 'player_statement'
  | 'community';

/** Kinds that can hold authority to sanction or clear. */
export const AUTHORITATIVE: readonly SourceKind[] = ['integrity_body', 'organizer', 'league_operator', 'court', 'regulator'];
/** Kinds that can make a named, accountable allegation. */
export const ALLEGING: readonly SourceKind[] = ['journalism', 'analyst_post', 'player_statement'];

export interface Source {
  /** Who originated the claim (not which website we read it on). */
  kind: SourceKind;
  /** Where we read it. */
  url: string;
  publishedAt?: string;
  retrievedAt: string;
  /** True only if the originator published findings/evidence we can read. */
  documented?: boolean;
  note?: string;
}

export type ClaimKind = 'bet_amount' | 'bet_odds' | 'odds_move' | 'gameplay' | 'communication' | 'financial_flow' | 'statement';
export interface Claim {
  kind: ClaimKind;
  text: string;
  amountUsd?: number;
  /** onchain/document = we or a published report confirmed it; contradicted = data disagrees. */
  verified: 'onchain' | 'document' | 'none' | 'contradicted';
}

export interface CaseEvent {
  /** Epoch ms when this tier became publicly known. */
  at: number;
  /** True when `at` is only approximately known (e.g. month precision). */
  approx?: boolean;
  tier: EvidenceTier;
  summary: string;
  sources: Source[];
  claims: Claim[];
}

/** Returns a list of problems; empty means the event's tier is justified by its sources. */
export function validateEvent(ev: CaseEvent): string[] {
  const errors: string[] = [];
  if (!TIERS.includes(ev.tier)) errors.push(`unknown tier ${ev.tier}`);
  if (!Number.isFinite(ev.at)) errors.push('at must be an epoch-ms number');
  if (!ev.summary.trim()) errors.push('summary required');
  if (ev.sources.length === 0) errors.push('at least one source required');
  const hasAuth = ev.sources.some((s) => AUTHORITATIVE.includes(s.kind));
  const hasAlleging = ev.sources.some((s) => ALLEGING.includes(s.kind));
  const concrete = ev.claims.some((c) => c.kind !== 'statement');
  switch (ev.tier) {
    case 'SANCTIONED':
      if (!ev.sources.some((s) => AUTHORITATIVE.includes(s.kind) && s.documented === true))
        errors.push('SANCTIONED needs an authoritative source with published findings (documented: true)');
      break;
    case 'ORGANIZER_ACTION':
    case 'INVESTIGATING':
    case 'CLEARED':
      if (!hasAuth) errors.push(`${ev.tier} needs an authoritative source`);
      break;
    case 'ALLEGED_CONCRETE':
      if (!hasAlleging) errors.push('ALLEGED_CONCRETE needs a named alleging source (journalism, analyst_post, player_statement)');
      if (!concrete) errors.push('ALLEGED_CONCRETE needs at least one checkable claim (not just a statement)');
      break;
    case 'ALLEGED_UNSUPPORTED':
      if (!hasAlleging) errors.push('ALLEGED_UNSUPPORTED needs a named alleging source');
      break;
    case 'RUMOR':
      break;
  }
  return errors;
}

/** The case's state as publicly known at `asOf` (latest event not after it). */
export function tierAsOf(events: readonly CaseEvent[], asOf: number): CaseEvent | undefined {
  let best: CaseEvent | undefined;
  for (const ev of events) if (ev.at <= asOf && (!best || ev.at >= best.at)) best = ev;
  return best;
}

export type LabelClass = 'positive' | 'negative' | 'weak';
/** How a backtest should treat a case: only sanctioned/organizer actions are positives. */
export function labelClass(tier: EvidenceTier): LabelClass {
  if (tier === 'SANCTIONED' || tier === 'ORGANIZER_ACTION') return 'positive';
  if (tier === 'CLEARED') return 'negative';
  return 'weak';
}

export const TIER_TEXT: Record<EvidenceTier, string> = {
  SANCTIONED: 'PROVEN: final ruling with published findings',
  ORGANIZER_ACTION: 'PUNISHED: organizer acted, no documentation published',
  INVESTIGATING: 'UNDER INVESTIGATION: no finding yet',
  ALLEGED_CONCRETE: 'ALLEGED: checkable specifics presented, unconfirmed',
  ALLEGED_UNSUPPORTED: 'ALLEGED: no checkable artifacts',
  RUMOR: 'RUMOR: community talk only',
  CLEARED: 'CLEARED: official body found no violation',
};
