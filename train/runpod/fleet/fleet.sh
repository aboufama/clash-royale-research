#!/bin/bash
# fleet.sh: rent, verify and start the population pods one after another (never two creates at once).
SP=${CRL_SP:?set CRL_SP to a scratch dir with runpod.key and the fleet files}
F="$(cd "$(dirname "$0")" && pwd)"  # this directory: the tracked fleet tools
export RUNPOD_API_KEY=$(cat $SP/runpod.key)
cd "$F/.."
CK=$SP/backup/latest_1780.pt  # the checkpoint the population started from
COMMON="--mirror --envs 96 --active-opponents 2 --epochs 1 --minibatch 2048 --lr 4e-4 --ent-slot 0.03 --ent-tile 0.005 --crown-coef 1.0 --card-floor 0.01 --target-kl 0.01 --import-share 0.15 --bot-prob 0.1"
VARIANTS=(
  "crl-d|d1|--seed 11"
  "crl-e|e1|--seed 12 --crown-coef 2.0"
  "crl-f|f1|--seed 13 --shape-floor 0.2 --crown-coef 1.5"
  "crl-g|g1|--seed 14 --epochs 2"
  "crl-h|h1|--seed 15 --lam 0.98"
  "crl-i|i1|--seed 16 --self-play-prob 0.8"
)
for v in "${VARIANTS[@]}"; do
  IFS='|' read -r POD RUN FLAGS <<< "$v"
  $F/grab4.sh $POD 90 || continue
  timeout 300 python3 launch.py --pod $POD push >/dev/null 2>&1
  timeout 120 python3 launch.py --pod $POD exec "nvidia-cuda-mps-control -d" >/dev/null 2>&1
  timeout 600 python3 launch.py --pod $POD upload $CK runs/$RUN/latest.pt >/dev/null 2>&1
  r=$(timeout 60 python3 launch.py --pod $POD start --run $RUN -- $COMMON $FLAGS --import-dir /workspace/crl/runs/$RUN/import 2>&1 | grep -c ok)
  echo "$(date +%T) STARTED $POD $RUN ($FLAGS): $r"
  nohup python3 -u relay.py --main $POD:$RUN --exploiter crl-b:x1 --one-way --every 1200 > $SP/relay_$POD.log 2>&1 &
done
python3 -c "
import sys; sys.path.insert(0,'.'); import launch; st=launch.load_state(); st['current']='crl-5090a'; launch.save_state(st)"
echo "$(date +%T) fleet done"
