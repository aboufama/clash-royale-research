#!/bin/bash
# winddown.sh: stop each run (it saves a checkpoint), back up latest.pt + metrics locally, stop the pod
SP=${CRL_SP:?set CRL_SP to a scratch dir with runpod.key and the fleet files}
F="$(cd "$(dirname "$0")" && pwd)"  # this directory: the tracked fleet tools
export RUNPOD_API_KEY=$(cat $SP/runpod.key)
cd "$F/.."
OUT="$(cd "$F/../../.." && pwd)/work/runpod/final_$(date +%Y%m%d)"
mkdir -p $OUT
while IFS='|' read -r POD RUN ROLE FLAGS; do
  timeout 60 python3 launch.py --pod $POD stop >/dev/null 2>&1
  for i in $(seq 1 12); do timeout 60 python3 launch.py --pod $POD status 2>&1 | grep -q '"running": false' && break; timeout 30 python3 launch.py --pod $POD exec "sleep 5" >/dev/null 2>&1; done
  timeout 600 python3 launch.py --pod $POD fetch runs/$RUN/latest.pt --dest $OUT/${POD}_${RUN}_latest.pt >/dev/null 2>&1
  timeout 300 python3 launch.py --pod $POD fetch runs/$RUN/metrics.jsonl --dest $OUT/${POD}_${RUN}_metrics.jsonl >/dev/null 2>&1
  timeout 120 python3 launch.py --pod $POD fetch runs/$RUN/spec.json --dest $OUT/spec.json >/dev/null 2>&1
  timeout 90 python3 launch.py --pod $POD stop-pod 2>&1 | tail -1
  echo "$(date +%T) $POD $RUN: $(ls -la $OUT/${POD}_${RUN}_latest.pt 2>/dev/null | awk '{print $5}') bytes saved"
done < $F/fleet_flags.txt
echo "$(date +%T) winddown done"
