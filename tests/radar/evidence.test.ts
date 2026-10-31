import { describe, expect, it } from 'vitest';
import { SEED_CASES } from '../../radar/cases.seed';
import { labelClass, tierAsOf, validateEvent, type CaseEvent, type Source } from '../../radar/evidence';

const src = (kind: Source['kind'], documented?: boolean): Source => ({ kind, url: 'https://example.test', retrievedAt: '2026-10-31', documented });
const ev = (over: Partial<CaseEvent>): CaseEvent => ({ at: 1, tier: 'RUMOR', summary: 's', sources: [src('community')], claims: [], ...over });

describe('evidence ladder', () => {
  it('only lets an authoritative, documented source justify SANCTIONED', () => {
    expect(validateEvent(ev({ tier: 'SANCTIONED', sources: [src('integrity_body', true)] }))).toEqual([]);
    expect(validateEvent(ev({ tier: 'SANCTIONED', sources: [src('integrity_body', false)] }))).not.toEqual([]);
    expect(validateEvent(ev({ tier: 'SANCTIONED', sources: [src('journalism', true)] }))).not.toEqual([]);
    expect(validateEvent(ev({ tier: 'SANCTIONED', sources: [src('community', true)] }))).not.toEqual([]);
  });

  it('allows an undocumented organizer ban only as ORGANIZER_ACTION', () => {
    expect(validateEvent(ev({ tier: 'ORGANIZER_ACTION', sources: [src('organizer', false)] }))).toEqual([]);
    expect(validateEvent(ev({ tier: 'ORGANIZER_ACTION', sources: [src('analyst_post')] }))).not.toEqual([]);
  });

  it('needs a named accuser and a checkable claim for ALLEGED_CONCRETE', () => {
    const claim = { kind: 'bet_amount' as const, text: '$1', verified: 'none' as const };
    expect(validateEvent(ev({ tier: 'ALLEGED_CONCRETE', sources: [src('analyst_post')], claims: [claim] }))).toEqual([]);
    expect(validateEvent(ev({ tier: 'ALLEGED_CONCRETE', sources: [src('analyst_post')], claims: [{ ...claim, kind: 'statement' }] }))).not.toEqual([]);
    expect(validateEvent(ev({ tier: 'ALLEGED_CONCRETE', sources: [src('community')], claims: [claim] }))).not.toEqual([]);
    expect(validateEvent(ev({ tier: 'ALLEGED_UNSUPPORTED', sources: [src('player_statement')] }))).toEqual([]);
  });

  it('requires at least one source and a finite date', () => {
    expect(validateEvent(ev({ sources: [] }))).not.toEqual([]);
    expect(validateEvent(ev({ at: Number.NaN }))).not.toEqual([]);
  });

  it('answers "what was publicly known at time T" without hindsight', () => {
    const rumor = ev({ at: 100, tier: 'RUMOR' });
    const sanction = ev({ at: 300, tier: 'SANCTIONED', sources: [src('integrity_body', true)] });
    expect(tierAsOf([sanction, rumor], 50)).toBeUndefined();
    expect(tierAsOf([sanction, rumor], 200)?.tier).toBe('RUMOR');
    expect(tierAsOf([sanction, rumor], 300)?.tier).toBe('SANCTIONED');
  });

  it('treats only sanctions and organizer actions as positive labels', () => {
    expect(labelClass('SANCTIONED')).toBe('positive');
    expect(labelClass('ORGANIZER_ACTION')).toBe('positive');
    expect(labelClass('CLEARED')).toBe('negative');
    for (const t of ['INVESTIGATING', 'ALLEGED_CONCRETE', 'ALLEGED_UNSUPPORTED', 'RUMOR'] as const) expect(labelClass(t)).toBe('weak');
  });

  it('keeps every seeded case at a tier its sources justify', () => {
    for (const c of SEED_CASES) for (const e of c.events) expect(validateEvent(e), c.row.id).toEqual([]);
  });

  it('never seeds an alleged-only case as proven', () => {
    const proven = new Set(['nomercy-roman-imperium-vii', 'atox-falcons-epl20', 'playtime-liquid-ewc2026', 'nifee-epl22-prop-markets']);
    for (const c of SEED_CASES) {
      const last = [...c.events].sort((a, b) => a.at - b.at).at(-1)!;
      if (!proven.has(c.row.id)) expect(last.tier, c.row.id).not.toBe('SANCTIONED');
    }
  });
});
