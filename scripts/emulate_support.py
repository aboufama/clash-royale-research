#!/usr/bin/env python3
"""Isolated native-loader experiment. No target syscalls are forwarded to the host.
Requires pyelftools/unicorn/capstone. Binary inputs and dumps stay private.
"""

import argparse, collections, hashlib, json, struct, time
from pathlib import Path
from elftools.elf.elffile import ELFFile
from unicorn import *
from unicorn.arm64_const import *

P = argparse.ArgumentParser()
P.add_argument("--library", type=Path, required=True)
P.add_argument("--out", type=Path, required=True)
P.add_argument("--jni", action="store_true")
P.add_argument("--defer-threads", action="store_true")
P.add_argument("--seconds", type=int, default=20)
A = P.parse_args()
A.out.mkdir(parents=True, exist_ok=True)
BASE = 0x20000000
STACK = 0x40000000
STUBS = 0x50000000
HEAP = 0x60000000
STOP = 0x70000000
PAGE = 4096
up = lambda n: (n + PAGE - 1) & -PAGE
raw = A.library.read_bytes()
expected = "20132160e841a00740ef818e0ae2796508cbdd4f5173834f53e7c6d5af045f2f"
if hashlib.sha256(raw).hexdigest() != expected:
    raise ValueError("This experiment requires the pinned 160402020 support library")
if A.seconds <= 0:
    raise ValueError("--seconds must be positive")
elf = ELFFile(A.library.open("rb"))
segments = [s for s in elf.iter_segments() if s["p_type"] == "PT_LOAD"]
tags = {
    t.entry.d_tag: t.entry.d_val
    for t in elf.get_section_by_name(".dynamic").iter_tags()
}


def off(va):
    for s in segments:
        if s["p_vaddr"] <= va < s["p_vaddr"] + s["p_filesz"]:
            return s["p_offset"] + va - s["p_vaddr"]
    raise ValueError(hex(va))


symcount = struct.unpack_from("<II", raw, off(tags["DT_HASH"]))[1]
symnames = []
syms = []
for i in range(symcount):
    n, info, other, section, va, size = struct.unpack_from(
        "<IBBHQQ", raw, off(tags["DT_SYMTAB"]) + i * 24
    )
    n = (
        raw[off(tags["DT_STRTAB"]) + n :]
        .split(b"\0", 1)[0]
        .decode("ascii", errors="replace")
    )
    syms.append((n, section, va))
    symnames.append(n)
u = Uc(UC_ARCH_ARM64, UC_MODE_ARM)
imagesize = up(max(s["p_vaddr"] + s["p_memsz"] for s in segments))
u.mem_map(BASE, imagesize)
for s in segments:
    u.mem_write(BASE + s["p_vaddr"], s.data())
for addr, n in [(STACK, 0x400000), (STUBS, 0x100000), (HEAP, 0x2000000), (STOP, PAGE)]:
    u.mem_map(addr, n)
u.reg_write(UC_ARM64_REG_SP, STACK + 0x200000)
u.reg_write(UC_ARM64_REG_LR, STOP)
u.reg_write(UC_ARM64_REG_CPACR_EL1, 3 << 20)
u.reg_write(UC_ARM64_REG_TPIDR_EL0, HEAP + 0x1000)
stubnames = {}
stubnext = STUBS
heapnext = HEAP + 0x10000
fds = {}
calls = []
recent = collections.deque(maxlen=30)
writes = []


def stub(n):
    global stubnext
    for k, v in stubnames.items():
        if v == n:
            return k
    p = stubnext
    stubnext += 16
    stubnames[p] = n
    u.mem_write(p, bytes.fromhex("c0035fd6"))
    return p


relocs = collections.Counter()
for k, sk in [("DT_RELA", "DT_RELASZ"), ("DT_JMPREL", "DT_PLTRELSZ")]:
    for x in range(off(tags[k]), off(tags[k]) + tags[sk], 24):
        t, info, ad = struct.unpack_from("<QQq", raw, x)
        kind, idx = info & 0xFFFFFFFF, info >> 32
        relocs[kind] += 1
        if kind == 1027:
            v = BASE + ad
        elif kind in [257, 1025, 1026]:
            n, section, va = syms[idx]
            v = (BASE + va if section else stub(n or f"unnamed_{idx}")) + ad
        elif kind == 0:
            continue
        else:
            raise ValueError(kind)
        u.mem_write(BASE + t, struct.pack("<Q", v & 0xFFFFFFFFFFFFFFFF))
