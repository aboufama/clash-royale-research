"""Every 10 min: population bot benchmark; print a line only on a breakthrough or a big leap.
The owner's bar (2026-10-13 23:00): at least 1 crown without losing a tower, the majority of games."""
import json, os, re, subprocess, time, sys
SP = sys.argv[1]
BEST = os.path.join(SP, 'breakwatch_best.json')
best = json.load(open(BEST)) if os.path.exists(BEST) else {}  # kept across re-arms
while True:
    out = subprocess.run(["bash", os.path.join(os.path.dirname(os.path.abspath(__file__)), "popstat.sh")], capture_output=True, text=True, timeout=900).stdout
    for l in out.splitlines():
        m = re.match(r"(\S+)\s+(\S+)\s+u(\d+) \((\d+) upd\) bot n=(\d+) win ([\d.]+) crowns ([\d.]+)/([\d.]+) 1\+&0 ([\d.]+) \(n=(\d+)\)", l)
        if not m:
            continue
        pod, run, u, nu, n, win, c, cl, d1, n1 = m.groups()
        win, d1, n1 = float(win), float(d1), int(n1)
        if n1 < 250:
            continue
        tag = f"{pod}/{run} u{u}: 1+crown&0-lost {d1:.2f} over {n1} games, bot win {win:.2f}, crowns {c}/{cl}"
        if d1 >= 0.50 or win >= 0.45:
            print("BREAKTHROUGH " + tag, flush=True)
        elif d1 > best.get(pod, 0.25) + 0.03:
            best[pod] = d1
            json.dump(best, open(BEST, "w"))
            print("big leap " + tag, flush=True)
    time.sleep(600)
