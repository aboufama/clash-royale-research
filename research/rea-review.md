# REA applicability review

Reviewed on 2026-10-11 at commit
[`21650455a9c90a26e725c3505a3c17054cc4516c`](https://github.com/morluto/rea/tree/21650455a9c90a26e725c3505a3c17054cc4516c).
The checkout declares package version 6.4.0. This assessment identifies the
source revision, not the potentially different npm package with that version.

**Decision: retain REA as a useful native-analysis reference and candidate
Ghidra interface. It does not supply the missing Clash Royale runtime or an
exact battle simulator.** Its most relevant additions are structured function
analysis, static value-flow tracing, and preservation of evidence across agent
sessions. Any speed improvement on this project remains unmeasured.

## Review scope

The checkout contains 2,671 files, excluding Git metadata. We inventoried the
repository and divided source review across native providers, Android/runtime
providers, evidence/testing workflows, and core composition/setup. We followed
the relevant documentation into implementations, contracts, bridges and tests.
This is a project-applicability review, not a claim that every line of the
repository, every dependency, or every unrelated browser/.NET feature has been
audited. No REA installation, setup, test suite, or provider execution was run
during this review. Statements about upstream real-provider verification are
the repository's documented claims, not tests reproduced here.

## What it actually implements

| Area | Implementation and relevance |
| --- | --- |
| Native decompilation | Adapters to real Ghidra, Hopper and IDA. Useful for querying native functions; REA itself is not a new decompiler or a Clash Royale implementation. |
| Ghidra investigation | Instructions, pseudocode, references, callers/callees, control-flow graphs, type inspection, p-code graphs and bounded cross-function value tracing. This is the strongest candidate for our remaining initialization investigation. |
| Android bytecode | A real headless JADX bridge for manifest, classes, methods and references. Useful for Java/JNI startup; it does not decompile or execute the native C++ engine. |
| Android device operations | ADB package/device inspection, acquisition, logs, screenshots, transfers and lifecycle operations. Requires an existing device/emulator; it does not create our Android reference runtime. |
| Native runtime tracing | An LLDB call-entry observer for executable Mach-O targets. The implementation rejects our Android ELF target. |
| Offline ELF diagnostics | The pwntools adapter at this revision is restricted to a Linux x64 host and x86-64 ELF target. This restriction does not apply to REA's separate Ghidra ARM64 support. |
| Process capture | Executes a supplied host command and records terminal/filesystem/process observations. It could wrap our probes, but cannot discover complete guest battle state without our own instrumentation. |
| Evidence and snapshots | Artifact digests, provider/profile identity, recorded limitations, unknowns, comparisons and replayable exact-query results. Useful patterns for keeping analysis claims tied to their inputs. |
| JavaScript, Electron, browser, .NET, firmware and EVM | Broad additional functionality with little direct relevance to the pinned Android native battle engine. These paths are not a reason to migrate the current harness. |

The shared CLI/MCP composition instantiates the existing native providers in
[`src/composition/binary.ts`](https://github.com/morluto/rea/blob/21650455a9c90a26e725c3505a3c17054cc4516c/src/composition/binary.ts).
The [architecture map](https://github.com/morluto/rea/blob/21650455a9c90a26e725c3505a3c17054cc4516c/docs/architecture.mermaid)
shows the wider provider/application/contract boundaries.

## Useful native-analysis capabilities

REA's Ghidra bridge uses the original Ghidra decompiler and analysis APIs. Its
function dossiers combine pseudocode, listing instructions, references and
control-flow information. The value tracer then links recovered parameters
and return values across statically resolved calls. This could help trace the
native table registry, asset manifest, constructors and initialization order.
The result is a decompiler-derived dependency graph: unresolved indirect calls,
memory aliasing, side effects and persistent state remain unknown.

Call-target resolution projects existing Ghidra references; it does not
independently recover every vtable destination. Our native virtual-call tracing
is still needed. Type inspection reads types already in the Program; the exposed
metadata mutations do not provide general structure/prototype import.

The graph is explicitly bounded. A function dossier retains at most 3,000
high-p-code operations, 64 inputs per operation and 12,000 def-use edges. Traces
have their own depth/function/node/edge budgets and report truncation. These
limits matter for large initialization functions and must not be interpreted
as complete runtime behavior.

Sources: [Ghidra bridge](https://github.com/morluto/rea/blob/21650455a9c90a26e725c3505a3c17054cc4516c/bridge/ghidra/ReaGhidraBridge.java),
[provider semantics](https://github.com/morluto/rea/blob/21650455a9c90a26e725c3505a3c17054cc4516c/docs/ghidra-provider.md),
[value-trace implementation](https://github.com/morluto/rea/blob/21650455a9c90a26e725c3505a3c17054cc4516c/src/application/native/NativeValueTrace.ts),
[trace contract](https://github.com/morluto/rea/blob/21650455a9c90a26e725c3505a3c17054cc4516c/src/domain/native/nativeValueTrace.ts).

### Integration costs for this project

We already have Ghidra, targeted decompilation scripts, recovered original ARM64
code, and isolated native execution. REA's benefit would be the interface and
analysis aggregation around those tools. It does not repeat our protection
recovery automatically or supply the missing native object state.

REA imports a new temporary Ghidra project. It does not attach to our existing
Ghidra database. Closing or cancelling its session discards session annotations;
analysis snapshots retain eligible results rather than a complete provider
database. New queries can require another import. A long-lived session is
therefore the relevant trial for a large native image.

The reviewed Ghidra path also lacks a general ARM64 raw-binary loader with a
caller-supplied base and segment map. Its prepared raw DOS COM path is a
separate special case. A language override alone does not provide that mapping.

Our recovered flat memory image and the original ELF are different artifacts.
Even if a memory image retains an ELF header, its bytes may occupy virtual-image
offsets rather than the file offsets declared by that header. Correct mappings
must be established before trusting any new provider's addresses, references or
decompilation. Analysis-only call normalization must retain separate provenance
and must never replace the original bytes used for execution.

REA supports explicit language/compiler selection and function/code/label seed
files, with the seed digest included in the analysis profile. Seeds are caller
assertions, not independently discovered facts. These controls are useful, but
are not a complete importer for our existing recovered image and type database.
In particular, a function seed specifies a start, not an exact body or end;
our unwind-derived function boundaries would need separate preservation.

One favorable compatibility detail is that REA documents real-provider checks
against Ghidra 12.1.4, the version already used here. This reduces version
uncertainty without demonstrating a correct import of our target.

Sources: [headless invocation](https://github.com/morluto/rea/blob/21650455a9c90a26e725c3505a3c17054cc4516c/src/ghidra/GhidraLauncher.ts#L397),
[target admission](https://github.com/morluto/rea/blob/21650455a9c90a26e725c3505a3c17054cc4516c/src/domain/binaryTarget.ts#L35),
[seed implementation](https://github.com/morluto/rea/blob/21650455a9c90a26e725c3505a3c17054cc4516c/src/ghidra/GhidraAnalysisSeeds.ts),
[snapshot cache](https://github.com/morluto/rea/blob/21650455a9c90a26e725c3505a3c17054cc4516c/src/application/binary/AnalysisSnapshotCache.ts),
[installation controls](https://github.com/morluto/rea/blob/21650455a9c90a26e725c3505a3c17054cc4516c/docs/installation.md#ghidra-import-language-and-analysis-seeds).

### Hopper and IDA alternatives

Hopper's bridge calls the installed application's decompiler and can open a
Hopper database. It supplies another decompiler view, but not a way to attach
our Ghidra project, and its dossiers do not provide the Ghidra p-code value-flow
graph. The IDA provider forwards operations to a separately configured upstream
MCP service; IDA/Hex-Rays is not bundled. Its current dossier has narrower
reference/body/CFG coverage, with omitted information left unknown. Neither
alternative supplies a compelling immediate advantage over our installed
Ghidra for this task.

Sources: [Hopper bridge](https://github.com/morluto/rea/blob/21650455a9c90a26e725c3505a3c17054cc4516c/bridge/hopper_bridge.py),
[Hopper launch](https://github.com/morluto/rea/blob/21650455a9c90a26e725c3505a3c17054cc4516c/src/hopper/BridgeLauncher.ts),
[IDA operations](https://github.com/morluto/rea/blob/21650455a9c90a26e725c3505a3c17054cc4516c/src/ida/IdaOperationRunner.ts),
[IDA limits](https://github.com/morluto/rea/blob/21650455a9c90a26e725c3505a3c17054cc4516c/src/ida/IdaProviderCapabilities.ts).

## Runtime capabilities that do not solve our remaining work

There is no implemented Frida instrumentation provider in the reviewed source.
Frida appears in ADB examples and as a separate future instrumentation lane.
The ADB provider does not manage or start an emulator.

The native call observer has a concrete Mach-O executable admission check. It
captures call entries and integer argument registers; it does not capture all
returns, floating-point arguments or stack arguments. Its ARM64 support is not
an Android ELF execution environment.

Unicorn is mentioned because upstream pwntools can use it to infer PLT entries.
That is not a general ARM64 guest execution API. We found no original-game
loader, complete Bionic/JNI environment, battle reset/tick interface, or complete
Clash Royale state capture in REA. Our native execution and dependency recovery
remain necessary.

Sources: [ADB provider](https://github.com/morluto/rea/blob/21650455a9c90a26e725c3505a3c17054cc4516c/src/adb/AdbProvider.ts#L391),
[ADB limits](https://github.com/morluto/rea/blob/21650455a9c90a26e725c3505a3c17054cc4516c/docs/adb-device-analysis.md),
[native call admission](https://github.com/morluto/rea/blob/21650455a9c90a26e725c3505a3c17054cc4516c/src/native/NativeCallObservation.ts#L24),
[pwntools decoder](https://github.com/morluto/rea/blob/21650455a9c90a26e725c3505a3c17054cc4516c/bridge/pwntools/layout_impl.py#L119),
[process capture](https://github.com/morluto/rea/blob/21650455a9c90a26e725c3505a3c17054cc4516c/docs/process-capture.md).

## Exactness and evidence

REA's evidence design is useful: it preserves artifact identity, observed facts,
derived findings and unknowns. Snapshot reuse checks both the target and the
provider's analysis profile. These practices fit this project's requirement to
pin inputs and reject unsupported claims.

Its content hashes establish internal record integrity, not independent truth
about a provider's output. The dependency-aware obligation ledger is a useful
pattern: a missing initialization dependency should remain open even when an
earlier isolated probe passed. Native runtime claims still need native evidence.

Its function comparator compares recorded names, text, references and normalized
control-flow structure. It is not a proof that two functions implement identical
machine semantics. Equal decompiler text or matching finite observations cannot
establish complete battle-state equality.

The reconstruction-readiness verifier is a repository conformance test with
source-owned fixtures, not a public tool that certifies arbitrary game
equivalence. Its rule that unknown, truncated or unsupported evidence must not
aggregate into a pass is useful. Its particular reconstruction objectives are
not substitutes for our own original-engine acceptance criteria.

Sources: [function comparison](https://github.com/morluto/rea/blob/21650455a9c90a26e725c3505a3c17054cc4516c/src/domain/functionComparison.ts),
[comparison dimensions](https://github.com/morluto/rea/blob/21650455a9c90a26e725c3505a3c17054cc4516c/src/domain/functionComparisonDimensions.ts),
[claim verifier](https://github.com/morluto/rea/blob/21650455a9c90a26e725c3505a3c17054cc4516c/src/domain/reconstructionVerification.ts#L66),
[obligation ledgers](https://github.com/morluto/rea/blob/21650455a9c90a26e725c3505a3c17054cc4516c/docs/reconstruction-obligation-ledgers.md),
[readiness scope](https://github.com/morluto/rea/blob/21650455a9c90a26e725c3505a3c17054cc4516c/docs/reconstruction-readiness.md).

The reviewed tests include negative cases for incomplete authority, active
unknowns, mismatched identities and tampered evidence. The project separates
injected-provider tests from real-provider verifier lanes. Its CI selects lanes
based on changes, so a generic green badge does not mean every provider was
exercised on that commit. These are useful testing practices; we have not
independently run REA's suite. See [testing guidance](https://github.com/morluto/rea/blob/21650455a9c90a26e725c3505a3c17054cc4516c/docs/testing.md)
and [CI selection](https://github.com/morluto/rea/blob/21650455a9c90a26e725c3505a3c17054cc4516c/.github/workflows/ci.yml).

## Adoption decision and next experiment

1. Continue original data loading, battle-context initialization and full-match
   execution in the existing isolated harness.
2. Keep this revision pinned as a source reference for Ghidra call/value tracing,
   annotation handling and evidence provenance.
3. Before broader adoption, test one known native loader function in a correctly
   mapped analysis artifact. Check instruction bytes, addresses, resolved calls
   and known dependencies against our existing results; measure import latency
   and memory use. Only then decide whether REA reduces investigation work.
4. Preserve the existing exactness gate. A successful REA analysis or upstream
   test does not advance troop, tower or full-match equivalence status.

No global setup or agent configuration change was needed for this review.
The source includes setup planning, backups and managed skill installation;
those installation workflows are separate from using the repository as a
reference. All original game bytes and private analysis artifacts remain local.
