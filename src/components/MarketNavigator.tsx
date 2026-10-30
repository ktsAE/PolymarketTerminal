import { useEffect, useMemo, useRef, useState } from 'react';
import type { Instrument, LeagueMarketsPage, MarketLeague, TerminalBridge } from '../types';
import { DATE_FILTERS, matchesDate, type DiscoveryFilters } from '../state/workspaceStore';
interface Props {
 bridge: TerminalBridge; instruments: Instrument[]; leagues: MarketLeague[]; favoriteIds: Set<string>; recentIds: string[]; openIds: string[];
 filters: DiscoveryFilters; onFilters(value: DiscoveryFilters): void; onItems(items: Instrument[]): void; onOpen(item: Instrument): void;
 onFavorite(id: string): void; onClearRecent(): void;
}
export function localStartLabel(value?: string) {
 const date = value ? new Date(value) : null;
 if (!date || !Number.isFinite(date.getTime())) return 'START TBA';
 const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
 if (matchesDate(value, 'Today')) return `TODAY · ${time}`;
 if (matchesDate(value, 'Tomorrow')) return `TOMORROW · ${time}`;
 return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
const eventKey = (item: Instrument) => item.eventId || item.eventTitle;
export function MarketNavigator({ bridge, instruments, leagues, favoriteIds, recentIds, openIds, filters, onFilters, onItems, onOpen, onFavorite, onClearRecent }: Props) {
 const [query, setQuery] = useState('');
 const [view, setView] = useState<'Leagues' | 'Favorites' | 'Recent'>('Leagues');
 const [expanded, setExpanded] = useState(new Set<string>());
 const [pages, setPages] = useState(new Map<string, LeagueMarketsPage>());
 const pageCache = useRef(new Map<string, LeagueMarketsPage>());
 const flights = useRef(new Set<string>());
 const [busy, setBusy] = useState(new Set<string>());
 const [errors, setErrors] = useState(new Map<string, string>());
 const [limits, setLimits] = useState<Record<string, number>>({});
 const [searchLimit, setSearchLimit] = useState(50);
 const [context, setContext] = useState<Instrument>();
 const initialized = useRef(false);
 const load = async (id: string, more = false) => {
  const previous = pageCache.current.get(id);
  if (flights.current.has(id) || (!more && previous) || (more && previous?.completeness === 'EXHAUSTED')) return;
  flights.current.add(id); setBusy(new Set(flights.current));
  setErrors(current => { const next = new Map(current); next.delete(id); return next; });
  try {
   const page = await bridge.listLeagueMarketsPage({ seriesId: id, ...(more && previous?.nextCursor ? { cursor: previous.nextCursor } : {}) });
   pageCache.current.set(id, page);
   setPages(new Map(pageCache.current)); onItems(page.items);
  } catch (error) { setErrors(current => new Map(current).set(id, error instanceof Error ? error.message : 'Could not load league')); }
  finally { flights.current.delete(id); setBusy(new Set(flights.current)); }
 };
 useEffect(() => {
  if (initialized.current || !leagues.length) return;
  initialized.current = true;
  const favorites = leagues.filter(item => favoriteIds.has(item.seriesId));
  const initial = favorites.length ? favorites : [leagues.find(item => item.slug === 'nba') ?? leagues[0]];
  setExpanded(new Set(initial.map(item => item.seriesId)));
  initial.forEach(item => void load(item.seriesId));
 }, [leagues]);
 const unresolvedRecent = useRef(new Set<string>());
 useEffect(() => {
  if (view !== 'Recent') return;
  const missing = recentIds.filter(id => !instruments.some(item => item.assetId === id) && !unresolvedRecent.current.has(id));
  if (!missing.length || !bridge.resolveInstruments) return;
  missing.forEach(id => unresolvedRecent.current.add(id));
  void bridge.resolveInstruments({ assetIds: missing }).then(results => onItems(results.flatMap(result => result.status === 'RESOLVED' && result.instrument ? [result.instrument] : []))).catch(() => undefined);
 }, [view, recentIds, instruments]);
 const needle = query.trim().toLowerCase();
 const scope = instruments.filter(item => view === 'Favorites' ? Boolean(item.leagueId && favoriteIds.has(item.leagueId)) : view === 'Recent' ? recentIds.includes(item.assetId) : true);
 const dateMissing = scope.filter(item => !item.startTime || !Number.isFinite(new Date(item.startTime).getTime())).length;
 const filtered = scope.filter(item => matchesDate(item.startTime, filters.date) && (filters.marketType === 'all' || item.sportsMarketType === filters.marketType));
 const results = useMemo(() => needle ? filtered.filter(item => `${item.leagueName ?? ''} ${item.eventTitle} ${item.marketTitle} ${item.outcome} ${item.tags.join(' ')}`.toLowerCase().includes(needle)) : [], [instruments, needle, view, favoriteIds, recentIds, filters]);
 const more = (key: string) => setLimits(current => ({ ...current, [key]: (current[key] ?? 20) + 20 }));
 const showContext = (item: Instrument) => {
  setContext(item); setView('Leagues'); setQuery('');
  if (item.leagueId) setExpanded(current => new Set(current).add(item.leagueId!));
 };
 const leagueList = [...leagues];
 if (context?.leagueId && !leagueList.some(item => item.seriesId === context.leagueId)) leagueList.push({ id: context.leagueId, seriesId: context.leagueId, name: context.leagueName ?? context.leagueId, slug: context.leagueSlug ?? context.leagueId });
 return <>
  <div className="drawer-heading"><span>SPORTS NAVIGATOR</span><span>{leagues.length} LEAGUES</span></div>
  <div className="search-wrap"><span>⌕</span><input className="market-search" aria-label="Search loaded markets" placeholder="Search loaded markets" value={query} onChange={event => { setQuery(event.target.value); setSearchLimit(50); }} />{query && <button aria-label="Clear search" onClick={() => setQuery('')}>×</button>}</div>
  <div className="discovery-filters"><label>Date <select aria-label="Date filter" value={filters.date} onChange={event => onFilters({ ...filters, date: event.target.value as DiscoveryFilters['date'] })}>{DATE_FILTERS.map(date => <option key={date}>{date}</option>)}</select></label><label>Market type <select aria-label="Market type filter" value={filters.marketType} onChange={event => onFilters({ ...filters, marketType: event.target.value })}><option value="all">All types</option>{[...new Set(instruments.flatMap(item => item.sportsMarketType ? [item.sportsMarketType] : [])), ...(filters.marketType !== 'all' && !instruments.some(item => item.sportsMarketType === filters.marketType) ? [filters.marketType] : [])].sort().map(type => <option key={type}>{type}</option>)}</select></label></div>
  {filters.date !== 'All' && <div className="league-state">{dateMissing} outcomes excluded: start time missing</div>}
  <div className="market-view-tabs">{(['Leagues','Favorites','Recent'] as const).map(tab => <button key={tab} className={view === tab ? 'active' : ''} onClick={() => setView(tab)}>{tab === 'Favorites' ? `★ Favorites ${favoriteIds.size}` : tab}</button>)}</div>
  <div className="market-list">
   {needle && <section className="search-results" aria-label="Loaded search results"><header>{results.length} loaded matches · {scope.length} loaded outcomes</header><p className="league-state">Search loaded markets only. Open a league and load more to search its schedule.</p>{results.slice(0,searchLimit).map(item => <div className="search-match" key={item.assetId}><button aria-label={`Show in context: ${item.marketTitle} · ${item.outcome}`} onClick={() => showContext(item)}><span>{item.leagueName ?? item.category} · {localStartLabel(item.startTime)}</span><strong>{item.marketTitle}</strong><i>{item.outcome}</i></button><button onClick={() => onOpen(item)}>Open book</button></div>)}{results.length > searchLimit && <button onClick={() => setSearchLimit(value => value + 50)}>Show more</button>}</section>}
   {view === 'Recent' && <><button onClick={onClearRecent}>Clear recent (local)</button>{!recentIds.length && <div className="drawer-message">Open a market outcome and it will appear here.</div>}{!needle && filtered.map(item => <button className="recent-market" key={item.assetId} onClick={() => onOpen(item)}><span>{item.leagueName} · {localStartLabel(item.startTime)}</span><strong>{item.marketTitle}</strong><i>{item.outcome}</i></button>)}</>}
   {view !== 'Recent' && leagueList.filter(league => view !== 'Favorites' || favoriteIds.has(league.seriesId)).map(league => {
    const id = league.seriesId;
    const leagueItems = filtered.filter(item => item.leagueId === id);
    if (context?.leagueId === id && !leagueItems.some(item => item.assetId === context.assetId)) leagueItems.push(context);
    const groups = new Map<string, Instrument[]>();
    leagueItems.forEach(item => groups.set(eventKey(item), [...(groups.get(eventKey(item)) ?? []), item]));
    const events = [...groups.entries()].sort((a,b) => (new Date(a[1][0].startTime ?? '').getTime() || Infinity) - (new Date(b[1][0].startTime ?? '').getTime() || Infinity));
    const eventLimit = limits[`league:${id}`] ?? 20;
    const visibleEvents = events.filter(([key], index) => index < eventLimit || (context?.leagueId === id && key === eventKey(context)));
    return <section key={id} className={`league-node ${expanded.has(id) ? 'expanded' : ''}`}><div className="league-header" role="button" tabIndex={0} onClick={() => { setExpanded(current => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; }); void load(id); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.currentTarget.click(); } }}><span className="league-chevron">{expanded.has(id) ? '▾' : '▸'}</span>{league.image ? <img src={league.image} alt="" /> : <i>{league.name.slice(0, 2).toUpperCase()}</i>}<div><strong>{league.name}</strong><span>{events.length} loaded events · {leagueItems.length} outcomes</span></div><button className={`league-star ${favoriteIds.has(id) ? 'active' : ''}`} aria-label={favoriteIds.has(id) ? `Remove ${league.name} from favorites` : `Favorite ${league.name}`} onClick={event => { event.stopPropagation(); onFavorite(id); void load(id); }}>★</button></div>
    {expanded.has(id) && <div className="league-events">{visibleEvents.map(([key, items]) => {
     const contracts = new Map<string, Instrument[]>(); items.forEach(item => contracts.set(item.conditionId, [...(contracts.get(item.conditionId) ?? []), item]));
     const marketKey = `event:${id}:${key}`;
     return <details className="event-node" key={key} open={context && eventKey(context) === key && context.leagueId === id ? true : undefined}><summary><div><strong>{items[0].eventTitle}</strong><time>{localStartLabel(items[0].startTime)}</time></div><span>{contracts.size} MKT</span></summary><div className="event-contracts">{[...contracts.values()].filter((contract,index) => index < (limits[marketKey] ?? 20) || contract.some(item => item.assetId === context?.assetId)).map(contract => <div className="contract-row" key={contract[0].conditionId}><span title={contract[0].marketTitle}>{contract[0].marketTitle}</span><div>{contract.map(item => <button key={item.assetId} className={openIds.includes(item.assetId) ? 'open' : ''} onClick={() => onOpen(item)}>{item.outcome}<b>{openIds.includes(item.assetId) ? '●' : '+'}</b></button>)}</div></div>)}{contracts.size > (limits[marketKey] ?? 20) && <button onClick={() => more(marketKey)}>Show 20 more markets</button>}</div></details>;
    })}{events.length > eventLimit && <button onClick={() => more(`league:${id}`)}>Show 20 more events</button>}
    {busy.has(id) && <div className="league-state">Loading {league.name} schedule…</div>}
    {errors.has(id) && <div className="league-state error">{errors.get(id)} <button onClick={() => void load(id, pages.has(id))}>Retry</button></div>}
    {!busy.has(id) && !errors.has(id) && pages.get(id)?.completeness !== 'EXHAUSTED' && <button onClick={() => void load(id, pages.has(id))}>{pages.has(id) ? 'Load more' : 'Load league'}</button>}
    {pages.get(id)?.completeness === 'UNKNOWN' && <div className="league-state">Completeness unknown · no total available</div>}
    {pages.get(id)?.completeness === 'EXHAUSTED' && <div className="league-state">All available pages loaded</div>}
    </div>}</section>;
   })}
  </div>
 </>;
}
