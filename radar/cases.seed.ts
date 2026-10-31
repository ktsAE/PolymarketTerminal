import type { CaseEvent } from './evidence.ts';
import type { CaseRow } from './store.ts';

/**
 * Cases we have actually read about, at the tier their sources justify (see evidence.ts).
 * `retrievedAt` is when this file's author read the page; dates marked approx are not exact.
 * Add new cases with `node radar/cli.ts case-add` or here; never raise a tier without a source.
 */
const RETRIEVED = '2026-10-31';
const d = (iso: string) => Date.parse(iso);

export interface SeedCase {
  row: CaseRow;
  events: CaseEvent[];
}

export const SEED_CASES: SeedCase[] = [
  {
    row: {
      id: 'nomercy-roman-imperium-vii', title: 'NOMERCY, Roman Imperium Cup VII (CS2, Mar 28 2026)', game: 'CS2',
      tournament: 'Roman Imperium Cup VII', teams: ['NOMERCY'], matchAt: d('2026-03-28'),
      // comma-separated: one Polymarket event per match (the scheme spanned four matches)
      polymarketSlug: 'cs2-bb3-nomerc-2026-03-28,cs2-wc1-nomerc-2026-03-28,cs2-bst-nomerc-2026-03-28,cs2-sng2-nomerc-2026-03-28',
      notes: 'ESIC: betting intelligence found a high-value combination wager on a -9.5 round handicap across all four matches; every result met it. Five players sanctioned; 2xplayN upgraded to lifetime ban Oct 16 after posts while suspended.',
    },
    events: [
      {
        at: d('2026-10-15'), tier: 'SANCTIONED', summary: 'ESIC final sanctions against five NOMERCY players (kzy lifetime).',
        sources: [{ kind: 'integrity_body', url: 'https://esic.gg/sanction-outcome/esic-issues-sanctions-against-five-nomercy-participants', retrievedAt: RETRIEVED, documented: true, note: 'Details read via Dexerto/HLTV reports quoting ESIC; ESIC page itself not read in full.' }],
        claims: [{ kind: 'bet_amount', text: '~$57k accumulator on -9.5 round handicap across 4 matches, >$4.5M potential payout', amountUsd: 57_000, verified: 'document' }],
      },
    ],
  },
  {
    row: {
      id: 'atox-falcons-epl20', title: 'ATOX vs Team Falcons, ESL Pro League S20 (CS2)', game: 'CS2', tournament: 'ESL Pro League Season 20',
      teams: ['ATOX', 'Team Falcons'], matchAt: null, polymarketSlug: null,
      notes: 'ESIC flagged via SBAN alert, then statistical data from an anti-corruption supporter; admissions obtained.',
    },
    events: [
      {
        at: d('2025-05-15'), tier: 'SANCTIONED', summary: 'ESIC public report: 3 lifetime bans, others 8 months to 3 years (enforcement notice Apr 15 2025).',
        sources: [{ kind: 'integrity_body', url: 'http://staging.esic.gg/sanction-outcome/public-report-investigation-into-atox-esports', retrievedAt: RETRIEVED, documented: true }],
        claims: [{ kind: 'communication', text: 'Admissions to the charges extracted from three participants', verified: 'document' }],
      },
    ],
  },
  {
    row: {
      id: 'playtime-liquid-ewc2026', title: 'PlayTime vs Team Liquid, Dota 2 EWC 2026 (Jul 7)', game: 'Dota 2', tournament: 'Esports World Cup 2026',
      teams: ['PlayTime', 'Team Liquid'], matchAt: d('2026-07-07'), polymarketSlug: 'dota2-liquid-playti-2026-07-07',
      notes: 'Attempted fix: agreed outcome was a 0-2 PlayTime loss; the series ended 1-1, so the fix FAILED. Evidence cited by ESIC included draft/gameplay observation, device and financial data, multi-source betting intelligence.',
    },
    events: [
      {
        at: d('2026-07-14'), tier: 'INVESTIGATING', summary: 'ESIC opened an investigation and imposed provisional suspensions on Vintage and DarkMago.',
        sources: [{ kind: 'integrity_body', url: 'https://data.vptop.com/en/news/225-esic-confirms-ewc-match-fixing-violations-bans-vintage-for-life-and-darkmago-for-five-years', retrievedAt: RETRIEVED, documented: false, note: 'Read via vptop summary of ESIC statements' }],
        claims: [],
      },
      {
        at: d('2026-09-15'), approx: true, tier: 'SANCTIONED', summary: 'ESIC final: Vintage lifetime ban, DarkMago five years (backdated to Jul 14).',
        sources: [{ kind: 'integrity_body', url: 'https://data.vptop.com/en/news/225-esic-confirms-ewc-match-fixing-violations-bans-vintage-for-life-and-darkmago-for-five-years', retrievedAt: RETRIEVED, documented: true, note: 'Exact announcement date not confirmed (September inferred from the article asset path).' }],
        claims: [{ kind: 'financial_flow', text: 'Vintage agreed to receive a financial reward tied to a 0-2 loss', verified: 'document' }],
      },
    ],
  },
  {
    row: {
      id: 'united21-ctrl-9ine', title: 'CTRL vs 9INE Academy, United21 Group C (CS2, Oct 21 2026)', game: 'CS2', tournament: 'United21',
      teams: ['CTRL Esports', '9INE Academy'], matchAt: d('2026-10-21'), polymarketSlug: 'cs2-9inea-ctrles-2026-10-21',
      notes: 'Organizer cited suspicious activity, atypical behaviour, fair-play breaches and discrepancies in player information. No documentation published; CTRL and players have not commented. Polymarket resolved the market 50/50.',
    },
    events: [
      {
        at: d('2026-10-22'), tier: 'ORGANIZER_ACTION', summary: 'United21 disqualified CTRL, banned six players for life, annulled all CTRL results.',
        sources: [{ kind: 'organizer', url: 'https://www.esporthouse.eu/en/article/63881c71889309a852619bd3', retrievedAt: RETRIEVED, documented: false, note: 'Reported by Esport House; United21 published no evidence.' }],
        claims: [],
      },
    ],
  },
  {
    row: {
      id: 'united21-alliance-pea', title: 'Alliance vs Phantom Academy, United21 Group D (CS2, Aug 24 2026)', game: 'CS2', tournament: 'United21 Season 54',
      teams: ['Alliance', 'Phantom Esports Academy'], matchAt: d('2026-08-24'), polymarketSlug: 'cs2-all-phanto-2026-08-24',
      notes: 'The bet claim was verified on-chain (wallet 0x6d20c3...: 83 fills, 740,994 shares, cost $348,992, avg 0.471, proceeds $740,253). The FIX claim is unverified: no organizer or Valve investigation announced; the wallet traded 423 markets and 339 positions of $5k+ with a hit rate below its entry prices (z -2.2), consistent with a large professional bettor. Not an insider-wallet profile; not cleared either.',
    },
    events: [
      {
        at: d('2026-08-25'), approx: true, tier: 'ALLEGED_CONCRETE', summary: 'X user Feran flagged a >$348k in-play bet on the underdog after map 1; community alleges Alliance threw.',
        sources: [{ kind: 'journalism', url: 'https://temshik.ru/news/esports/alliance-obvinili-v-322-stavka-348-tysyach-united21-cs2', retrievedAt: RETRIEVED, documented: false, note: 'Publication date not read; original X post not retrieved. Clubs had not commented; no official investigation.' }],
        claims: [
          { kind: 'bet_amount', text: '>$348k on Phantom Academy after map 1, >$740k payout', amountUsd: 348_992, verified: 'onchain' },
          { kind: 'gameplay', text: 'Alliance (Valve #27) lost 1-2 to Phantom Academy (#164) at a non-VRS event', verified: 'none' },
        ],
      },
    ],
  },
  {
    row: {
      id: 'epl35-lixo-nemiga', title: 'LiXO vs Nemiga, European Pro League 35 (Dota 2, Mar 24 2026)', game: 'Dota 2', tournament: 'European Pro League 35',
      teams: ['LiXO eSports', 'Nemiga Gaming'], matchAt: d('2026-03-24'), polymarketSlug: 'dota2-nemiga-lixoes-2026-03-25',
      notes: 'Accuser is a former coach/analyst. The accused stand-in player denies intent. Polymarket event exists but traded $0, so no on-chain check is possible. The bet venue is unnamed.',
    },
    events: [
      {
        at: d('2026-03-26'), tier: 'ALLEGED_CONCRETE', summary: 'Analyst Ahilles accused stand-in zvezd of throwing and cited ~$79.5k bet on LiXO 0:2 at 1.82 (~$144.6k payout).',
        sources: [{ kind: 'analyst_post', url: 'https://cyberscore.live/en/news/ex-1win-coach-ahilles-accuses-zvezd-322', publishedAt: '2026-03-26', retrievedAt: RETRIEVED, documented: false, note: 'Cyberscore reports no official evidence or investigation.' }],
        claims: [
          { kind: 'bet_amount', text: '$79,500 on LiXO to lose 0:2 at odds 1.82', amountUsd: 79_500, verified: 'none' },
          { kind: 'gameplay', text: 'Solo run into enemy Tier 3 tower at half HP, died, bought back after the fight ended', verified: 'none' },
        ],
      },
    ],
  },
  {
    row: {
      id: 'six666-roman-imperium-viii', title: '6666 players allege an order to throw (Roman Imperium Cup VIII)', game: 'CS2', tournament: 'Roman Imperium Cup VIII',
      teams: ['6666'], matchAt: null, polymarketSlug: null,
      notes: 'First-hand claim by players that management asked them to fix matches, then called it a test. No artifacts shown; organisation has not responded in the source.',
    },
    events: [
      {
        at: d('2026-10-15'), tier: 'ALLEGED_UNSUPPORTED', summary: 'Five players left 6666 alleging a match-fixing request and unpaid wages.',
        sources: [{ kind: 'player_statement', url: 'https://livecyberscore.com/news/6666-players-walk-out-allege-match-fixing-request-and-unpaid-wages-668655', publishedAt: '2026-10-15', retrievedAt: RETRIEVED, documented: false }],
        claims: [{ kind: 'statement', text: 'A man described as the founder\'s right hand told a player the team needed to start fixing matches', verified: 'none' }],
      },
    ],
  },
  {
    row: {
      id: 'nifee-epl22-prop-markets', title: 'nifee (Inner Circle), ESL Pro League S22: manipulated in-game proposition markets (CS2)', game: 'CS2',
      tournament: 'ESL Pro League Season 22', teams: ['Inner Circle'], matchAt: null, polymarketSlug: null,
      notes: 'ESIC found repeated deaths to molotovs/incendiaries coinciding with unusual betting-volume spikes on that in-game outcome market. ESIC stated the bets came from newly created, dormant, high-value accounts outside the expected baseline for that market: the fresh-wallet fingerprint, on sportsbooks. Player admitted the conduct; sanction cut from five to four years for cooperation (Oct 21 2025 - Oct 20 2029).',
    },
    events: [
      {
        at: d('2026-04-01'), tier: 'SANCTIONED', summary: 'ESIC four-year ban for match manipulation and betting-related corruption.',
        sources: [{ kind: 'integrity_body', url: 'https://esic.gg/sanction-outcome/esic-issues-four-year-sanction-to-dmytro-nifee-tediashvili-for-match-manipulation-and-betting-related-corruption/', publishedAt: '2026-04-01', retrievedAt: RETRIEVED, documented: true, note: 'Read via HLTV report quoting the ESIC press release; ESIC page not opened directly.' }],
        claims: [
          { kind: 'odds_move', text: 'Unusual spikes in betting volume on the relevant in-game outcome market', verified: 'document' },
          { kind: 'financial_flow', text: 'Bets from newly created, dormant, high-value accounts outside the market baseline', verified: 'document' },
          { kind: 'communication', text: 'Player ultimately admitted the conduct', verified: 'document' },
        ],
      },
    ],
  },
  {
    row: {
      id: 'acidhouze-pgl-bucharest-oq', title: 'acidhouze vs Inner Circle Academy, PGL Bucharest 2027 open qualifier (CS2): suspected radar hack, betting angle', game: 'CS2',
      tournament: 'PGL Bucharest 2027 Open Qualifier', teams: ['acidhouze', 'Inner Circle Academy'], matchAt: d('2026-10-11'), polymarketSlug: null,
      notes: 'A cheating case, not a throw, but the same integrity pipeline: Inner Circle Academy forfeited "so the cheaters couldn\'t profit from betting", posting gameplay video. PGL then disqualified acidhouze and the qualifier is to be replayed. PGL published no evidence in what we read. Shows tier progression in 24 hours.',
    },
    events: [
      {
        at: d('2026-10-11'), tier: 'ALLEGED_CONCRETE', summary: 'Inner Circle (X, Oct 11) posted gameplay video of an acidhouze player and asked PGL and ESIC to act; academy forfeited the match.',
        sources: [{ kind: 'player_statement', url: 'https://community.skin.club/en/news/pgl-disqualifies-team-for-cheating-qualifier-to-be-replayed', publishedAt: '2026-10-11', retrievedAt: RETRIEVED, documented: false, note: 'Original X post (@InCircleEsports) not retrieved; quoted by skin.club and cybersports.live.' }],
        claims: [{ kind: 'gameplay', text: 'Video of suspicious gameplay; one account allegedly permanently banned on FACEIT since 2023', verified: 'none' }],
      },
      {
        at: d('2026-10-12'), tier: 'ORGANIZER_ACTION', summary: 'PGL disqualified acidhouze for competitive integrity concerns; qualifier to be replayed.',
        sources: [{ kind: 'organizer', url: 'https://community.skin.club/en/news/pgl-disqualifies-team-for-cheating-qualifier-to-be-replayed', retrievedAt: RETRIEVED, documented: false, note: 'Reported via skin.club and Inner Circle statement; PGL statement not read. Date approximate (cybersports.live piece dated Oct 12).' }],
        claims: [], approx: true,
      },
    ],
  },
  {
    row: {
      id: 'benched-gods-cct-series6', title: 'Benched Gods, CCT Challengers Europe Series 6 (CS2): radar hack and match-fixing allegations', game: 'CS2',
      tournament: 'CCT 2026 Challengers Europe Series 6', teams: ['Benched Gods', 'Inner Circle Academy'], matchAt: d('2026-09-07'), polymarketSlug: null,
      notes: 'Allegation by a rival organization with video and links to other teams\' complaints, and a call for ESIC to investigate. The earlier disqualification (VRS GLuck Yungstar closed qualifier) and the July CYBERSHOKE bans are reported only second-hand through this statement. No ESIC finding found.',
    },
    events: [
      {
        at: d('2026-09-07'), tier: 'ALLEGED_CONCRETE', summary: 'Inner Circle publicly accused Benched Gods of radar hack and match-fixing and asked ESIC to investigate.',
        sources: [{ kind: 'player_statement', url: 'https://players.com.ua/en/news/inner-circle-accuses-benched-gods-of-using-a-radar-hack-and-calls-on-esic-to-investigate/', publishedAt: '2026-09-07', retrievedAt: RETRIEVED, documented: false }],
        claims: [{ kind: 'gameplay', text: 'Video evidence and links to complaints from other teams', verified: 'none' }],
      },
    ],
  },
];