libpath = "/data/app/~~research/com.supercell.clashroyale/lib/arm64/" + A.library.name
maps = ""
for s in segments:
    flags = s["p_flags"]
    pr = (
        ("r" if flags & 4 else "-")
        + ("w" if flags & 2 else "-")
        + ("x" if flags & 1 else "-")
        + "p"
    )
    maps += f'{BASE+(s["p_vaddr"]&-PAGE):x}-{BASE+up(s["p_vaddr"]+s["p_memsz"]):x} {pr} {s["p_offset"]&-PAGE:08x} 00:01 1 {libpath}\n'
# A synthetic libc ELF supplies only symbol addresses into emulator import stubs.
# No bionic implementation is assumed or executed.
LIBC = 0x30000000
libc_names = [
    "read",
    "open",
    "exit",
    "malloc",
    "mmap",
    "munmap",
    "free",
    "close",
    "lseek",
    "mprotect",
    "sysconf",
    "strstr",
    "cacheflush",
    "__system_property_get",
]
strtab = b"\0"
symbols = bytes(24)
for name in libc_names:
    idx = len(strtab)
    strtab += name.encode() + b"\0"
    symbols += struct.pack("<IBBHQQ", idx, 0x12, 0, 1, stub(name) - LIBC, 4)
shstr = b"\0.text\0.dynsym\0.dynstr\0.shstrtab\0"
libc = bytearray(0x4000)
libc[:64] = struct.pack(
    "<16sHHIQQQIHHHHHH",
    b"\x7fELF\x02\x01\x01" + bytes(9),
    3,
    183,
    1,
    0,
    64,
    0x3000,
    0,
    64,
    56,
    1,
    64,
    5,
    4,
)
libc[64:120] = struct.pack("<IIQQQQQQ", 1, 5, 0, 0, 0, len(libc), len(libc), 0x1000)
libc[0x1000 : 0x1000 + len(symbols)] = symbols
libc[0x2000 : 0x2000 + len(strtab)] = strtab
libc[0x2800 : 0x2800 + len(shstr)] = shstr
for i, values in enumerate(
    [
        (0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
        (1, 1, 6, 0x800, 0x800, 4, 0, 0, 4, 0),
        (7, 11, 2, 0x1000, 0x1000, len(symbols), 3, 1, 8, 24),
        (15, 3, 2, 0x2000, 0x2000, len(strtab), 0, 0, 1, 0),
        (23, 3, 0, 0, 0x2800, len(shstr), 0, 0, 1, 0),
    ]
):
    libc[0x3000 + i * 64 : 0x3040 + i * 64] = struct.pack("<IIQQQQIIQQ", *values)
u.mem_map(LIBC, 0x4000)
u.mem_write(LIBC, bytes(libc))
maps += "30000000-30004000 r-xp 00000000 00:01 2 /apex/com.android.runtime/lib64/bionic/libc.so\n"
vfiles = {
    "/dev/urandom": hashlib.shake_256(b"reproducible-loader-research-only").digest(
        65536
    ),
    "/apex/com.android.runtime/lib64/bionic/libc.so": bytes(libc),
    "/proc/self/maps": maps.encode(),
    libpath: raw,
    "/proc/self/status": b"Name:\tclashroyale\nTracerPid:\t0\n",
}
report = {
    "input_sha256": hashlib.sha256(raw).hexdigest(),
    "load_base": hex(BASE),
    "relocations": dict(relocs),
    "runtime_callback_before": None,
    "calls": calls,
    "mocked_environment": True,
    "caution": "This models selected OS operations; unknown operations stop. It is not an Android runtime.",
    "model_limitations": [
        "Synthetic libc exports resolve to in-memory stubs.",
        "Memory permissions are modeled as accessible; mprotect is a no-op.",
        "Mutex operations are modeled as no-ops in the single-thread constructor.",
        "Random input is deterministic research data.",
        "Optional deferred-thread mode does not establish correct threaded initialization.",
    ],
}


def readstr(a, n=4096):
    return bytes(u.mem_read(a, n)).split(b"\0", 1)[0].decode(errors="replace")


def q(a):
    return struct.unpack("<Q", u.mem_read(a, 8))[0]


def malloc(n):
    global heapnext
    p = heapnext
    heapnext += (n + 15) & -16
    if heapnext > HEAP + 0x2000000:
        raise ValueError("heap exhausted")
    return p


def ret(v):
    u.reg_write(UC_ARM64_REG_X0, v & 0xFFFFFFFFFFFFFFFF)
    u.reg_write(UC_ARM64_REG_PC, u.reg_read(UC_ARM64_REG_LR))


def stop(s):
    report["stop_reason"] = s
    u.emu_stop()


def syscall(n, a):
    if n == 226:
        return 0
    if n == 172:
        return 1000
    if n == 178:
        return 1000
    if n == 174:
        return 10000
    if n == 56:
        path = readstr(a[1])
        calls.append({"open": path})
        if path not in vfiles:
            raise ValueError("unmodelled file " + path)
        fd = max([2] + list(fds)) + 1
        fds[fd] = [path, 0]
        return fd
    if n == 63:
        path, pos = fds[a[0]]
        data = vfiles[path][pos : pos + a[2]]
        u.mem_write(a[1], data)
        fds[a[0]][1] += len(data)
        return len(data)
    if n == 57:
        del fds[a[0]]
        return 0
    if n == 62:
        path, pos = fds[a[0]]
        offs = a[1] - (1 << 64) if a[1] >> 63 else a[1]
        fds[a[0]][1] = offs + [0, pos, len(vfiles[path])][a[2]]
        return fds[a[0]][1]
    raise ValueError("unmodelled syscall " + str(n) + " " + str([hex(x) for x in a]))


def imported(uc, pc, size, _):
    name = stubnames[pc]
    args = [u.reg_read(UC_ARM64_REG_X0 + i) for i in range(7)]
    calls.append(
        {
            "import": name,
            "args": [hex(x) for x in args],
            "lr": hex(u.reg_read(UC_ARM64_REG_LR)),
        }
    )
    try:
        if name == "dlsym":
            requested = readstr(args[1])
            calls.append({"resolve_symbol": requested})
            v = stub(requested)
        elif name in ("malloc", "calloc"):
            v = malloc(args[0] * (args[1] if name == "calloc" else 1))
        elif name == "free":
            v = 0
        elif name == "pthread_create" and A.defer_threads:
            threads = report.setdefault("deferred_threads", [])
            tid = 0x9000 + len(threads)
            threads.append(
                {
                    "id": tid,
                    "entry": hex(args[2]),
                    "arg": hex(args[3]),
                    "executed": False,
                }
            )
            u.mem_write(args[0], struct.pack("<Q", tid))
            v = 0
        elif name == "pthread_detach" and A.defer_threads:
            v = 0
        elif name in [
            "pthread_mutex_lock",
            "pthread_mutex_unlock",
            "pthread_mutex_init",
            "pthread_mutex_destroy",
        ]:
            v = 0  # single-thread experiment
        elif name in ["memcpy", "memmove", "__memcpy_chk", "__memmove_chk"]:
            u.mem_write(args[0], bytes(u.mem_read(args[1], args[2])))
            v = args[0]
        elif name in ["memset", "__memset_chk"]:
            u.mem_write(args[0], bytes([args[1] & 255]) * args[2])
            v = args[0]
        elif name in ["getpagesize"]:
            v = PAGE
        elif name == "getauxval" and args[0] == 6:
            v = PAGE
        elif name == "sysconf" and args[0] == 39:
            v = PAGE
        elif name == "__system_property_get":
            key = readstr(args[0])
            calls.append({"system_property": key})
            if key != "ro.build.version.sdk":
                raise ValueError("unmodelled property " + key)
            u.mem_write(args[1], b"35\0")
            v = 2
        elif name == "syscall":
            v = syscall(args[0], args[1:])
        elif name == "mprotect":
            v = 0
        elif name == "open":
            v = syscall(56, [0, args[0], args[1], args[2]])
        elif name == "read":
            v = syscall(63, args)
        elif name == "close":
            v = syscall(57, args)
        elif name == "lseek":
            v = syscall(62, args)
        elif name == "strstr":
            hay = readstr(args[0])
            needle = readstr(args[1])
            idx = hay.find(needle)
            v = args[0] + idx if idx >= 0 else 0
        elif name == "fopen":
            path = readstr(args[0])
            mode = readstr(args[1])
            calls.append({"fopen_path": path, "mode": mode})
            if path not in vfiles:
                raise ValueError("unmodelled fopen " + path)
            v = malloc(256)
            fds[v] = [path, 0]
        elif name == "fclose":
            del fds[args[0]]
            v = 0
        elif name == "fread":
            path, pos = fds[args[3]]
            n = args[1] * args[2]
            data = vfiles[path][pos : pos + n]
            u.mem_write(args[0], data)
            fds[args[3]][1] += len(data)
            v = len(data) // args[1] if args[1] else 0
        elif name == "fseek":
            fd, offs, whence = args[:3]
            path, pos = fds[fd]
            offs = offs - (1 << 64) if offs >> 63 else offs
            fds[fd][1] = offs + [0, pos, len(vfiles[path])][whence]
            v = 0
        elif name in ["fgets", "__fgets_chk"]:
            buf, n, fd = (
                (args[0], args[1], args[2])
                if name == "fgets"
                else (args[0], args[2], args[3])
            )
            path, pos = fds[fd]
            end = vfiles[path].find(b"\n", pos)
            if pos == len(vfiles[path]):
                v = 0
            else:
                end = min(end + 1 if end >= 0 else len(vfiles[path]), pos + n - 1)
                data = vfiles[path][pos:end]
                u.mem_write(buf, data + b"\0")
                fds[fd][1] = end
                v = buf
        elif name == "sscanf":
            string, fmt = readstr(args[0]), readstr(args[1])
            calls.append({"sscanf_format": fmt, "sscanf_input": string})
            if fmt == "%lx-%*x %*s %*x %*s %*d %255s":
                fields = string.split()
                start = int(fields[0].split("-")[0], 16)
                u.mem_write(args[2], struct.pack("<Q", start))
                v = 1
                if len(fields) >= 6:
                    u.mem_write(args[3], fields[5].encode() + b"\0")
                    v = 2
            else:
                raise ValueError("unmodelled sscanf " + fmt)
        elif name == "__errno":
            v = HEAP
        elif name in ["strcmp", "strncmp"]:
            count = args[2] if name == "strncmp" else 4096
            if count > 4096:
                raise ValueError("unmodelled long strncmp input")
            l = bytes(u.mem_read(args[0], count)).split(b"\0", 1)[0] if count else b""
            r = bytes(u.mem_read(args[1], count)).split(b"\0", 1)[0] if count else b""
            if name == "strcmp" and (len(l) == 4096 or len(r) == 4096):
                raise ValueError("unterminated strcmp input exceeds model bound")
            v = (l > r) - (l < r)
        elif name == "strlen":
            v = len(readstr(args[0]).encode())
        elif name == "JavaVM.GetEnv":
            u.mem_write(args[1], struct.pack("<Q", HEAP + 0x5000))
            v = 0
        else:
            raise ValueError("unmodelled import " + name)
        ret(v)
    except Exception as e:
        stop(str(e))


def intr(uc, n, _):
    if n != 2:
        stop("unmodelled ARM64 interrupt " + str(n))
        return
    try:
        a = [u.reg_read(UC_ARM64_REG_X0 + i) for i in range(6)]
        num = u.reg_read(UC_ARM64_REG_X8)
        calls.append(
            {
                "syscall": num,
                "args": [hex(x) for x in a],
                "pc": hex(u.reg_read(UC_ARM64_REG_PC)),
            }
        )
        u.reg_write(UC_ARM64_REG_X0, syscall(num, a) & 0xFFFFFFFFFFFFFFFF)
    except Exception as e:
        stop(str(e))


def block(uc, a, n, _):
    recent.append((hex(a), n))


def wr(uc, access, address, size, value, _):
    writes.append(
        {
            "pc": hex(u.reg_read(UC_ARM64_REG_PC)),
            "address": hex(address),
            "size": size,
            "value": hex(value),
        }
    )


u.hook_add(UC_HOOK_CODE, imported, begin=STUBS, end=STUBS + 0xFFFFF)
u.hook_add(UC_HOOK_INTR, intr)
u.hook_add(UC_HOOK_BLOCK, block)
u.hook_add(UC_HOOK_MEM_WRITE, wr, begin=BASE + 0x6C6470, end=BASE + 0x6C6477)
relocated_image = bytes(u.mem_read(BASE, imagesize))
report["runtime_callback_before"] = hex(q(BASE + 0x6C6470))
inits = [
    q(BASE + tags["DT_INIT_ARRAY"] + i) for i in range(0, tags["DT_INIT_ARRAYSZ"], 8)
]
report["initializers"] = [hex(x) for x in inits]
for init in inits:
    try:
        t = time.monotonic()
        u.emu_start(init, STOP, timeout=A.seconds * 1000000, count=1000000000)
        report["elapsed_seconds"] = time.monotonic() - t
    except UcError as e:
        report["error"] = str(e)
    report["pc"] = hex(u.reg_read(UC_ARM64_REG_PC))
    report["returned"] = u.reg_read(UC_ARM64_REG_PC) == STOP
    if not report["returned"]:
        break
report["constructor_returned"] = report["returned"]
constructor_image = bytes(u.mem_read(BASE, imagesize))
report["constructor_changed_bytes_excluding_relocations"] = sum(
    x != y for x, y in zip(relocated_image, constructor_image)
)
report["jni_target_sample"] = {
    "elf_va": "0x64449c",
    "before": relocated_image[0x64449C : 0x64449C + 32].hex(),
    "after_constructor": constructor_image[0x64449C : 0x64449C + 32].hex(),
}

if A.jni and report["returned"]:
    # JavaVM and JNIEnv function tables are emulator stubs. Unknown JNI calls stop.
    vm, vmvt, env, envvt = HEAP + 0x3000, HEAP + 0x4000, HEAP + 0x5000, HEAP + 0x6000
    u.mem_write(vm, struct.pack("<Q", vmvt))
    u.mem_write(env, struct.pack("<Q", envvt))
    for i in range(8):
        u.mem_write(
            vmvt + i * 8,
            struct.pack("<Q", stub("JavaVM.GetEnv" if i == 6 else f"JavaVM.{i}")),
        )
    for i in range(234):
        u.mem_write(envvt + i * 8, struct.pack("<Q", stub(f"JNIEnv.{i}")))
    u.reg_write(UC_ARM64_REG_X0, vm)
    u.reg_write(UC_ARM64_REG_X1, 0)
    u.reg_write(UC_ARM64_REG_LR, STOP)
    try:
        u.emu_start(
            BASE + 0x68179C, STOP, timeout=A.seconds * 1000000, count=1000000000
        )
    except UcError as e:
        report["error"] = str(e)
    report["jni_pc"] = hex(u.reg_read(UC_ARM64_REG_PC))
    report["jni_returned"] = u.reg_read(UC_ARM64_REG_PC) == STOP
    report["jni_return_value"] = hex(u.reg_read(UC_ARM64_REG_X0))
report["runtime_callback_after"] = hex(q(BASE + 0x6C6470))
report["callback_writes"] = writes
report["recent_blocks"] = list(recent)
report["registers"] = {f"x{i}": hex(u.reg_read(UC_ARM64_REG_X0 + i)) for i in range(29)}
report["registers"]["lr"] = hex(u.reg_read(UC_ARM64_REG_LR))
report["registers"]["sp"] = hex(u.reg_read(UC_ARM64_REG_SP))
(A.out / "runtime-memory.bin").write_bytes(bytes(u.mem_read(BASE, imagesize)))
(A.out / "report.json").write_text(json.dumps(report, indent=2))
print(
    json.dumps(
        {
            k: v
            for k, v in report.items()
            if k not in ["calls", "registers", "recent_blocks"]
        },
        indent=2,
    )
)
print("Recent calls:", json.dumps(calls[-10:], indent=2))
