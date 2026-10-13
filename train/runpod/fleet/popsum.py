import json, sys
rows = {}
for l in open(sys.argv[1]):
    if l.strip():
        r = json.loads(l); rows[r['update']] = r
us = sorted(rows); last = us[-1]; lo = int(sys.argv[2])
win = [u for u in us if u >= max(lo, last - 99)]
def agg(k):
    g = w = c = cl = d = 0; g1 = d1 = 0
    for u in win:
        r = rows[u]; n = r.get(f'games_vs_{k}', 0)
        if n:
            g += n; w += r[f'winrate_vs_{k}'] * n; c += r[f'crowns_vs_{k}'] * n; cl += r[f'crowns_lost_vs_{k}'] * n; d += r[f'dominant_vs_{k}'] * n
            if f'dominant1_vs_{k}' in r:
                g1 += n; d1 += r[f'dominant1_vs_{k}'] * n
    return (g, w / g, c / g, cl / g, d / g, g1, d1 / g1 if g1 else -1) if g else (0, 0, 0, 0, 0, 0, -1)
g, w, c, cl, d, g1, d1 = agg('bot'); gl, wl, *_ = agg('league')
d1s = f"{d1:.3f} (n={g1})" if g1 else "n/a"
print(f"u{last} ({len(win)} upd) bot n={g} win {w:.3f} crowns {c:.2f}/{cl:.2f} 1+&0 {d1s} 2+&0 {d:.3f} | league {wl:.2f} | {rows[last].get('decisions_per_s', 0):.0f}/s")
