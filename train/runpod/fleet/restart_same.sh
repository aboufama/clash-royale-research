#!/bin/bash
# restart_same.sh [pod ...]: stop, push the current code, start each pod's run from fleet_flags.txt (resumes)
SP=${CRL_SP:?set CRL_SP to a scratch dir with runpod.key and the fleet files}
F="$(cd "$(dirname "$0")" && pwd)"  # this directory: the tracked fleet tools
export RUNPOD_API_KEY=$(cat $SP/runpod.key)
cd "$F/.."
BASE="--mirror --envs 96 --active-opponents 2 --epochs 1 --minibatch 2048 --lr 2e-4 --ent-slot 0.03 --ent-tile 0.005 --card-floor 0.01"
while IFS='|' read -r POD RUN ROLE FLAGS; do
  [ -n "$*" ] && [[ " $* " != *" $POD "* ]] && continue
  if [ "$ROLE" = exploiter ]; then EXTRA="--bot-prob 0.05 --self-play-prob 0 --snapshot-every 100000 --import-keep 2"; else EXTRA="--import-share 0.15 --bot-prob 0.1"; fi
  timeout 60 python3 launch.py --pod $POD stop >/dev/null 2>&1
  for i in $(seq 1 12); do timeout 60 python3 launch.py --pod $POD status 2>&1 | grep -q '"running": false' && break; timeout 30 python3 launch.py --pod $POD exec "sleep 5" >/dev/null 2>&1; done
  timeout 300 python3 launch.py --pod $POD push >/dev/null 2>&1
  r=$(timeout 60 python3 launch.py --pod $POD start --run $RUN -- $BASE $EXTRA $FLAGS --import-dir /workspace/crl/runs/$RUN/import 2>&1 | grep -c ok)
  echo "$(date +%T) $POD $RUN: $r"
done < $F/fleet_flags.txt
echo "$(date +%T) restart done"
