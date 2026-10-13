import json, sys
rows = {}
for l in open(sys.argv[1]):
    if l.strip():
        r = json.loads(l); rows[r['update']] = r
us = sorted(rows)
step = int(sys.argv[2]); lo = int(sys.argv[3])
def agg(a, b, k):
    g = w = c = cl = d = 0
    for u in us:
        if a <= u < b:
            r = rows[u]; n = r.get(f'games_vs_{k}', 0)
            if n:
                g += n; w += r[f'winrate_vs_{k}'] * n; c += r[f'crowns_vs_{k}'] * n; cl += r[f'crowns_lost_vs_{k}'] * n; d += r[f'dominant_vs_{k}'] * n
    return (g, w / g, c / g, cl / g, d / g) if g else (0, 0, 0, 0, 0)
for a in range(lo, us[-1] + 1, step):
    g, w, c, cl, d = agg(a, a + step, 'bot'); gl, wl, *_ = agg(a, a + step, 'league')
    print(f"{a}-{a+step-1}: bot games {g:4d} win {w:.2f} crowns {c:.2f}/{cl:.2f} 2+&0lost {d:.3f} | league win {wl:.2f} (n={gl})")
print("last update", us[-1], "dec/s", round(rows[us[-1]].get('decisions_per_s', 0)))
