import subprocess, sys, time, torch
x = torch.randn(8192, 8192, device="cuda", dtype=torch.bfloat16)
torch.cuda.synchronize()
n, t0 = 0, time.time()
clocks = []
while time.time() - t0 < 4:
    for _ in range(10):
        y = x @ x
    torch.cuda.synchronize()
    n += 10
    if time.time() - t0 > 2 and not clocks:
        out = subprocess.run(["nvidia-smi", "--query-gpu=clocks.sm,clocks.max.sm", "--format=csv,noheader,nounits"], capture_output=True, text=True).stdout
        clocks = [float(v) for v in out.strip().split(",")]
tf = n * 2 * 8192 ** 3 / (time.time() - t0) / 1e12
ratio = clocks[0] / clocks[1] if clocks else 0
print(f"bf16 {tf:.0f} TFLOPs, clock {clocks[0]:.0f}/{clocks[1]:.0f} MHz ({ratio:.2f})")
sys.exit(0 if tf > 40 and ratio > 0.5 else 3)
