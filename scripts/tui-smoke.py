#!/usr/bin/env python3
"""Drives the real radar TUI through a pseudo-terminal against live Polymarket data.

Checks what unit tests cannot: raw mode, the alternate screen, keystrokes, background polling, a clean quit.
Usage: python3 scripts/tui-smoke.py        (needs network; several minutes: decision, edge, new-market and jump scans run live)
Exit code 0 = every check passed.
"""
import os, pty, re, select, signal, struct, sys, time, fcntl, termios

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COLS, ROWS = 150, 40
DB = os.path.join(os.environ.get("TMPDIR", "/tmp"), "radar-tui-smoke.db")
for suffix in ("", "-wal", "-shm"):
    try: os.remove(DB + suffix)
    except FileNotFoundError: pass

pid, fd = pty.fork()
if pid == 0:
    os.chdir(ROOT)
    os.execvpe("node", ["node", "--no-warnings", "radar/cli.ts", "tui", "--no-news"], dict(os.environ, RADAR_DB=DB, RADAR_WALLETS=os.path.join(os.environ.get("TMPDIR", "/tmp"), "radar-smoke-wallets.json"), TERM="xterm-256color"))
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
os.kill(pid, signal.SIGWINCH)
stream = b""

def pump(sec):
    global stream
    end = time.time() + sec
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try: stream += os.read(fd, 65536)
            except OSError: return

def alive():
    try: return os.waitpid(pid, os.WNOHANG) == (0, 0)
    except ChildProcessError: return False

def screen():
    scr, row = [""] * ROWS, None
    for m in re.finditer(r"\x1b\[(\d+);1H|(\x1b\[[0-9;?]*[A-Za-z])|([^\x1b]+)", stream.decode("utf8", "ignore")):
        if m.group(1): row = int(m.group(1)) - 1; scr[row] = ""
        elif row is not None and 0 <= row < ROWS:
            if m.group(3): scr[row] += m.group(3)
            elif m.group(2) in ("\x1b[7m", "\x1b[27m"): scr[row] += m.group(2)
    return scr

plain = lambda s: re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", s)
selected = lambda: [i for i, l in enumerate(screen()) if "\x1b[7m" in l and i > 2]
failures = []
def check(name, ok):
    print(("PASS " if ok else "FAIL ") + name)
    if not ok: failures.append(name)

t0 = time.time()
while time.time() - t0 < 60:
    pump(1)
    if re.search(r"\b(WATCH|HOT)\b", plain("\n".join(screen()))): break
check("rows appear within 30s of launch", time.time() - t0 < 30)
first = selected()
check("a row is selected initially", len(first) == 1)
os.write(fd, b"\x1b[B"); pump(0.8)
check("down arrow moves the selection down", selected() == [first[0] + 1] if first else False)
os.write(fd, b"\x1b[A"); pump(0.8)
check("up arrow moves it back", selected() == first)
os.write(fd, b"2"); pump(1.0)
check("tab 2 shows games", "GAME" in plain(screen()[2]) and "STARTS" in plain(screen()[2]))
os.write(fd, b"1"); pump(0.8); os.write(fd, b"o"); pump(0.8)
check("o shows the selected event link in the footer", "polymarket.com/event/" in plain(screen()[ROWS - 1]))

# holders: open the selected event's top holders and wait for profiling to finish
os.write(fd, b"h"); pump(1.0)
check("h opens the holders tab", "4 Holders" in plain(screen()[1]))
t1 = time.time()
while time.time() - t1 < 60:
    pump(1)
    if "WHO" in plain(screen()[2]) or "WHO" in plain(screen()[3]): 
        if "profiling" not in plain("\n".join(screen()[:4])): break
text = plain("\n".join(screen()[:ROWS]))
check("holders table has its columns", "POSITION" in text and "ALL-TIME" in text)
check("holders profiling finished", "profiling" not in text)
check("holders table has at least one row or explains why not", len([l for l in screen()[4:30] if plain(l).strip()]) > 0)
os.write(fd, b"b"); pump(0.8)
check("b toggles bots and market makers", "bots and market makers" in plain(screen()[ROWS - 1]) or "people only" in plain(screen()[ROWS - 1]))
check("holders table has the account-created column", "CREATED" in text)

# decision: open it for the event whose holders are on screen and wait for it to finish
os.write(fd, b"p"); pump(1.0)
check("p opens the decision tab", "5 Decision" in plain(screen()[1]))
t2 = time.time()
while time.time() - t2 < 150:
    pump(1)
    head = plain("\n".join(screen()[2:5]))
    if "ACTION" in plain("\n".join(screen()[2:7])) and "…" not in head: break
text = plain("\n".join(screen()[:ROWS]))
check("decision table has its columns", "ACTION" in text and "BID/ASK" in text and "1H FLOW" in text)
check("decision says what it will and will not claim", "never from following wallets" in text)
check("decision finished loading", "…" not in plain("\n".join(screen()[2:4])))
os.write(fd, b"\x1b[B"); pump(0.8)
check("down arrow on the decision tab does not crash it", alive())
os.write(fd, b"2"); pump(0.8); os.write(fd, b"5"); pump(0.8)
check("5 returns to the decision tab with the result kept", "ACTION" in plain("\n".join(screen()[2:7])))
# search: / opens a prompt, typed letters are text (not commands), Enter lists results, p decides on the selected one
os.write(fd, b"/"); pump(0.8)
check("/ opens the search prompt", "7 Search" in plain(screen()[1]) and "Enter search" in plain("\n".join(screen()[2:4])))
os.write(fd, b"bitcoin"); pump(0.8)
check("typed letters appear in the prompt (q, p are text while typing)", "bitcoin" in plain(screen()[2]) and alive())
os.write(fd, b"\r")
t3 = time.time()
while time.time() - t3 < 40:
    pump(1)
    if "searching" not in plain(screen()[2]) and "VOLUME" in plain("\n".join(screen()[2:5])): break
