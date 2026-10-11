"""Read ARM64 ELF dynamic symbols from program headers, including stripped ELFs."""

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
from elftools.elf.elffile import ELFFile

SYMBOL_TYPES = {
    "STT_NOTYPE": 0,
    "STT_OBJECT": 1,
    "STT_FUNC": 2,
    "STT_SECTION": 3,
    "STT_FILE": 4,
    "STT_COMMON": 5,
    "STT_TLS": 6,
    "STT_GNU_IFUNC": 10,
}
SPECIAL_SECTIONS = {"SHN_UNDEF": 0, "SHN_ABS": 65521, "SHN_COMMON": 65522}


def inspect(path, output):
    path, output = Path(path), Path(output)
    with path.open("rb") as stream:
        elf = ELFFile(stream)
        if (
            elf.elfclass != 64
            or not elf.little_endian
            or elf["e_machine"] != "EM_AARCH64"
        ):
            raise ValueError(
                "This inspection currently requires an ARM64 little-endian ELF"
            )
        dynamic = next(
            segment
            for segment in elf.iter_segments()
            if segment["p_type"] == "PT_DYNAMIC"
        )
        symbols = []
        for index, symbol in enumerate(dynamic.iter_symbols()):
            section = symbol["st_shndx"]
            symbols.append(
                {
                    "index": index,
                    "name": symbol.name,
                    "address": hex(symbol["st_value"]),
                    "size": symbol["st_size"],
                    "section_index": (
                        section
                        if isinstance(section, int)
                        else SPECIAL_SECTIONS[section]
                    ),
                    "type": SYMBOL_TYPES.get(
                        symbol["st_info"]["type"], symbol["st_info"]["type"]
                    ),
                }
            )
        metadata = {
            "library": path.name,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "bytes": path.stat().st_size,
            "machine": elf["e_machine"],
            "dynamic_symbols": len(symbols),
            "defined_functions": sum(
                s["type"] == 2 and s["section_index"] != 0 for s in symbols
            ),
            "sections": [section.name for section in elf.iter_sections()],
            "dynamic_tags": {
                tag.entry.d_tag: tag.entry.d_val
                for tag in dynamic.iter_tags()
                if tag.entry.d_tag != "DT_NEEDED"
            },
            "needed_libraries": [tag.needed for tag in dynamic.iter_tags("DT_NEEDED")],
            "load_segments": [
                dict(segment.header)
                for segment in elf.iter_segments()
                if segment["p_type"] == "PT_LOAD"
            ],
        }
    output.mkdir(parents=True, exist_ok=True)
    (output / f"{path.name}.dynamic-symbols.json").write_text(
        json.dumps(symbols, indent=2) + "\n"
    )
    (output / f"{path.name}.metadata.json").write_text(
        json.dumps(metadata, indent=2) + "\n"
    )
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("library", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(inspect(args.library, args.output), indent=2))


if __name__ == "__main__":
    main()
