#!/bin/bash
# popstat.sh: last-100-update bot benchmark for every run of the population
SP=${CRL_SP:?set CRL_SP to a scratch dir with runpod.key and the fleet files}
F="$(cd "$(dirname "$0")" && pwd)"  # this directory: the tracked fleet tools
export RUNPOD_API_KEY=$(cat $SP/runpod.key)
cd "$F/.."
for e in "crl-5090a exp1 1781" "crl-c w5 2269" "crl-b x1 2041" "crl-d w2 1961" "crl-e e2 2193" "crl-f w4 2265" "crl-g g2 1961" "crl-h w3 2171" "crl-i w1 1961"; do
  set -- $e
  python3 -c "import sys; sys.path.insert(0,'.'); import launch; sys.exit(0 if '$1' in launch.load_state()['pods'] else 1)" || continue
  timeout 60 python3 launch.py --pod $1 upload $F/popsum.py runs/popsum.py >/dev/null 2>&1
  printf "%-10s %-5s " $1 $2
  timeout 90 python3 launch.py --pod $1 exec "test -f /workspace/crl/runs/$2/metrics.jsonl && python3 /workspace/crl/runs/popsum.py /workspace/crl/runs/$2/metrics.jsonl $3 || echo 'no metrics yet'" 2>&1 | grep -v "^\[exit" | head -1
done
