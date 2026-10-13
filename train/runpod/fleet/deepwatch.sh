#!/bin/bash
# deepwatch.sh POD RUN [GAMES]: fetch the pod's latest checkpoint and run the watch report on it locally
POD=$1; RUN=$2; GAMES=${3:-24}
SP=${CRL_SP:?set CRL_SP to a scratch dir with runpod.key and the fleet files}
F="$(cd "$(dirname "$0")" && pwd)"  # this directory: the tracked fleet tools
export RUNPOD_API_KEY=$(cat $SP/runpod.key)
R="$(cd "$F/../../.." && pwd)"
cd $R/train/runpod
mkdir -p $SP/ck
timeout 600 python3 launch.py --pod $POD fetch runs/$RUN/latest.pt --dest $SP/ck/${POD}_${RUN}.pt >/dev/null || { echo "fetch failed"; exit 1; }
U=$($SP/rlvenv/bin/python -c "import torch; print(torch.load('$SP/ck/${POD}_${RUN}.pt', map_location='cpu', weights_only=False)['update'])")
OUT=$R/work/watch/${POD}_${RUN}_u$U
cp $SP/ck/${POD}_${RUN}.pt $SP/ck/${POD}_${RUN}_u$U.pt
cd $R/train && $SP/rlvenv/bin/python -m crl.watch $SP/ck/${POD}_${RUN}_u$U.pt --games $GAMES --maps --threads 3 --out $OUT > $OUT.txt 2>&1
echo "$OUT.txt"
