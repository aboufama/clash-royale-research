// Static analysis only: never executes code from the input library.
// @category ClashRoyaleResearch
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.mem.MemoryBlock;
import java.nio.file.*;
import java.io.*;

public class InspectNative extends GhidraScript {
    public void run() throws Exception {
        String[] args = getScriptArgs();
        Path output = Paths.get(args[0]);
        Files.createDirectories(output);
        String program = currentProgram.getName();
        try (PrintWriter metadata = new PrintWriter(output.resolve(program + ".ghidra.txt").toFile())) {
            metadata.println("Input: " + program);
            metadata.println("Language: " + currentProgram.getLanguageID());
            metadata.println("Image base: " + currentProgram.getImageBase());
            metadata.println("Static decompiler output; names and types may be inferred.");
            for (MemoryBlock block : currentProgram.getMemory().getBlocks()) {
                metadata.println(block.getName() + " " + block.getStart() + "-" + block.getEnd()
                    + " execute=" + block.isExecute());
            }
            DecompInterface decompiler = new DecompInterface();
            decompiler.openProgram(currentProgram);
            try {
                for (int i = 1; i < args.length; i++) {
                    String[] parts = args[i].split(":", 2);
                    Address address = toAddr(parts[0]);
                    String label = parts.length > 1 ? parts[1] : "function_" + parts[0];
                    disassemble(address);
                    Function function = getFunctionAt(address);
                    if (function == null) function = createFunction(address, label);
                    if (function == null) {
                        metadata.println(label + " @ " + address + ": no valid function recovered");
                        continue;
                    }
                    DecompileResults result = decompiler.decompileFunction(function, 40, monitor);
                    metadata.println(label + " @ " + address + ": completed=" + result.decompileCompleted()
                        + "; " + result.getErrorMessage());
                    if (result.decompileCompleted()) {
                        String text = "/* Input: " + program + "; address: " + address
                            + "; static Ghidra pseudocode, not original source. */\n"
                            + result.getDecompiledFunction().getC();
                        Files.writeString(output.resolve(program + "__" + label + ".c"), text);
                    }
                }
            } finally { decompiler.dispose(); }
        }
    }
}
