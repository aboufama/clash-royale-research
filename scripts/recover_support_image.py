#!/usr/bin/env python3
"""Recover the pinned support text by executing its original parent/child code.

Runs three isolated deterministic ARM64 branches with a modeled OS and cooperative
thread scheduler. IPC bytes and cipher parameters are generated from original code
at runtime; no private transcript, key, decrypted image or rewritten game code is
packaged. This recovers a code region, not an initialized Android/game runtime.
All generated binary material and detailed captures remain beneath private work/.
"""

import argparse
import collections
import copy
import hashlib
import io
import json
from pathlib import Path
import re
import struct
import sys
import time
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
LIBRARY_SHA = "20132160e841a00740ef818e0ae2796508cbdd4f5173834f53e7c6d5af045f2f"
IMAGE_SHA = "58735fa9ae5a6d7ea5f828066f3f06e7669eecb79c8ce4c49d4db5d704b72aac"
TEXT_SHA = "821a8deac13d24121f199db16c3395d4f4703913aad10e6a3015d68b9f49b78a"
EXPECTED = {
    "parent_blocked": (
        "IPC read requires peer activity: pipe:5",
        "0x2065a9dc",
        "306dad9fe245c14717a692c975b979a7d301277b93f3afc0c748c78e6885c035",
    ),
    "child_replied": (
        "unmodelled import time",
        "0x50000150",
        "5847886a482ed8ba9967d999e63ce169ca3344ebce3ce6bb75cec08dc3b31765",
    ),
    "parent_decoded": ("unmodelled import getauxval", "0x500009b0", IMAGE_SHA),
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def bounded_size(n, limit=32 * 1024 * 1024):
    if type(n) is not int or not 0 <= n <= limit:
        raise ValueError("Native size exceeds modeled memory bound")
    return n


def peer_region(peer, address, size):
    bounded_size(size)
    if type(address) is not int or not 0 <= address < 2**64 or address + size > 2**64:
        raise ValueError("Invalid peer-memory address")
    for base, data in peer["images"]:
        if base <= address and address + size <= base + len(data):
            return data, address - base
    raise ValueError("Peer-memory access outside one captured region")


def read_peer(peer, address, size):
    data, offset = peer_region(peer, address, size)
    return bytes(data[offset : offset + size])


def write_peer(peer, address, payload):
    data, offset = peer_region(peer, address, len(payload))
    data[offset : offset + len(payload)] = payload


def register_payload(registers):
    names = [f"x{i}" for i in range(31)] + ["sp", "pc", "pstate"]
    if set(registers) != set(names):
        raise ValueError("Incomplete or unknown peer register set")
    values = []
    for name in names:
        value = registers[name]
        if not isinstance(value, str) or not re.fullmatch(r"0x[0-9a-f]+", value):
            raise ValueError("Noncanonical peer register value")
        parsed = int(value, 16)
        if parsed >= 2**64:
            raise ValueError("Peer register exceeds uint64")
        values.append(parsed)
    return struct.pack("<34Q", *values)


def clone_snapshot(snapshot):
    register_payload(snapshot["registers"])
    images, end = [], -1
    for base, data in snapshot["images"]:
        if type(base) is not int or base < 0 or base <= end or base + len(data) > 2**64:
            raise ValueError("Overlapping, unordered, or invalid peer memory regions")
        if not isinstance(data, bytes) or not 0 < len(data) <= 32 * 1024 * 1024:
            raise ValueError("Invalid peer memory region size or type")
        images.append((base, bytearray(data)))
        end = base + len(data) - 1
    if not images:
        raise ValueError("Missing peer memory snapshot")
    return {
        "registers": dict(snapshot["registers"]),
        "images": images,
        "report": copy.deepcopy(snapshot["report"]),
    }


def private_output(path, root=ROOT):
    root = Path(root).resolve()
    work = root / "work"
    if work.is_symlink():
        raise ValueError("Private work root must not be a symlink")
    path = Path(path).resolve()
    if path == work or work not in path.parents:
        raise ValueError("Output must be a subdirectory beneath repository work/")
    return path


def messages(report, target, lengths):
    writes = report.get("ipc_writes", [])
    if len(writes) != len(lengths):
        raise ValueError("Unexpected native IPC message count")
    result = []
    for record, size in zip(writes, lengths):
        if set(record) != {"target", "payload", "pc"} or record["target"] != target:
            raise ValueError("Unexpected native IPC target or fields")
        payload = record["payload"]
        if (
            not isinstance(payload, str)
            or len(payload) != size * 2
            or not re.fullmatch("[0-9a-f]+", payload)
        ):
            raise ValueError("Unexpected native IPC payload length or encoding")
        result.append(payload)
    return {target: result}


def validate_boundary(result, stage):
    report = result["report"]
    stop, pc, digest = EXPECTED[stage]
    if (
        not report.get("constructor_returned")
        or report.get("jni_returned")
        or report.get("error")
    ):
        raise ValueError("Invalid native branch state at expected boundary")
    if report.get("stop_reason") != stop or report.get("jni_pc") != pc:
        raise ValueError("Unknown native stop, timeout, or instruction budget boundary")
    if sha(result["image"]) != digest:
        raise ValueError("Native boundary image differs from pinned recovery")


def run_branch(
    raw, branch, inputs=None, snapshot=None, seconds=60, capture_snapshot=False
):
    if sha(raw) != LIBRARY_SHA:
        raise ValueError(
            "Unrecognized support library; require pinned original 160402020 ELF"
        )
    if (
        branch not in ("parent", "child")
        or type(seconds) is not int
        or not 1 <= seconds <= 60
    ):
        raise ValueError("Invalid branch or bounded runtime budget")
    if branch == "child" and snapshot is None:
        raise ValueError("Child branch requires generated blocked-parent snapshot")
    inputs = inputs or {}
    A = SimpleNamespace(
        fork_branch=branch,
        seconds=seconds,
        cooperative_threads=True,
        defer_threads=False,
        jni=True,
    )
    from elftools.elf.elffile import ELFFile
    from unicorn import (
        UC_ARCH_ARM64,
        UC_HOOK_BLOCK,
        UC_HOOK_CODE,
        UC_HOOK_INTR,
        UC_HOOK_MEM_WRITE,
        UC_MODE_ARM,
        Uc,
        UcError,
    )
    from unicorn.arm64_const import (
        UC_ARM64_REG_CPACR_EL1,
        UC_ARM64_REG_FP,
        UC_ARM64_REG_LR,
        UC_ARM64_REG_NZCV,
        UC_ARM64_REG_PC,
        UC_ARM64_REG_SP,
        UC_ARM64_REG_TPIDR_EL0,
        UC_ARM64_REG_X0,
        UC_ARM64_REG_X1,
        UC_ARM64_REG_X8,
    )

    BASE = 0x20000000
    STACK = 0x40000000
    STUBS = 0x50000000
    HEAP = 0x60000000
    STOP = 0x70000000
    PAGE = 4096
    up = lambda n: (n + PAGE - 1) & -PAGE
    elf = ELFFile(io.BytesIO(raw))
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
    for addr, n in [
        (STACK, 0x400000),
        (STUBS, 0x100000),
        (HEAP, 0x2000000),
        (STOP, PAGE),
    ]:
        u.mem_map(addr, n)
    u.reg_write(UC_ARM64_REG_SP, STACK + 0x200000)
    u.reg_write(UC_ARM64_REG_LR, STOP)
    u.reg_write(UC_ARM64_REG_CPACR_EL1, 3 << 20)
    u.reg_write(UC_ARM64_REG_TPIDR_EL0, HEAP + 0x1000)
    thread_states = {}
    running_thread = 0
    scheduler_yield = None
    ipc_inputs = {key: list(values) for key, values in inputs.items()}
    peer = None if snapshot is None else clone_snapshot(snapshot)

    def peer_read(address, size):
        return read_peer(peer, address, size)

    def peer_write(address, data):
        write_peer(peer, address, data)

    stubnames = {}
    stubnext = STUBS
    heapnext = HEAP + 0x10000
    fds = {}
    pipes = {}
    endpoints = {}
    fd_flags = {}
    epolls = {}
    calls = []
    recent = collections.deque(maxlen=30)
    writes = []

    def stub(n):
        nonlocal stubnext
        if n == "__progname":
            u.mem_write(HEAP + 0x200, struct.pack("<Q", HEAP + 0x280))
            u.mem_write(HEAP + 0x280, b"com.supercell.clashroyale\0")
            return HEAP + 0x200
        if n == "environ":
            u.mem_write(HEAP + 0x300, struct.pack("<Q", HEAP + 0x320))
            return HEAP + 0x300
        if n == "__sF":
            return HEAP + 0x400
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
    libpath = (
        "/data/app/~~research/com.supercell.clashroyale/lib/arm64/"
        + "libsupercell_clashroyale.so"
    )
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
        "/proc/1000/task": b"",
        "/proc/sys/kernel/yama/ptrace_scope": b"1\n",
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
        "caution": "This models selected OS operations; no unknown operation is treated as success.",
    }

    def readstr(a, n=4096):
        return bytes(u.mem_read(a, n)).split(b"\0", 1)[0].decode(errors="replace")

    def q(a):
        return struct.unpack("<Q", u.mem_read(a, 8))[0]

    def malloc(n):
        nonlocal heapnext
        bounded_size(n)
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
        if n == 25 and a[1] == 3:
            return fd_flags.get(a[0], 0)
        if n == 25 and a[1] == 4:
            fd_flags[a[0]] = a[2]
            return 0
        if n == 117 and peer is not None:
            request, pid, addr, data = a[:4]
            report.setdefault("ptrace_actions", []).append(
                {"request": request, "pid": pid, "addr": hex(addr), "data": hex(data)}
            )
            if pid not in [1000, 1002]:
                raise ValueError("ptrace target differs from peer process threads")
            if request == 16:
                peer["traced"] = True
                peer["pending_stop"] = 19
                peer["pending_pid"] = pid
                return 0
            if not peer.get("traced"):
                raise ValueError("ptrace before attach")
            if request == 0x4200:
                peer["ptrace_options"] = data
                return 0
            if request == 7 and data == 0:
                peer_report = peer["report"]
                if pid == 1000 and str(peer_report.get("stop_reason", "")).startswith(
                    "IPC read requires peer activity:"
                ):
                    peer.setdefault("continued_blocked_threads", []).append(pid)
                    return 0
                if pid == 1002 and any(
                    st.get("status") == "waiting"
                    for st in peer_report.get("thread_states", {}).values()
                ):
                    peer.setdefault("continued_blocked_threads", []).append(pid)
                    return 0
                raise ValueError("PTRACE_CONT requires runnable peer CPU execution")
            if request in [1, 2]:
                u.mem_write(data, peer_read(addr, 8))
                return 0
            if request in [4, 5]:
                peer_write(addr, struct.pack("<Q", data))
                return 0
            if request == 0x4204 and addr == 1:
                ptr, length = struct.unpack("<QQ", u.mem_read(data, 16))
                payload = register_payload(peer["registers"])
                u.mem_write(ptr, payload[:length])
                u.mem_write(data + 8, struct.pack("<Q", min(length, len(payload))))
                return 0
            raise ValueError(
                "ptrace operation requires live peer semantics: " + str(request)
            )
        if n == 260 and peer is not None:
            pid, status, options, rusage = a[:4]
            if peer.get("pending_stop"):
                if status:
                    u.mem_write(
                        status,
                        struct.pack("<I", (peer.pop("pending_stop") << 8) | 0x7F),
                    )
                return peer.get("pending_pid", 1000)
            raise ValueError("wait4 requires new peer event")
        if n == 134:
            signum, act, old, size = a[:4]
            if size != 8 or signum < 1 or signum > 64 or signum in [9, 19]:
                return -22
            actions = report.setdefault("signal_actions", {})
            if old:
                u.mem_write(old, bytes.fromhex(actions.get(str(signum), "00" * 32)))
            if act:
                actions[str(signum)] = bytes(u.mem_read(act, 32)).hex()
            return 0
        if n == 135:
            how, new, old, size = a[:4]
            if size != 8 or how > 2:
                return -22
            mask = report.get("signal_mask", 0)
            if old:
                u.mem_write(old, struct.pack("<Q", mask))
            if new:
                x = q(new)
                report["signal_mask"] = (
                    mask | x if how == 0 else mask & ~x if how == 1 else x
                ) & 0xFFFFFFFFFFFFFFFF
            return 0
        if n == 226:
            return 0  # modeled memory permissions; no host mprotect
        if n == 172:
            return (
                1001 if A.fork_branch == "child" and report.get("fork_calls") else 1000
            )
        if n == 173:
            return 1000 if A.fork_branch == "child" else 900
        if n == 178:
            return (
                1001
                if A.fork_branch == "child" and report.get("fork_calls")
                else (1000 if running_thread == 0 else 1002)
            )
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
        if n == 199 and a[0] == 1 and a[1] == 1:
            fd = max([2] + list(fds)) + 1
            name = "socketpair:" + str(fd)
            pipes[name + ":0"] = bytearray()
            pipes[name + ":1"] = bytearray()
            fds[fd] = [name, 0]
            fds[fd + 1] = [name, 0]
            endpoints[fd] = (name + ":0", name + ":1")
            endpoints[fd + 1] = (name + ":1", name + ":0")
            u.mem_write(a[3], struct.pack("<II", fd, fd + 1))
            return 0
        if n == 59:
            fd = max([2] + list(fds)) + 1
            name = "pipe:" + str(fd)
            pipes[name] = bytearray()
            fds[fd] = [name, 0]
            fds[fd + 1] = [name, 0]
            endpoints[fd] = (name, None)
            endpoints[fd + 1] = (None, name)
            u.mem_write(a[0], struct.pack("<II", fd, fd + 1))
            return 0
        if n == 64:
            path, pos = fds[a[0]]
            target = endpoints.get(a[0], (None, None))[1]
            if target is None:
                raise ValueError("write only modeled to pipe/socket writer")
            payload = bytes(u.mem_read(a[1], bounded_size(a[2])))
            pipes[target].extend(payload)
            report.setdefault("ipc_writes", []).append(
                {
                    "target": target,
                    "payload": payload.hex(),
                    "pc": hex(u.reg_read(UC_ARM64_REG_PC)),
                }
            )
            return a[2]
        if n == 63:
            path, pos = fds[a[0]]
            if a[0] in endpoints:
                target = endpoints[a[0]][0]
                if target is None:
                    raise ValueError("read on write-only endpoint")
                if not pipes[target] and ipc_inputs.get(target):
                    payload = bytes.fromhex(ipc_inputs[target].pop(0))
                    pipes[target].extend(payload)
                    report.setdefault("ipc_replayed", []).append(
                        {"target": target, "payload": payload.hex()}
                    )
                if not pipes[target]:
                    raise ValueError("IPC read requires peer activity: " + target)
                data = bytes(pipes[target][: a[2]])
                del pipes[target][: len(data)]
                u.mem_write(a[1], data)
                return len(data)
            data = vfiles[path][pos : pos + a[2]]
            u.mem_write(a[1], data)
            fds[a[0]][1] += len(data)
            return len(data)
        if n == 57:
            if a[0] not in fds:
                return -9
            del fds[a[0]]
            return 0
        if n == 61:
            path, pos = fds[a[0]]
            if path != "/proc/1000/task":
                raise ValueError("unmodeled directory " + path)
            entries = [".", "..", "1000", "1002"]
            output = b""
            for i, name in enumerate(entries[pos:], start=pos):
                name = name.encode() + b"\0"
                length = (19 + len(name) + 7) & -8
                record = struct.pack("<QqHB", i + 1, i + 1, length, 4) + name
                record += bytes(length - len(record))
                if len(output) + len(record) > a[2]:
                    break
                output += record
                fds[a[0]][1] = i + 1
            u.mem_write(a[1], output)
            return len(output)
        if n == 62:
            path, pos = fds[a[0]]
            offs = a[1] - (1 << 64) if a[1] >> 63 else a[1]
            fds[a[0]][1] = offs + [0, pos, len(vfiles[path])][a[2]]
            return fds[a[0]][1]
        raise ValueError(
            "unmodelled syscall " + str(n) + " " + str([hex(x) for x in a])
        )

    def imported(uc, pc, size, _):
        nonlocal scheduler_yield
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
            elif name == "strtol" and args[2] == 10:
                text = readstr(args[0])
                match = re.match(r"\s*[+-]?\d+", text)
                v = int(match.group(0)) if match else 0
                if args[1]:
                    u.mem_write(
                        args[1],
                        struct.pack("<Q", args[0] + (match.end() if match else 0)),
                    )
            elif name == "__vsnprintf_chk":
                fmt = readstr(args[4])
                stack, grtop, vrtop, groffs, vroffs = struct.unpack(
                    "<QQQii", u.mem_read(args[5], 32)
                )
                vaarg = grtop + groffs if groffs < 0 else stack
                value = struct.unpack("<i", u.mem_read(vaarg, 4))[0]
                if fmt != "/proc/%i/task":
                    raise ValueError("unmodeled format " + fmt)
                formatted = ("/proc/" + str(value) + "/task").encode()
                calls.append({"formatted": formatted.decode()})
                v = len(formatted)
                if args[1]:
                    u.mem_write(args[0], formatted[: args[1] - 1] + b"\0")
            elif name == "waitpid":
                v = syscall(260, args[:3] + [0])
            elif name == "prctl" and args[0] == 4 and args[1] in [0, 1]:
                report["process_dumpable"] = args[1]
                v = 0
            elif name == "prctl" and args[0] == 3:
                v = report.get("process_dumpable", 1)
            elif name == "prctl" and args[0] == 0x59616D61:
                report["allowed_ptracer_pid"] = args[1]
                v = 0
            elif name == "fork" and A.fork_branch != "stop":
                prior = report.setdefault("fork_calls", [])
                if prior:
                    raise ValueError(
                        "second fork requires additional explicit branch choice"
                    )
                prior.append(
                    {
                        "branch": A.fork_branch,
                        "caller": hex(u.reg_read(UC_ARM64_REG_LR)),
                        "isolated_branch_exploration": True,
                    }
                )
                if A.fork_branch == "child":
                    for tid, state in thread_states.items():
                        if tid != running_thread:
                            state["status"] = "absent-in-fork-child"
                    v = 0
                elif A.fork_branch == "parent":
                    v = 1001
                else:
                    u.mem_write(HEAP, struct.pack("<I", 11))
                    v = -1
            elif name == "__cxa_atexit":
                report.setdefault("atexit_callbacks", []).append(
                    {"function": hex(args[0]), "arg": hex(args[1]), "dso": hex(args[2])}
                )
                v = 0
            elif name == "epoll_create1":
                v = max([2] + list(fds)) + 1
                fds[v] = ["epoll:" + str(v), 0]
                epolls[v] = {}
            elif name == "epoll_ctl":
                epfd, op, fd, event = args[:4]
                if epfd not in epolls:
                    raise ValueError("unknown epoll descriptor")
                if op in [1, 3]:
                    epolls[epfd][fd] = bytes(u.mem_read(event, 12))
                    v = 0
                elif op == 2:
                    epolls[epfd].pop(fd, None)
                    v = 0
                else:
                    raise ValueError("unknown epoll op")
            elif name == "pthread_create" and A.cooperative_threads:
                tid = 0x9000 + len(thread_states)
                thread_states[tid] = {
                    "entry": args[2],
                    "arg": args[3],
                    "context": None,
                    "status": "ready",
                }
                u.mem_write(args[0], struct.pack("<Q", tid))
                v = 0
            elif name == "pthread_self" and A.cooperative_threads:
                v = running_thread
            elif name == "pthread_cond_wait" and A.cooperative_threads:
                scheduler_yield = {"kind": "wait", "cond": args[0]}
                ret(0)
                u.emu_stop()
                return
            elif (
                name in ["pthread_cond_signal", "pthread_cond_broadcast"]
                and A.cooperative_threads
            ):
                awakened = []
                for tid, state in thread_states.items():
                    if (
                        state.get("condition") == args[0]
                        and state["status"] == "waiting"
                    ):
                        state["status"] = "ready"
                        awakened.append(tid)
                    if awakened and name == "pthread_cond_signal":
                        break
                calls.append({"condition_wakeup": hex(args[0]), "threads": awakened})
                v = 0
            elif name == "pthread_detach" and A.cooperative_threads:
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
                u.mem_write(args[0], bytes(u.mem_read(args[1], bounded_size(args[2]))))
                v = args[0]
            elif name in ["memset", "__memset_chk"]:
                u.mem_write(args[0], bytes([args[1] & 255]) * bounded_size(args[2]))
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
                props = {"ro.build.version.sdk": b"35", "ro.kernel.version": b""}
                if key not in props:
                    raise ValueError("unmodelled property " + key)
                value = props[key]
                u.mem_write(args[1], value + b"\0")
                v = len(value)
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
                l = readstr(args[0])
                r = readstr(args[1])
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
        try:
            if n != 2:
                raise ValueError("unsupported native interrupt " + str(n))
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

    def capture_native_cipher(uc, address, size, _):
        args = [u.reg_read(UC_ARM64_REG_X0 + i) for i in range(6)]
        out, source, length, nonce, key, rounds = args
        report.setdefault("native_cipher_calls", []).append(
            {
                "entry": hex(address),
                "out": hex(out),
                "in": hex(source),
                "length": length,
                "nonce": bytes(u.mem_read(nonce, 8)).hex(),
                "key": bytes(u.mem_read(key, 32)).hex(),
                "rounds": rounds,
                "return": hex(u.reg_read(UC_ARM64_REG_LR)),
                "input_sha256": hashlib.sha256(
                    u.mem_read(source, bounded_size(length))
                ).hexdigest(),
            }
        )

    u.hook_add(
        UC_HOOK_CODE, capture_native_cipher, begin=BASE + 0x68192C, end=BASE + 0x68192C
    )
    u.hook_add(UC_HOOK_CODE, imported, begin=STUBS, end=STUBS + 0xFFFFF)
    u.hook_add(UC_HOOK_INTR, intr)
    u.hook_add(UC_HOOK_BLOCK, block)
    u.hook_add(UC_HOOK_MEM_WRITE, wr, begin=BASE + 0x6C6470, end=BASE + 0x6C6477)
    relocated_image = bytes(u.mem_read(BASE, imagesize))
    report["runtime_callback_before"] = hex(q(BASE + 0x6C6470))
    inits = [
        q(BASE + tags["DT_INIT_ARRAY"] + i)
        for i in range(0, tags["DT_INIT_ARRAYSZ"], 8)
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
    if (
        not report["constructor_returned"]
        or report.get("stop_reason")
        or report.get("error")
    ):
        raise ValueError("Original constructor did not return cleanly")
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
        vm, vmvt, env, envvt = (
            HEAP + 0x3000,
            HEAP + 0x4000,
            HEAP + 0x5000,
            HEAP + 0x6000,
        )
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
            if not A.cooperative_threads:
                u.emu_start(
                    BASE + 0x68179C, STOP, timeout=A.seconds * 1000000, count=1000000000
                )
            else:
                u.reg_write(UC_ARM64_REG_PC, BASE + 0x68179C)
                thread_states[0] = {"context": u.context_save(), "status": "ready"}
                deadline = time.monotonic() + A.seconds
                switches = []
                while time.monotonic() < deadline:
                    ready = [
                        tid
                        for tid, state in thread_states.items()
                        if state["status"] == "ready"
                    ]
                    if not ready:
                        report["scheduler_stop"] = "no runnable threads"
                        break
                    running_thread = ready[0]
                    state = thread_states[running_thread]
                    scheduler_yield = None
                    if state["context"] is not None:
                        u.context_restore(state["context"])
                    else:
                        for i in range(29):
                            u.reg_write(UC_ARM64_REG_X0 + i, 0)
                        u.reg_write(UC_ARM64_REG_X0, state["arg"])
                        u.reg_write(
                            UC_ARM64_REG_SP,
                            STACK + 0x300000 + (running_thread - 0x9000) * 0x20000,
                        )
                        u.reg_write(UC_ARM64_REG_LR, STOP)
                        u.reg_write(UC_ARM64_REG_PC, state["entry"])
                    switches.append(
                        {
                            "thread": running_thread,
                            "pc": hex(u.reg_read(UC_ARM64_REG_PC)),
                        }
                    )
                    u.emu_start(
                        u.reg_read(UC_ARM64_REG_PC),
                        STOP,
                        timeout=min(A.seconds, 5) * 1000000,
                        count=10000000,
                    )
                    state["context"] = u.context_save()
                    if report.get("stop_reason"):
                        break
                    if u.reg_read(UC_ARM64_REG_PC) == STOP:
                        state["status"] = "returned"
                        if running_thread == 0:
                            break
                    elif scheduler_yield:
                        state["status"] = "waiting"
                        state["condition"] = scheduler_yield["cond"]
                    else:
                        report["scheduler_timeslices"] = (
                            report.get("scheduler_timeslices", 0) + 1
                        )
                report["thread_schedule"] = switches
                report["thread_states"] = {
                    str(tid): {
                        k: (hex(v) if k in ["entry", "arg", "condition"] else v)
                        for k, v in st.items()
                        if k != "context"
                    }
                    for tid, st in thread_states.items()
                }
        except UcError as e:
            report["error"] = str(e)
        report["jni_pc"] = hex(u.reg_read(UC_ARM64_REG_PC))
        report["jni_returned"] = u.reg_read(UC_ARM64_REG_PC) == STOP
        report["jni_return_value"] = hex(u.reg_read(UC_ARM64_REG_X0))
    text_start, text_end = 0x18D0A0, 0x62FAC8
    report["primary_text"] = {
        "start": hex(text_start),
        "end": hex(text_end),
        "length": text_end - text_start,
        "before_sha256": hashlib.sha256(
            constructor_image[text_start:text_end]
        ).hexdigest(),
        "after_sha256": hashlib.sha256(
            u.mem_read(BASE + text_start, text_end - text_start)
        ).hexdigest(),
        "changed_bytes": sum(
            x != y
            for x, y in zip(
                constructor_image[text_start:text_end],
                bytes(u.mem_read(BASE + text_start, text_end - text_start)),
            )
        ),
    }
    report["post_constructor_changed_bytes"] = sum(
        x != y for x, y in zip(constructor_image, bytes(u.mem_read(BASE, imagesize)))
    )
    report["runtime_callback_after"] = hex(q(BASE + 0x6C6470))
    report["callback_writes"] = writes
    report["recent_blocks"] = list(recent)
    report["registers"] = {
        f"x{i}": hex(u.reg_read(UC_ARM64_REG_X0 + i)) for i in range(29)
    }
    report["registers"]["lr"] = hex(u.reg_read(UC_ARM64_REG_LR))
    report["registers"]["sp"] = hex(u.reg_read(UC_ARM64_REG_SP))

    image = bytes(u.mem_read(BASE, imagesize))
    registers = {f"x{i}": hex(u.reg_read(UC_ARM64_REG_X0 + i)) for i in range(29)}
    registers.update(
        {
            "x29": hex(u.reg_read(UC_ARM64_REG_FP)),
            "x30": hex(u.reg_read(UC_ARM64_REG_LR)),
            "sp": hex(u.reg_read(UC_ARM64_REG_SP)),
            "pc": hex(u.reg_read(UC_ARM64_REG_PC)),
            "pstate": hex(u.reg_read(UC_ARM64_REG_NZCV)),
        }
    )
    result_snapshot = (
        {
            "registers": registers,
            "report": report,
            "images": [
                (start, bytes(u.mem_read(start, end - start + 1)))
                for start, end, permissions in u.mem_regions()
            ],
        }
        if capture_snapshot
        else None
    )
    if any(values for values in ipc_inputs.values()):
        raise ValueError("Native branch left unconsumed replay messages")
    return {
        "report": report,
        "image": image,
        "constructor_image": constructor_image,
        "snapshot": result_snapshot,
    }


def recover(library, out, seconds=60):
    library = Path(library)
    if library.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("Library exceeds pinned input size bound")
    raw = library.read_bytes()
    if sha(raw) != LIBRARY_SHA:
        raise ValueError(
            "Unrecognized support library; require pinned original 160402020 ELF"
        )
    out = private_output(out)
    out.mkdir(parents=True, exist_ok=True)
    for name in (
        "runtime-memory.bin",
        "constructor-memory.bin",
        "capture-private.json",
        "public-summary.json",
    ):
        if (out / name).is_symlink():
            raise ValueError("Output file must not be a symlink")
    parent = run_branch(raw, "parent", seconds=seconds, capture_snapshot=True)
    validate_boundary(parent, "parent_blocked")
    parent_messages = messages(parent["report"], "pipe:3", [4])
    child = run_branch(raw, "child", parent_messages, parent["snapshot"], seconds)
    validate_boundary(child, "child_replied")
    child_messages = messages(child["report"], "pipe:5", [4, 32])
    decoded = run_branch(raw, "parent", child_messages, seconds=seconds)
    validate_boundary(decoded, "parent_decoded")
    region = decoded["image"][0x18D0A0:0x62FAC8]
    if len(region) != 4860456 or sha(region) != TEXT_SHA:
        raise ValueError("Recovered main text differs from pinned native output")
    capture = decoded["report"]
    summary = {
        "schema_version": 1,
        "scope": "Original native support-text recovery under explicit OS models; Android/JNI initialization remains incomplete.",
        "library_sha256": LIBRARY_SHA,
        "image_sha256": sha(decoded["image"]),
        "image_bytes": len(decoded["image"]),
        "constructor_image_sha256": sha(decoded["constructor_image"]),
        "main_text": capture["primary_text"],
        "stages": [
            {
                "name": name,
                "constructor_returned": True,
                "jni_returned": False,
                "stop_reason": value["report"]["stop_reason"],
                "pc": value["report"]["jni_pc"],
                "image_sha256": sha(value["image"]),
                "ipc_written_lengths": [
                    len(bytes.fromhex(item["payload"]))
                    for item in value["report"].get("ipc_writes", [])
                ],
                "ipc_replayed_lengths": [
                    len(bytes.fromhex(item["payload"]))
                    for item in value["report"].get("ipc_replayed", [])
                ],
                "thread_states": value["report"].get("thread_states", {}),
            }
            for name, value in [
                ("parent_blocked", parent),
                ("child_replied", child),
                ("parent_decoded", decoded),
            ]
        ],
        "assumptions": [
            "Synthetic libc symbol ELF, Android process/maps/sysfs files, SDK35, empty kernel version, deterministic research entropy",
            "Original worker code cooperatively scheduled; mutex operations no-op, condition waits/signals modeled, no real parallel execution",
            "Fork branches rerun from deterministic initial state; generated original IPC writes replayed in order",
            "Child ptrace reads/writes only an in-memory blocked-parent snapshot; continued blocked threads do not execute",
            "Synthetic PID/TID/UID values, pipes, socketpair, epoll registrations, signals, and process-control state",
            "Bump allocation with no reclamation; mapped memory permissions accessible, mprotect modeled as success",
            "Unknown imports/syscalls/interrupts stop; only the three pinned partial-initialization boundaries accepted",
            "No host syscall forwarding, actual fork/ptrace, Android ART/Bionic, account, game network, or battle simulation",
        ],
        "native_cipher_calls": [
            {
                "entry": c["entry"],
                "length": c["length"],
                "rounds": c["rounds"],
                "input_sha256": c["input_sha256"],
            }
            for c in capture.get("native_cipher_calls", [])
        ],
        "private_outputs": [
            "runtime-memory.bin",
            "constructor-memory.bin",
            "capture-private.json",
        ],
    }
    (out / "runtime-memory.bin").write_bytes(decoded["image"])
    (out / "constructor-memory.bin").write_bytes(decoded["constructor_image"])
    (out / "capture-private.json").write_text(json.dumps(capture, indent=2) + "\n")
    (out / "public-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--library", type=Path, required=True, help="Pinned original ARM64 support ELF"
    )
    parser.add_argument(
        "--out",
        type=Path,
        required=True,
        help="New output subdirectory beneath repository work/",
    )
    parser.add_argument(
        "--seconds",
        type=int,
        default=60,
        help="Maximum runtime per native stage, 1..60",
    )
    args = parser.parse_args()
    try:
        summary = recover(args.library, args.out, args.seconds)
    except (ValueError, OSError) as error:
        print(f"Recovery rejected: {error}", file=sys.stderr)
        return 1
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
