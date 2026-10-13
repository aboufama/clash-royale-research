#!/bin/bash
# grab4.sh NAME MAX_MINUTES: rent one working GPU pod, verify CUDA (retry once after 60 s) and speed, else
# terminate and try the next type. Order: community 5090, secure 4090, secure 5090, community 4090.
NAME=$1; DEADLINE=$(( $(date +%s) + ${2:-60} * 60 ))
SP=${CRL_SP:?set CRL_SP to a scratch dir with runpod.key and the fleet files}
F="$(cd "$(dirname "$0")" && pwd)"  # this directory: the tracked fleet tools
export RUNPOD_API_KEY=$(cat $SP/runpod.key)
cd "$F/.."
TYPES=("COMMUNITY|NVIDIA GeForce RTX 5090|24" "SECURE|NVIDIA GeForce RTX 4090|16" "SECURE|NVIDIA GeForce RTX 5090|16" "COMMUNITY|NVIDIA GeForce RTX 4090|20")
cuda_ok() { timeout 120 python3 launch.py --pod $NAME exec "python3 -c 'import ctypes,sys; sys.exit(ctypes.CDLL(\"libcuda.so.1\").cuInit(0))'" 2>&1 | grep -q "exit 0"; }
speed_ok() { timeout 120 python3 launch.py --pod $NAME upload $F/gpubench.py runs/gpubench.py >/dev/null 2>&1 && \
  timeout 180 python3 launch.py --pod $NAME exec "python3 /workspace/crl/runs/gpubench.py" 2>&1 | tee -a $SP/grab_bench.log | grep -q "exit 0"; }
declare -A FAILS
while [ $(date +%s) -lt $DEADLINE ]; do
  for t in "${TYPES[@]}"; do
    cloud=${t%%|*}; rest=${t#*|}; gpu=${rest%|*}; v=${rest#*|}
    [ "${FAILS[$cloud$gpu]:-0}" -ge 2 ] && continue
    out=$(timeout 90 python3 launch.py create --name $NAME --cloud $cloud --gpu "$gpu" --min-vcpu $v --min-ram 32 --volume 30 2>&1)
    echo "$out" | grep -q '"id"' || continue
    echo "$(date +%T) $NAME created $cloud $gpu: $(echo "$out" | tr '\n' ' ' | cut -c1-140)"
    if timeout 900 python3 launch.py --pod $NAME wait --timeout 800 >/dev/null 2>&1; then
      cuda_ok || { sleep 60; cuda_ok; } && speed_ok && { echo "$(date +%T) READY $NAME $cloud $gpu"; exit 0; }
    fi
    FAILS[$cloud$gpu]=$(( ${FAILS[$cloud$gpu]:-0} + 1 ))
    echo "$(date +%T) $NAME $cloud $gpu failed the CUDA / speed check: terminating"
    timeout 90 python3 launch.py --pod $NAME terminate 2>&1 | tail -1
  done
  sleep 30
done
echo "$(date +%T) $NAME gave up"; exit 1
