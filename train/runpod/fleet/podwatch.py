"""Poll the pods' training logs; print only lines worth acting on (one line = one notification)."""
import re, subprocess, sys, time, os
PODS = [x.split(":")[0] for x in sys.argv[1].split(",")]
QUIET = {x.split(":")[0] for x in sys.argv[1].split(",") if x.endswith(":q")}  # errors only
seen = {p: set() for p in PODS}
first = {p: True for p in PODS}
beh_n = {p: 0 for p in PODS}
env = dict(os.environ, RUNPOD_API_KEY=open(sys.argv[2]).read().strip())
BAD = re.compile(r"Traceback|Error|WARNING|kl inf|nan|Killed|exited")
while True:
    for p in PODS:
        try:
            out = subprocess.run([sys.executable, "launch.py", "--pod", p, "log", "-n", "40"], capture_output=True, text=True,
                                 timeout=90, env=env, cwd=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")).stdout
        except Exception as e:
            print(f"[{p}] log fetch failed: {e}", flush=True); continue
        new = [l for l in out.splitlines() if l and l not in seen[p]]
        seen[p].update(new)
        if first[p]:
            first[p] = False
            continue
        for l in new:
            m = re.match(r"upd (\d+) dec (\S+) (\d+)/s ev (\S+) kl (\S+) ent (\S+) card (\S+) play (\S+) ep \S+ (.*?)\|", l)
            if BAD.search(l):
                print(f"[{p}] !! {l[:300]}", flush=True)
            elif p in QUIET:
                continue
            elif m and int(m.group(1)) % 10 == 0:
                u, dec, dps, ev, kl, ent, card, play, rest = m.groups()
                bot = re.search(r"\[bot: (.*?)\]", rest)
                wr = re.search(r"bot=(\S+)", rest)
                lg = re.search(r"league=(\S+)", rest)
                print(f"[{p}] u{u} {dps}/s ev {ev} kl {kl} card {card} play {play} bot={wr.group(1) if wr else '-'} "
                      f"league={lg.group(1) if lg else '-'} {bot.group(1) if bot else ''}", flush=True)
            elif l.lstrip().startswith(("behaviour", "bot(", "self(", "league(")):
                if l.lstrip().startswith("behaviour"):
                    beh_n[p] += 1
                if beh_n[p] % 3 == 1:  # every 30 updates
                    print(f"[{p}] {l.strip()[:330]}", flush=True)
    time.sleep(90)