check("search lists results", "VOLUME" in plain("\n".join(screen()[2:6])) and "EVENT" in plain("\n".join(screen()[2:6])))
os.write(fd, b"p"); pump(1.0)
check("p on a search result opens the decision tab", "5 Decision" in plain(screen()[1]))
# x-ray: x with no holder selected opens the tab with its instructions; a wallet address typed after / runs it end to end
os.write(fd, b"x"); pump(1.0)
check("x opens the x-ray tab and says how to pick a wallet", "6 X-ray" in plain(screen()[1]) and ("select a wallet and press x" in plain("\n".join(screen()[:ROWS])) or "Wallet X-ray" in plain("\n".join(screen()[:ROWS]))))
os.write(fd, b"/"); pump(0.3)
os.write(fd, b"0x7a0da16a1205ee51a56fa862e8baa61e350eff14"); pump(0.3)
os.write(fd, b"\r")
t8 = time.time()
while time.time() - t8 < 90:
    pump(1)
    if "ALL-IN PnL" in plain("\n".join(screen()[:ROWS])) or "error" in plain(screen()[2]).lower(): break
xtext = plain("\n".join(screen()[:ROWS]))
print(f"  x-ray took {time.time() - t8:.0f}s")
check("pasting a wallet address after / opens its x-ray with all-in PnL and the closed-versus-open contrast", "ALL-IN PnL" in xtext and "CLOSED" in xtext and "OPEN" in xtext)
# new wallets: w scans the platform feed, ranks markets by new-account money; Enter opens the selected market's holders
os.write(fd, b"w"); pump(1.0)
check("w opens the new wallets tab", "3 Newbies" in plain(screen()[1]) and "New wallets" in plain(screen()[2]))
t9 = time.time()
while time.time() - t9 < 240:
    pump(1)
    h = plain("\n".join(screen()[:5]))
    if "last " in h and "fills" in h and "looking up" not in h and "reading" not in h: break
wtext = plain("\n".join(screen()[:ROWS]))
print(f"  new-wallet scan took {time.time() - t9:.0f}s")
check("new wallets tab shows the scan summary and the ranked table (or says nothing qualified)", ("fills" in wtext and "markets" in wtext) and ("NEW$" in wtext or "no market had" in wtext))
os.write(fd, b"\r"); pump(2.0)
check("Enter on a market opens its holders", "4 Holders" in plain(screen()[1]) and ("loading" in plain("\n".join(screen()[:ROWS])) or "market " in plain("\n".join(screen()[:ROWS])) or "WHO" in plain("\n".join(screen()[:ROWS]))))
# order book: 8 on the holders tab opens the live book of the market on screen
os.write(fd, b"4"); pump(0.8); os.write(fd, b"8"); pump(1.0)
check("8 opens the order book tab", "8 Book" in plain(screen()[1]))
t10 = time.time()
while time.time() - t10 < 30:
    pump(1)
    if "CUM$" in plain("\n".join(screen()[:ROWS])) or "no order book" in plain("\n".join(screen()[:ROWS])): break
btext = plain("\n".join(screen()[:ROWS]))
check("order book shows the ladder with spread and cumulative dollars (or says the market has no book)", ("ORDER BOOK" in btext and "BID" in btext and "ASK" in btext and "CUM$" in btext) or "no order book" in btext)
# following: + opens the add-by-link prompt, a polymarket.com/@name link resolves to a wallet, 9 shows the card, - unfollows
if os.path.exists(os.path.join(os.environ.get("TMPDIR", "/tmp"), "radar-smoke-wallets.json")): os.remove(os.path.join(os.environ.get("TMPDIR", "/tmp"), "radar-smoke-wallets.json"))
os.write(fd, b"+"); pump(0.8)
check("+ opens the follow prompt", "9 Following" in plain(screen()[1]) and "Follow:" in plain("\n".join(screen()[:6])))
os.write(fd, b"https://polymarket.com/@technician2"); pump(0.5)
check("the pasted link appears in the prompt", "@technician2" in plain("\n".join(screen()[:6])))
os.write(fd, b"\r")
t11 = time.time()
while time.time() - t11 < 90:
    pump(1)
    ftxt = plain("\n".join(screen()[:ROWS]))
    if "RECENT BETS" in ftxt or "no profile" in ftxt.lower(): break
check("following a @name link resolves it and shows the account card with its recent bets", "now following" in ftxt or "RECENT BETS" in ftxt)
check("the follow list has its columns", "ACCOUNT" in ftxt and "LAST BET" in ftxt)
os.write(fd, b"-"); pump(1.0)
check("- unfollows", "unfollowed" in plain("\n".join(screen()[:6])) or "nobody followed" in plain("\n".join(screen()[:ROWS])))
pump(6)
check("still alive after background activity", alive())
os.write(fd, b"q")
t_q = time.time()
done = (0, 0)
while time.time() - t_q < 10:
    pump(0.2)
    try: done = os.waitpid(pid, os.WNOHANG)
    except ChildProcessError: done = (pid, 0)
    if done[0] != 0: break
print(f"  exited after {time.time() - t_q:.1f}s, wait status {done}")
check("q exits with code 0", done[0] != 0 and (done[1] >> 8) == 0)
check("terminal restored (main screen, cursor visible)", b"\x1b[?1049l" in stream and b"\x1b[?25h" in stream)
sys.exit(1 if failures else 0)
