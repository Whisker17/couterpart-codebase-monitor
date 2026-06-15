import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractContractDeltas,
  findLocalContractMirror,
  findLocalContractMirrors,
  verifyContractDrift,
  parseGoStructs,
  parseRustStructs,
  type ContractDelta,
} from "./contract-drift";

function tmpRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "cdrift-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const dirs: string[] = [];
function repo(files: Record<string, string>): string {
  const d = tmpRepo(files);
  dirs.push(d);
  return d;
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// ---------------------------------------------------------------------------
// Step A — diff extraction
// ---------------------------------------------------------------------------

const GO_FIELD_ADD_DIFF = `diff --git a/core/types/block.go b/core/types/block.go
--- a/core/types/block.go
+++ b/core/types/block.go
@@ -100,6 +100,7 @@ type Header struct {
 \tParentHash common.Hash \`json:"parentHash"\`
 \tRoot       common.Hash \`json:"stateRoot"\`
+\tSlotNumber *uint64     \`json:"slotNumber" rlp:"optional"\`
 \tExtra      []byte      \`json:"extraData"\`
`;

const GO_TAG_CHANGE_DIFF = `diff --git a/core/types/block.go b/core/types/block.go
--- a/core/types/block.go
+++ b/core/types/block.go
@@ -40,7 +40,7 @@ type Header struct {
 \tParentHash common.Hash \`json:"parentHash"\`
 \tStateRoot  common.Hash \`json:"stateRoot"\`
-\tSlotNumber *uint64     \`json:"slotNumber"\`
+\tSlotNumber *uint64     \`json:"slotNumber,omitempty"\`
 \tExtra      []byte      \`json:"extraData"\`
`;

const RUST_FIELD_ADD_DIFF = `diff --git a/crates/types/src/header.rs b/crates/types/src/header.rs
--- a/crates/types/src/header.rs
+++ b/crates/types/src/header.rs
@@ -10,6 +10,7 @@ pub struct Header {
     pub parent_hash: B256,
     pub state_root: B256,
+    pub slot_number: Option<u64>,
     pub extra_data: Bytes,
`;

describe("extractContractDeltas", () => {
  it("Go: field addition with siblings + serialized key", () => {
    const d = extractContractDeltas(GO_FIELD_ADD_DIFF);
    expect(d).toHaveLength(1);
    expect(d[0]!.kind).toBe("field-added");
    expect(d[0]!.member).toBe("SlotNumber");
    expect(d[0]!.serializedKey).toBe("slotNumber");
    expect(d[0]!.enclosingContract).toBe("Header");
    expect(d[0]!.siblingMembers).toEqual(expect.arrayContaining(["ParentHash", "Root", "Extra"]));
    expect(d[0]!.siblingMembers).not.toContain("SlotNumber");
  });

  it("Go: tag change is detected as tag-changed with expected/old tag", () => {
    const d = extractContractDeltas(GO_TAG_CHANGE_DIFF);
    expect(d).toHaveLength(1);
    expect(d[0]!.kind).toBe("tag-changed");
    expect(d[0]!.member).toBe("SlotNumber");
    expect(d[0]!.expectedTag).toBe('json:"slotNumber,omitempty"');
    expect(d[0]!.oldTag).toBe('json:"slotNumber"');
  });

  it("Rust: field addition with siblings", () => {
    const d = extractContractDeltas(RUST_FIELD_ADD_DIFF);
    expect(d).toHaveLength(1);
    expect(d[0]!.language).toBe("rust");
    expect(d[0]!.member).toBe("slot_number");
    expect(d[0]!.siblingMembers).toEqual(expect.arrayContaining(["parent_hash", "state_root", "extra_data"]));
  });
});

// ---------------------------------------------------------------------------
// Fixture 1 — stale-mirror detection (the P1 regression): finds the mirror even
// though the new identifier is ENTIRELY ABSENT from the target.
// ---------------------------------------------------------------------------

describe("findLocalContractMirror — stale-mirror detection", () => {
  const [delta] = extractContractDeltas(GO_FIELD_ADD_DIFF);

  it("Go: locates mirror by siblings and reports missing (pre-adaptation)", () => {
    const dir = repo({
      "op-service/sources/types.go": `package sources
type RPCHeader struct {
\tParentHash common.Hash \`json:"parentHash"\`
\tRoot       common.Hash \`json:"stateRoot"\`
\tExtra      []byte      \`json:"extraData"\`
}
`,
    });
    const m = findLocalContractMirror(dir, delta!);
    expect(m).not.toBeNull();
    expect(m!.mirror).toBe("RPCHeader");
    expect(m!.actual).toBe("missing");
    expect(m!.siblingOverlap).toBeGreaterThanOrEqual(2);
  });

  it("Go: reports present when the field exists (post-adaptation)", () => {
    const dir = repo({
      "op-service/sources/types.go": `package sources
type RPCHeader struct {
\tParentHash common.Hash \`json:"parentHash"\`
\tRoot       common.Hash \`json:"stateRoot"\`
\tSlotNumber *uint64     \`json:"slotNumber" rlp:"optional"\`
\tExtra      []byte      \`json:"extraData"\`
}
`,
    });
    const m = findLocalContractMirror(dir, delta!);
    expect(m).not.toBeNull();
    expect(m!.actual).toBe("present");
  });

  it("Rust: locates mirror by siblings and reports missing", () => {
    const [rdelta] = extractContractDeltas(RUST_FIELD_ADD_DIFF);
    const dir = repo({
      "crates/node/src/rpc_header.rs": `pub struct RpcHeader {
    pub parent_hash: B256,
    pub state_root: B256,
    pub extra_data: Bytes,
}
`,
    });
    const m = findLocalContractMirror(dir, rdelta!);
    expect(m).not.toBeNull();
    expect(m!.actual).toBe("missing");
  });
});

// ---------------------------------------------------------------------------
// Fixture 2 — tag-divergence detection
// ---------------------------------------------------------------------------

describe("findLocalContractMirror — tag divergence", () => {
  it("Go: field present with OLD tag -> tag-diverged + observedTag captured", () => {
    const [delta] = extractContractDeltas(GO_TAG_CHANGE_DIFF);
    const dir = repo({
      "op-service/sources/types.go": `package sources
type RPCHeader struct {
\tParentHash common.Hash \`json:"parentHash"\`
\tStateRoot  common.Hash \`json:"stateRoot"\`
\tSlotNumber *uint64     \`json:"slotNumber"\`
\tExtra      []byte      \`json:"extraData"\`
}
`,
    });
    const m = findLocalContractMirror(dir, delta!);
    expect(m).not.toBeNull();
    expect(m!.actual).toBe("tag-diverged");
    expect(m!.observedTag).toBe('json:"slotNumber"');
    expect(m!.expectedTag).toBe('json:"slotNumber,omitempty"');
  });

  it("Go: field present with NEW tag -> present", () => {
    const [delta] = extractContractDeltas(GO_TAG_CHANGE_DIFF);
    const dir = repo({
      "op-service/sources/types.go": `package sources
type RPCHeader struct {
\tParentHash common.Hash \`json:"parentHash"\`
\tStateRoot  common.Hash \`json:"stateRoot"\`
\tSlotNumber *uint64     \`json:"slotNumber,omitempty"\`
\tExtra      []byte      \`json:"extraData"\`
}
`,
    });
    const m = findLocalContractMirror(dir, delta!);
    expect(m!.actual).toBe("present");
  });

  it("Rust serde: field present with OLD rename -> tag-diverged (classifier path)", () => {
    const rdelta: ContractDelta = {
      language: "rust",
      file: "crates/types/src/header.rs",
      enclosingContract: "Header",
      kind: "tag-changed",
      member: "slot_number",
      serializedKey: "slotNumber",
      expectedTag: 'serde(rename = "slotNumber", skip_serializing_if = "Option::is_none")',
      oldTag: 'serde(rename = "slotNumber")',
      siblingMembers: ["parent_hash", "state_root", "extra_data"],
      siblingKeys: [],
      semanticDomain: "header",
    };
    const dir = repo({
      "crates/node/src/rpc_header.rs": `pub struct RpcHeader {
    pub parent_hash: B256,
    pub state_root: B256,
    #[serde(rename = "slotNumber")]
    pub slot_number: Option<u64>,
    pub extra_data: Bytes,
}
`,
    });
    const m = findLocalContractMirror(dir, rdelta);
    expect(m).not.toBeNull();
    expect(m!.actual).toBe("tag-diverged");
  });
});

// ---------------------------------------------------------------------------
// Fixture 3 — false-positive guard: a lone shared field name with no sibling
// overlap must NOT be matched as a mirror (the >=2 sibling-overlap v1 rule).
// ---------------------------------------------------------------------------

describe("findLocalContractMirror — false-positive guard", () => {
  it("Go: unrelated struct sharing only the field name is NOT a mirror", () => {
    const [delta] = extractContractDeltas(GO_FIELD_ADD_DIFF);
    const dir = repo({
      "metrics/collector.go": `package metrics
type SlotMetrics struct {
\tslotNumber uint64
\tlatencyMs  uint64
\tcacheHits  uint64
}
`,
    });
    const m = findLocalContractMirror(dir, delta!);
    expect(m).toBeNull();
  });
});

// A genuinely-stale smaller mirror must NOT be hidden behind a larger already-synced one.
describe("findLocalContractMirrors — does not hide a stale mirror behind a synced one", () => {
  it("Go: returns BOTH the synced full mirror and the smaller stale mirror", () => {
    const [delta] = extractContractDeltas(GO_FIELD_ADD_DIFF);
    const dir = repo({
      "full/header.go": `package full
type FullHeader struct {
\tParentHash common.Hash \`json:"parentHash"\`
\tRoot       common.Hash \`json:"stateRoot"\`
\tExtra      []byte      \`json:"extraData"\`
\tSlotNumber *uint64     \`json:"slotNumber"\`
}
`,
      "rpc/header.go": `package rpc
type RPCHeader struct {
\tParentHash common.Hash \`json:"parentHash"\`
\tRoot       common.Hash \`json:"stateRoot"\`
\tExtra      []byte      \`json:"extraData"\`
}
`,
    });
    const all = findLocalContractMirrors(dir, delta!);
    const byName = Object.fromEntries(all.map((m) => [m.mirror, m]));
    expect(byName["FullHeader"]!.actual).toBe("present");
    expect(byName["RPCHeader"]!.actual).toBe("missing"); // the smaller stale mirror is still surfaced
  });
});

// verifyContractDrift re-parses the REAL struct from the file — it must NOT be foolable by a partial
// snippet that omits the member to fake a "missing".
describe("verifyContractDrift — validates against the real file, not a snippet", () => {
  it("Go: 'missing' claim is REJECTED when the real struct actually has the field", () => {
    const dir = repo({
      "rpc/header.go": `package rpc
type RPCHeader struct {
\tParentHash common.Hash \`json:"parentHash"\`
\tSlotNumber *uint64     \`json:"slotNumber"\`
}
`,
    });
    const res = verifyContractDrift(join(dir, "rpc/header.go"), "go", {
      mirror: "RPCHeader",
      member: "SlotNumber",
      expectedTag: 'json:"slotNumber"',
      actual: "missing",
    });
    expect(res.ok).toBe(false); // real struct HAS SlotNumber -> the "missing" claim must fail
  });

  it("Go: 'present' claim with a WRONG expectedTag is REJECTED", () => {
    const dir = repo({
      "rpc/header.go": `package rpc
type RPCHeader struct {
\tParentHash common.Hash \`json:"parentHash"\`
\tSlotNumber *uint64     \`json:"slotNumber"\`
}
`,
    });
    const res = verifyContractDrift(join(dir, "rpc/header.go"), "go", {
      mirror: "RPCHeader",
      member: "SlotNumber",
      expectedTag: 'json:"slotNumber,omitempty"', // real has json:"slotNumber" (no omitempty)
      actual: "present",
    });
    expect(res.ok).toBe(false);
  });

  it("Go: 'tag-diverged' claim is REJECTED when the real field has NO tag", () => {
    const dir = repo({
      "rpc/header.go": `package rpc
type RPCHeader struct {
\tParentHash common.Hash \`json:"parentHash"\`
\tSlotNumber *uint64
}
`,
    });
    const res = verifyContractDrift(join(dir, "rpc/header.go"), "go", {
      mirror: "RPCHeader",
      member: "SlotNumber",
      expectedTag: 'json:"slotNumber,omitempty"',
      observedTag: 'json:"slotNumber"',
      actual: "tag-diverged",
    });
    expect(res.ok).toBe(false); // real field has no tag -> not a tag-divergence
  });

  it("Go: 'missing' claim is ACCEPTED when the real struct lacks the field", () => {
    const dir = repo({
      "rpc/header.go": `package rpc
type RPCHeader struct {
\tParentHash common.Hash \`json:"parentHash"\`
}
`,
    });
    const res = verifyContractDrift(join(dir, "rpc/header.go"), "go", {
      mirror: "RPCHeader",
      member: "SlotNumber",
      expectedTag: null,
      actual: "missing",
    });
    expect(res.ok).toBe(true);
  });
});

// Domain guardrail (#3): a header-domain change must NOT match a payload-domain struct that merely
// shares a couple of generic field names.
describe("findLocalContractMirror — semantic-domain guardrail", () => {
  it("Go: header-domain delta does NOT match a payload-domain struct (cross-domain collision)", () => {
    const [delta] = extractContractDeltas(GO_FIELD_ADD_DIFF); // enclosingContract Header -> domain header
    const dir = repo({
      "engine/payload.go": `package engine
type ExecutionPayload struct {
\tParentHash common.Hash \`json:"parentHash"\`
\tStateRoot  common.Hash \`json:"stateRoot"\`
\tGasUsed    uint64      \`json:"gasUsed"\`
}
`,
    });
    const m = findLocalContractMirror(dir, delta!);
    expect(m).toBeNull(); // payload-domain struct rejected for a header-domain delta
  });
});

// Rust serde-only tag change must be extracted from a diff where the attr moved on its own line.
describe("extractContractDeltas — Rust serde tag change", () => {
  it("detects a serde attribute change as tag-changed", () => {
    const diff = `diff --git a/crates/types/src/header.rs b/crates/types/src/header.rs
--- a/crates/types/src/header.rs
+++ b/crates/types/src/header.rs
@@ -10,7 +10,7 @@ pub struct Header {
     pub parent_hash: B256,
     pub state_root: B256,
-    #[serde(rename = "slotNumber")]
+    #[serde(rename = "slotNumber", skip_serializing_if = "Option::is_none")]
     pub slot_number: Option<u64>,
     pub extra_data: Bytes,
`;
    const deltas = extractContractDeltas(diff);
    const tc = deltas.find((d) => d.member === "slot_number" && d.kind === "tag-changed");
    expect(tc).toBeDefined();
    expect(tc!.oldTag).toContain('rename = "slotNumber"');
    expect(tc!.expectedTag).toContain("skip_serializing_if");
    expect(tc!.expectedTag).not.toBe(tc!.oldTag);
  });
});

// ---------------------------------------------------------------------------
// Struct parsers
// ---------------------------------------------------------------------------

describe("struct parsers", () => {
  it("parseGoStructs extracts fields + tags", () => {
    const s = parseGoStructs(`type X struct {
\tA int \`json:"a"\`
\tB string
}`);
    expect(s).toHaveLength(1);
    expect(s[0]!.fields.map((f) => f.ident)).toEqual(["A", "B"]);
    expect(s[0]!.fields[0]!.rawTag).toContain('json:"a"');
  });

  it("parseRustStructs extracts fields + serde", () => {
    const s = parseRustStructs(`pub struct X {
    #[serde(rename = "a")]
    pub a: u64,
    pub b: String,
}`);
    expect(s).toHaveLength(1);
    expect(s[0]!.fields.map((f) => f.ident)).toEqual(["a", "b"]);
    expect(s[0]!.fields[0]!.rawTag).toContain("rename");
  });
});
