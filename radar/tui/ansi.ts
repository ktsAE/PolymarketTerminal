// Minimal ANSI helpers: width-aware fit/clip so colored table cells never overflow a line.

const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g');

export const c = {
  reset: `${ESC}[0m`,
  bold: (s: string) => `${ESC}[1m${s}${ESC}[22m`,
  dim: (s: string) => `${ESC}[2m${s}${ESC}[22m`,
  red: (s: string) => `${ESC}[31m${s}${ESC}[39m`,
  green: (s: string) => `${ESC}[32m${s}${ESC}[39m`,
  yellow: (s: string) => `${ESC}[33m${s}${ESC}[39m`,
  blue: (s: string) => `${ESC}[34m${s}${ESC}[39m`,
  magenta: (s: string) => `${ESC}[35m${s}${ESC}[39m`,
  cyan: (s: string) => `${ESC}[36m${s}${ESC}[39m`,
  gray: (s: string) => `${ESC}[90m${s}${ESC}[39m`,
  inverse: (s: string) => `${ESC}[7m${s}${ESC}[27m`,
  bg: (n: number, s: string) => `${ESC}[48;5;${n}m${s}${ESC}[49m`,
};

export const strip = (s: string): string => s.replace(ANSI_RE, '');

/** Terminal cell width of one code point. */
export function charWidth(cp: number): number {
  if (cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x2060) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}

/** Visible width of a string (ANSI sequences ignored). */
export function vlen(s: string): number {
  let w = 0;
  for (const ch of strip(s)) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

/** Truncates plain text to `w` cells, adding an ellipsis when it had to cut. */
export function truncate(s: string, w: number): string {
  if (w <= 0) return '';
  if (vlen(s) <= w) return s;
  let out = '';
  let used = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (used + cw > w - 1) break;
    out += ch;
    used += cw;
  }
  return out + '…';
}

/** Pads or truncates PLAIN text to exactly `w` cells (colour it afterwards). */
export function fit(s: string, w: number, align: 'left' | 'right' = 'left'): string {
  const t = truncate(s.replace(/\s+/g, ' '), w);
  const pad = ' '.repeat(Math.max(0, w - vlen(t)));
  return align === 'right' ? pad + t : t + pad;
}

/** Cuts a possibly-coloured line to `w` visible cells without breaking escape sequences. */
export function clip(line: string, w: number): string {
  if (vlen(line) <= w) return line;
  let out = '';
  let used = 0;
  let i = 0;
  while (i < line.length) {
    if (line[i] === ESC) {
      const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(line.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const cp = line.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (used + cw > w) break;
    out += ch;
    used += cw;
    i += ch.length;
  }
  return out + c.reset;
}

const BLOCKS = '▁▂▃▄▅▆▇█';
/** Compact trend line; flat series render as a mid-height bar. */
export function sparkline(values: readonly number[], width: number): string {
  if (values.length === 0 || width <= 0) return '';
  const pts: number[] = [];
  for (let i = 0; i < Math.min(width, values.length); i++) pts.push(values[Math.floor((i * values.length) / Math.min(width, values.length))]);
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  if (hi === lo) return BLOCKS[3].repeat(pts.length);
  return pts.map((v) => BLOCKS[Math.min(7, Math.floor(((v - lo) / (hi - lo)) * 8))]).join('');
}
