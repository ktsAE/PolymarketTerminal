import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * A watchlist of people whose account names deserve a second look on a market: staff of a project, athletes, officials, known traders.
 * Matching uses what a Polymarket profile publishes (display name, pseudonym, linked X handle, bio). It never sees an e-mail: the API has no such field.
 * A match is a LEAD. Anyone can pick any display name, so it never identifies a person.
 */

export interface Person {
  name: string;
  org?: string;
  role?: string;
  aliases?: string[];
  /** X/Twitter handles, with or without the @. */
  handles?: string[];
  note?: string;
}

export const PEOPLE_PATH = process.env.RADAR_PEOPLE ?? '.radar/people.json';

export interface IdentityStrings {
  name: string | null;
  pseudonym: string | null;
  xUsername: string | null;
  bio: string | null;
}

export type MatchKind = 'HANDLE' | 'NAME' | 'CONTAINS' | 'FUZZY' | 'BIO';
export interface NameMatch {
  person: Person;
  kind: MatchKind;
  /** 100 = the profile's linked X handle is the person's known handle; 40 = only the bio mentions them. */
  score: number;
  field: 'linked X handle' | 'display name' | 'pseudonym' | 'bio';
  observed: string;
  why: string;
}

/** Lower-case letters and digits only, accents stripped: "José  O'Neil" and "joseoneil" compare equal. */
export const compact = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
export const similarity = (a: string, b: string): number => (!a.length && !b.length ? 1 : 1 - levenshtein(a, b) / Math.max(a.length, b.length));

/** Names shorter than this are too common to say anything ("john", "alex"). */
const MIN_NAME = 5;
const MIN_CONTAINS = 7;
const MIN_FUZZY = 6;
const FUZZY_AT = 0.86;
export const LEAD_SCORE = 60;

/** The strongest match per listed person, best first. */
export function matchPeople(id: IdentityStrings, people: readonly Person[]): NameMatch[] {
  const fields: Array<{ field: NameMatch['field']; value: string | null }> = [
    { field: 'linked X handle', value: id.xUsername },
    { field: 'display name', value: id.name },
    { field: 'pseudonym', value: id.pseudonym },
  ];
  const out: NameMatch[] = [];
  for (const p of people) {
    const names = [p.name, ...(p.aliases ?? [])].map((n) => ({ raw: n, c: compact(n) })).filter((n) => n.c.length >= MIN_NAME);
    const handles = (p.handles ?? []).map((h) => ({ raw: h.replace(/^@/, ''), c: compact(h.replace(/^@/, '')) })).filter((h) => h.c.length >= 3);
    const found: NameMatch[] = [];
    const offer = (kind: MatchKind, score: number, field: NameMatch['field'], observed: string, why: string) => found.push({ person: p, kind, score, field, observed, why });

    for (const { field, value } of fields) {
      if (!value) continue;
      const v = compact(value);
      if (v.length < 3) continue;
      const isHandle = field === 'linked X handle';
      for (const h of handles) {
        if (v === h.c) offer(isHandle ? 'HANDLE' : 'NAME', isHandle ? 100 : 85, field, value, `${field} "${value}" equals the known handle @${h.raw}`);
        else if (isHandle && v.length >= MIN_FUZZY && h.c.length >= MIN_FUZZY && similarity(v, h.c) >= 0.9) offer('FUZZY', 65, field, value, `${field} "${value}" is one or two characters from @${h.raw}`);
      }
      for (const n of names) {
        if (v === n.c) offer('NAME', isHandle ? 80 : 90, field, value, `${field} "${value}" equals "${n.raw}"`);
        else if (v.length >= MIN_CONTAINS && n.c.length >= MIN_CONTAINS && (v.includes(n.c) || n.c.includes(v))) offer('CONTAINS', 75, field, value, `${field} "${value}" contains or is contained in "${n.raw}"`);
        else if (v.length >= MIN_FUZZY && n.c.length >= MIN_FUZZY && similarity(v, n.c) >= FUZZY_AT) offer('FUZZY', 60, field, value, `${field} "${value}" is very close to "${n.raw}"`);
      }
    }
    if (id.bio) {
      const b = compact(id.bio);
      for (const n of names) if (n.c.length >= MIN_CONTAINS && b.includes(n.c)) offer('BIO', 40, 'bio', id.bio.slice(0, 60), `bio mentions "${n.raw}"`);
      for (const h of handles) if (h.c.length >= 5 && b.includes(h.c)) offer('BIO', 40, 'bio', id.bio.slice(0, 60), `bio mentions @${h.raw}`);
    }
    const best = found.sort((a, b) => b.score - a.score)[0];
    if (best) out.push(best);
  }
  return out.sort((a, b) => b.score - a.score);
}

export const describePerson = (p: Person): string => [p.name, [p.role, p.org].filter(Boolean).join(', ')].filter(Boolean).join(' - ');

export function loadPeople(path = PEOPLE_PATH): Person[] {
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const list = Array.isArray(raw) ? raw : (raw as { people?: unknown })?.people;
  if (!Array.isArray(list)) throw new Error(`${path}: expected a JSON array of people or { "people": [...] }`);
  return list.map((p, i) => {
    if (!p || typeof p.name !== 'string' || !p.name.trim()) throw new Error(`${path}: entry ${i} needs a "name"`);
    const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : undefined);
    return { name: p.name.trim(), org: p.org, role: p.role, aliases: strings(p.aliases), handles: strings(p.handles), note: p.note } as Person;
  });
}

export function savePeople(people: readonly Person[], path = PEOPLE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(people, null, 2) + '\n');
}

/** Adds a person, or merges aliases/handles into the entry with the same name. */
export function addPerson(person: Person, path = PEOPLE_PATH): Person[] {
  const people = loadPeople(path);
  const at = people.findIndex((p) => compact(p.name) === compact(person.name));
  if (at < 0) people.push(person);
  else {
    const old = people[at];
    people[at] = {
      ...old,
      ...Object.fromEntries(Object.entries(person).filter(([, v]) => v !== undefined && !Array.isArray(v))),
      aliases: [...new Set([...(old.aliases ?? []), ...(person.aliases ?? [])])],
      handles: [...new Set([...(old.handles ?? []), ...(person.handles ?? [])])],
    };
  }
  savePeople(people, path);
  return people;
}

export function removePerson(name: string, path = PEOPLE_PATH): boolean {
  const people = loadPeople(path);
  const kept = people.filter((p) => compact(p.name) !== compact(name));
  if (kept.length === people.length) return false;
  savePeople(kept, path);
  return true;
}
