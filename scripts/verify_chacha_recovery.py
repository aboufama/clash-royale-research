#!/usr/bin/env python3
"""Compare a portable ChaCha transform with the original ARM64 implementation.

Reads a locally captured call's parameters; does not publish keys or native bytes.
Runs only the isolated cipher, without Android startup or host syscall forwarding.
A matching result proves agreement for these bytes, not gameplay equivalence.
"""

import argparse
import hashlib
import json
import struct
from pathlib import Path

MASK = 0xFFFFFFFF


def sha(data):
    return hashlib.sha256(data).hexdigest()


def rotate(v, n):
    return ((v << n) | (v >> (32 - n))) & MASK


def quarter(s, a, b, c, d):
    s[a] = (s[a] + s[b]) & MASK
    s[d] = rotate(s[d] ^ s[a], 16)
    s[c] = (s[c] + s[d]) & MASK
    s[b] = rotate(s[b] ^ s[c], 12)
    s[a] = (s[a] + s[b]) & MASK
    s[d] = rotate(s[d] ^ s[a], 8)
    s[c] = (s[c] + s[d]) & MASK
    s[b] = rotate(s[b] ^ s[c], 7)


def transform(data, key, nonce, rounds=8):
    if len(key) != 32 or len(nonce) != 8 or rounds <= 0 or rounds % 2:
        raise ValueError("Require a 32-byte key, 8-byte nonce and positive even rounds")
    initial = (
        list(struct.unpack("<4I", b"expand 32-byte k"))
        + list(struct.unpack("<8I", key))
        + [0, 0]
        + list(struct.unpack("<2I", nonce))
    )
    output = bytearray(len(data))
    for offset in range(0, len(data), 64):
        block = offset // 64
        initial[12] = block & MASK
        initial[13] = block >> 32
        s = initial.copy()
        for _ in range(rounds // 2):
            quarter(s, 0, 4, 8, 12)
            quarter(s, 1, 5, 9, 13)
            quarter(s, 2, 6, 10, 14)
            quarter(s, 3, 7, 11, 15)
            quarter(s, 0, 5, 10, 15)
            quarter(s, 1, 6, 11, 12)
            quarter(s, 2, 7, 8, 13)
            quarter(s, 3, 4, 9, 14)
        stream = struct.pack("<16I", *((x + y) & MASK for x, y in zip(s, initial)))
        output[offset : offset + 64] = bytes(
            x ^ y for x, y in zip(data[offset : offset + 64], stream)
        )
    return bytes(output)


def load_elf(path):
    from elftools.elf.elffile import ELFFile

    with path.open("rb") as f:
        elf = ELFFile(f)
        if elf["e_machine"] != "EM_AARCH64":
            raise ValueError("Require an ARM64 ELF")
        loads = [s for s in elf.iter_segments() if s["p_type"] == "PT_LOAD"]
        memory = bytearray(max(s["p_vaddr"] + s["p_memsz"] for s in loads))
        for s in loads:
            memory[s["p_vaddr"] : s["p_vaddr"] + s["p_filesz"]] = s.data()
        return bytes(memory)


def validate_native(image, entry):
    from unicorn import Uc, UC_ARCH_ARM64, UC_MODE_ARM
    from unicorn.arm64_const import (
        UC_ARM64_REG_SP,
        UC_ARM64_REG_LR,
        UC_ARM64_REG_X0,
        UC_ARM64_REG_PC,
        UC_ARM64_REG_TPIDR_EL0,
        UC_ARM64_REG_CPACR_EL1,
    )

    base, stack, buf, stop = 0x20000000, 0x40000000, 0x60000000, 0x70000000
    if not 0 <= entry < len(image):
        raise ValueError("Native entry outside ELF memory image")
    trials = []
    for rounds in [8, 20]:
        for size in [0, 1, 63, 64, 65, 1024]:
            u = Uc(UC_ARCH_ARM64, UC_MODE_ARM)
            u.mem_map(base, (len(image) + 4095) & -4096)
            u.mem_write(base, image)
            for address, length in [(stack, 0x20000), (buf, 0x20000), (stop, 4096)]:
                u.mem_map(address, length)
            key, nonce = bytes(range(32)), bytes(range(8))
            data = bytes((n * 73 + 19) & 255 for n in range(size))
            u.mem_write(buf, data)
            u.mem_write(buf + 0x10000, key)
            u.mem_write(buf + 0x11000, nonce)
            args = [buf + 0x8000, buf, size, buf + 0x11000, buf + 0x10000, rounds]
            for i, value in enumerate(args):
                u.reg_write(UC_ARM64_REG_X0 + i, value)
            u.reg_write(UC_ARM64_REG_SP, stack + 0x10000)
            u.reg_write(UC_ARM64_REG_LR, stop)
            u.reg_write(UC_ARM64_REG_TPIDR_EL0, stack)
            u.reg_write(UC_ARM64_REG_CPACR_EL1, 3 << 20)
            u.emu_start(base + entry, stop, timeout=5000000, count=10000000)
            result = bytes(u.mem_read(buf + 0x8000, size))
            trials.append(
                {
                    "rounds": rounds,
                    "length": size,
                    "native_returned": u.reg_read(UC_ARM64_REG_PC) == stop,
                    "matches": result == transform(data, key, nonce, rounds),
                    "output_sha256": sha(result),
                }
            )
    return trials


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--library", type=Path, required=True, help="Original ARM64 support ELF"
    )
    p.add_argument(
        "--capture-report",
        type=Path,
        required=True,
        help="Private report containing native_cipher_calls",
    )
    p.add_argument(
        "--memory",
        type=Path,
        required=True,
        help="Pre-transform flat image, ELF VA 0 at file offset 0",
    )
    p.add_argument(
        "--decoded-memory",
        type=Path,
        required=True,
        help="Native post-transform image in same layout",
    )
    p.add_argument("--input-va", type=lambda s: int(s, 0), default=0x18D0A0)
    p.add_argument("--native-entry", type=lambda s: int(s, 0), default=0x68192C)
    p.add_argument("--out", type=Path, required=True)
    a = p.parse_args()
    raw, image, decoded = (
        a.library.read_bytes(),
        a.memory.read_bytes(),
        a.decoded_memory.read_bytes(),
    )
    capture_bytes = a.capture_report.read_bytes()
    capture = json.loads(capture_bytes)
    if sha(raw) != capture["input_sha256"]:
        raise ValueError("Original library hash differs from captured input identity")
    base = int(capture["load_base"], 0)
    calls = [
        c
        for c in capture["native_cipher_calls"]
        if int(c["entry"], 0) == base + a.native_entry
        and int(c["in"], 0) == base + a.input_va
    ]
    if len(calls) != 1:
        raise ValueError(
            "Require exactly one captured call matching entry and input VA"
        )
    call = calls[0]
    length = int(call["length"])
    out_va = int(call["out"], 0) - base
    if (
        length <= 0
        or a.input_va < 0
        or out_va < 0
        or a.input_va + length > len(image)
        or out_va + length > len(decoded)
    ):
        raise ValueError("Captured input/output range outside supplied images")
    ciphertext = image[a.input_va : a.input_va + length]
    if sha(ciphertext) != call["input_sha256"]:
        raise ValueError("Pre-transform bytes differ from captured cipher input")
    portable = transform(
        ciphertext,
        bytes.fromhex(call["key"]),
        bytes.fromhex(call["nonce"]),
        int(call["rounds"]),
    )
    native = decoded[out_va : out_va + length]
    report = {
        "schema_version": 1,
        "library_sha256": sha(raw),
        "capture_report_sha256": sha(capture_bytes),
        "memory_sha256": sha(image),
        "decoded_memory_sha256": sha(decoded),
        "scope": "Original isolated cipher agreement; not Android/runtime/gameplay validation.",
        "native_entry_elf_va": hex(a.native_entry),
        "native_trials": validate_native(load_elf(a.library), a.native_entry),
        "captured_transform": {
            "input_elf_va": hex(a.input_va),
            "output_elf_va": hex(out_va),
            "size": length,
            "rounds": int(call["rounds"]),
            "ciphertext_sha256": sha(ciphertext),
            "portable_plaintext_sha256": sha(portable),
            "native_plaintext_sha256": sha(native),
            "byte_identical": portable == native,
            "matching_bytes": sum(x == y for x, y in zip(portable, native)),
        },
    }
    report["verified"] = report["captured_transform"]["byte_identical"] and all(
        t["native_returned"] and t["matches"] for t in report["native_trials"]
    )
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return 0 if report["verified"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
