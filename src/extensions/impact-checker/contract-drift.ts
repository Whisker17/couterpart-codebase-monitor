// Contract-drift detection: the "re-implementer" lens for impact-check.
//
// Many downstream Mantle targets keep their OWN local copy of an upstream contract
// (a mirror struct / re-declared wire type) that must be hand-synced when upstream changes.
// The dependency-boundary (consumer) model misses this: it follows the package manifest to an
// external dep it cannot read, and treats an additive field as transparently backward-compatible.
//
// This module detects drift between an upstream contract change and a downstream local copy by:
//   A. extractContractDeltas(diff)         — what contract member changed upstream (+ siblings/domain)
//   B. findLocalContractMirror(dir, delta) — locate the local mirror by SIBLING overlap (NOT the new
//                                            identifier, which is absent in the true-positive case)
//   C. classify present | missing | tag-diverged
// See docs/spark/2026-06-15-impact-check-contract-drift-detection.md.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export type Language = "go" | "rust";
export type SemanticDomain =
  | "header"
  | "payload"
  | "engine-api"
  | "consensus"
  | "config"
  | "unknown";
export type DriftActual = "missing" | "tag-diverged" | "present";

export interface ContractDelta {
  language: Language;
  file: string; // upstream file path
  enclosingContract: string; // struct/type name being modified
  kind: "field-added" | "tag-changed";
  member: string; // changed field identifier, e.g. "SlotNumber"
  serializedKey: string | null; // wire key, e.g. "slotNumber"
  expectedTag: string | null; // upstream tag now on the member, e.g. 'json:"slotNumber,omitempty"'
  oldTag: string | null; // for tag-changed: the prior tag, e.g. 'json:"slotNumber"'
  siblingMembers: string[]; // other field identifiers on the contract (stable anchors)
  siblingKeys: string[]; // other serialized keys on the contract
  semanticDomain: SemanticDomain;
}

export interface MirrorMatch {
  mirror: string; // local struct name, e.g. "RPCHeader"
  file: string; // path relative to clone dir
  lines: string; // "start-end"
  snippet: string; // full enclosing struct block
  member: string;
  serializedKey: string | null;
  expectedTag: string | null;
  observedTag: string | null; // the tag actually on the mirror member
  actual: DriftActual;
  matchedBy: "sibling-overlap" | "architecture-path";
  siblingOverlap: number;
}

interface ParsedField {
  ident: string;
  rawTag: string | null; // contents inside backticks (Go) or serde rename (rust)
}

interface ParsedStruct {
  name: string;
  startLine: number; // 1-based
  endLine: number;
  block: string;
  fields: ParsedField[];
}

const MIN_SIBLING_OVERLAP = 2;

// ----------------------------------------------------------------------------
// Tag helpers
// ----------------------------------------------------------------------------

// Extract a serialization key from a Go struct tag / Rust serde attr.
// Go: `json:"slotNumber,omitempty" rlp:"optional"` -> "slotNumber"
// Rust serde rename: `rename = "slotNumber"` -> "slotNumber"
function serializedKeyFromTag(rawTag: string | null): string | null {
  if (!rawTag) return null;
  const json = rawTag.match(/json:"([^",]+)/);
  if (json) return json[1]!;
  const serde = rawTag.match(/rename\s*=\s*"([^"]+)"/);
  if (serde) return serde[1]!;
  return null;
}

// Return the json:"..." token (the serialization contract we compare for tag-divergence).
function jsonTagToken(rawTag: string | null): string | null {
  if (!rawTag) return null;
  const m = rawTag.match(/json:"[^"]*"/);
  if (m) return m[0];
  const serde = rawTag.match(/#?\[?serde\([^)]*\)\]?/);
  if (serde) return serde[0];
  return null;
}

function inferDomain(name: string, file: string): SemanticDomain {
  const h = `${name} ${file}`.toLowerCase();
  if (/header/.test(h)) return "header";
  if (/payload|executiondata|executabledata|executionpayload/.test(h)) return "payload";
  if (/engine|beacon\/engine|catalyst/.test(h)) return "engine-api";
  if (/genesis|consensus|chainconfig|fork/.test(h)) return "consensus";
  if (/config|flags|settings/.test(h)) return "config";
  return "unknown";
}

// ----------------------------------------------------------------------------
// Source struct parsers (used on the LOCAL clone)
// ----------------------------------------------------------------------------

// Parse Go `type X struct { ... }` blocks. Brace-matched, tolerant of nested braces.
export function parseGoStructs(content: string): ParsedStruct[] {
  const lines = content.split("\n");
  const structs: ParsedStruct[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^\s*type\s+([A-Za-z_]\w*)\s+struct\s*\{/);
    if (!m) continue;
    const name = m[1]!;
    let depth = 1;
    const fields: ParsedField[] = [];
    let j = i + 1;
    for (; j < lines.length && depth > 0; j++) {
      const line = lines[j]!;
      depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
      if (depth <= 0) break;
      // field: leading identifier(s) + type + optional `tag`
      const f = line.match(/^\s*([A-Z]\w*)\s+[^\s`][^`]*?\s*(`[^`]*`)?\s*(\/\/.*)?$/);
      if (f) fields.push({ ident: f[1]!, rawTag: f[2] ? f[2].slice(1, -1) : null });
    }
    structs.push({
      name,
      startLine: i + 1,
      endLine: j + 1,
      block: lines.slice(i, j + 1).join("\n"),
      fields,
    });
    i = j;
  }
  return structs;
}

// Parse Rust `struct X { ... }` blocks with optional `#[serde(rename = "...")]` on fields.
export function parseRustStructs(content: string): ParsedStruct[] {
  const lines = content.split("\n");
  const structs: ParsedStruct[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)\s*\{/);
    if (!m) continue;
    const name = m[1]!;
    let depth = 1;
    const fields: ParsedField[] = [];
    let pendingTag: string | null = null;
    let j = i + 1;
    for (; j < lines.length && depth > 0; j++) {
      const line = lines[j]!;
      depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
      if (depth <= 0) break;
      const attr = line.match(/#\[serde\(([^)]*)\)\]/);
      if (attr) {
        pendingTag = `serde(${attr[1]})`;
        continue;
      }
      const f = line.match(/^\s*(?:pub\s+)?([a-z_]\w*)\s*:\s*[^,]+,?/);
      if (f) {
        fields.push({ ident: f[1]!, rawTag: pendingTag });
        pendingTag = null;
      } else if (line.trim() && !line.trim().startsWith("//")) {
        pendingTag = null;
      }
    }
    structs.push({
      name,
      startLine: i + 1,
      endLine: j + 1,
      block: lines.slice(i, j + 1).join("\n"),
      fields,
    });
    i = j;
  }
  return structs;
}

function parseStructs(content: string, lang: Language): ParsedStruct[] {
  return lang === "go" ? parseGoStructs(content) : parseRustStructs(content);
}

// A unified diff's narrow context (~3 lines) usually yields only 1-2 siblings — too few to find a
// LAGGING mirror (which shares the OLD common fields, not the newest ones near the change). Given the
// full upstream source of the enclosing struct, harvest its complete field set as siblings.
export function enrichDeltaFromSource(delta: ContractDelta, source: string): ContractDelta {
  const s = parseStructs(source, delta.language).find((x) => x.name === delta.enclosingContract);
  if (!s) return delta;
  const members = s.fields.map((f) => f.ident).filter((x) => x !== delta.member);
  const keys = s.fields
    .map((f) => serializedKeyFromTag(f.rawTag))
    .filter((k): k is string => !!k && k !== delta.serializedKey);
  return {
    ...delta,
    siblingMembers: [...new Set([...delta.siblingMembers, ...members])],
    siblingKeys: [...new Set([...delta.siblingKeys, ...keys])],
  };
}

// ----------------------------------------------------------------------------
// Step A — extract contract deltas from a unified diff
// ----------------------------------------------------------------------------

function langForFile(file: string): Language | null {
  if (file.endsWith(".go")) return "go";
  if (file.endsWith(".rs")) return "rust";
  return null;
}

// Match an added/removed struct field line (sign stripped). Returns {ident, rawTag} or null.
function matchFieldLine(body: string, lang: Language): ParsedField | null {
  if (lang === "go") {
    const f = body.match(/^\s*([A-Z]\w*)\s+[^\s`][^`]*?\s*(`[^`]*`)?\s*(\/\/.*)?$/);
    if (f) return { ident: f[1]!, rawTag: f[2] ? f[2].slice(1, -1) : null };
    return null;
  }
  const f = body.match(/^\s*(?:pub\s+)?([a-z_]\w*)\s*:\s*[^,]+,?/);
  if (f) return { ident: f[1]!, rawTag: null };
  return null;
}

export function extractContractDeltas(diff: string): ContractDelta[] {
  const deltas: ContractDelta[] = [];
  const lines = diff.split("\n");

  let curFile = "";
  let curLang: Language | null = null;
  let enclosing = ""; // best-effort enclosing type from hunk header
  // siblings harvested per (file, struct)
  const siblingsByContract = new Map<string, { idents: Set<string>; keys: Set<string> }>();
  const recordSibling = (contract: string, field: ParsedField) => {
    const key = `${curFile}::${contract}`;
    let s = siblingsByContract.get(key);
    if (!s) {
      s = { idents: new Set(), keys: new Set() };
      siblingsByContract.set(key, s);
    }
    s.idents.add(field.ident);
    const sk = serializedKeyFromTag(field.rawTag);
    if (sk) s.keys.add(sk);
  };

  interface Raw {
    file: string;
    lang: Language;
    contract: string;
    field: ParsedField;
    sign: "+" | "-";
  }
  const added: Raw[] = [];
  const removed: Raw[] = [];
  // Rust serde tag changes: the `#[serde(...)]` attribute sits on its own line ABOVE the field, so a
  // tag-only change shows as -/+ attr lines with the field itself as context. Track the pending change
  // and attach it to the next field identifier.
  let pendingRemovedSerde: string | null = null;
  let pendingAddedSerde: string | null = null;
  const serdeChanges: Array<{ file: string; contract: string; member: string; oldTag: string; newTag: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fileM = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileM) {
      curFile = fileM[1]!;
      curLang = langForFile(curFile);
      enclosing = "";
      pendingRemovedSerde = null;
      pendingAddedSerde = null;
      continue;
    }
    if (line.startsWith("@@")) {
      // hunk header: trailing context often holds `type X struct {` (Go) for Go files
      const ctx = line.replace(/^@@.*@@/, "");
      const t = ctx.match(/type\s+([A-Za-z_]\w*)\s+struct/) || ctx.match(/struct\s+([A-Za-z_]\w*)/);
      enclosing = t ? t[1]! : "";
      continue;
    }
    if (!curLang) continue;
    // track enclosing struct opening that appears inside the hunk body too
    const bodyForType = line.slice(1);
    const typeOpen =
      bodyForType.match(/^\s*type\s+([A-Za-z_]\w*)\s+struct\s*\{/) ||
      bodyForType.match(/^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)\s*\{/);
    if ((line.startsWith(" ") || line.startsWith("+")) && typeOpen) {
      enclosing = typeOpen[1]!;
    }

    // Rust serde attribute change (separate line above the field).
    if (curLang === "rust") {
      const serdeM = line.slice(1).match(/#\[serde\([^)]*\)\]/);
      if (serdeM && (line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---")) {
        if (line.startsWith("-")) pendingRemovedSerde = serdeM[0];
        else pendingAddedSerde = serdeM[0];
        continue;
      }
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      const field = matchFieldLine(line.slice(1), curLang);
      if (field && enclosing) {
        recordSibling(enclosing, field);
        added.push({ file: curFile, lang: curLang, contract: enclosing, field, sign: "+" });
        maybeRecordSerdeChange(field.ident);
      }
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      const field = matchFieldLine(line.slice(1), curLang);
      if (field && enclosing) removed.push({ file: curFile, lang: curLang, contract: enclosing, field, sign: "-" });
    } else if (line.startsWith(" ")) {
      const field = matchFieldLine(line.slice(1), curLang);
      if (field && enclosing) {
        recordSibling(enclosing, field);
        maybeRecordSerdeChange(field.ident);
      }
    }
  }

  function maybeRecordSerdeChange(member: string): void {
    if (pendingRemovedSerde && pendingAddedSerde && pendingRemovedSerde !== pendingAddedSerde && enclosing) {
      serdeChanges.push({
        file: curFile,
        contract: enclosing,
        member,
        oldTag: pendingRemovedSerde,
        newTag: pendingAddedSerde,
      });
    }
    pendingRemovedSerde = null;
    pendingAddedSerde = null;
  }

  const removedByKey = new Map<string, Raw>();
  for (const r of removed) removedByKey.set(`${r.file}::${r.contract}::${r.field.ident}`, r);

  for (const a of added) {
    const key = `${a.file}::${a.contract}::${a.field.ident}`;
    const sib = siblingsByContract.get(`${a.file}::${a.contract}`)!;
    const siblingMembers = [...sib.idents].filter((x) => x !== a.field.ident);
    const siblingKeys = [...sib.keys].filter((x) => x !== serializedKeyFromTag(a.field.rawTag));
    const rem = removedByKey.get(key);
    const expectedTag = jsonTagToken(a.field.rawTag);

    if (rem) {
      // same member added & removed -> tag (or type) change
      const oldTag = jsonTagToken(rem.field.rawTag);
      if (oldTag !== expectedTag) {
        deltas.push({
          language: a.lang,
          file: a.file,
          enclosingContract: a.contract,
          kind: "tag-changed",
          member: a.field.ident,
          serializedKey: serializedKeyFromTag(a.field.rawTag),
          expectedTag,
          oldTag,
          siblingMembers,
          siblingKeys,
          semanticDomain: inferDomain(a.contract, a.file),
        });
      }
    } else {
      deltas.push({
        language: a.lang,
        file: a.file,
        enclosingContract: a.contract,
        kind: "field-added",
        member: a.field.ident,
        serializedKey: serializedKeyFromTag(a.field.rawTag),
        expectedTag,
        oldTag: null,
        siblingMembers,
        siblingKeys,
        semanticDomain: inferDomain(a.contract, a.file),
      });
    }
  }

  // Rust serde-only tag changes (the field line was unchanged context; only the attr moved).
  for (const sc of serdeChanges) {
    // Skip if the same member already produced a delta above (avoid duplicates).
    if (deltas.some((d) => d.file === sc.file && d.enclosingContract === sc.contract && d.member === sc.member)) {
      continue;
    }
    const sib = siblingsByContract.get(`${sc.file}::${sc.contract}`) ?? { idents: new Set<string>(), keys: new Set<string>() };
    deltas.push({
      language: "rust",
      file: sc.file,
      enclosingContract: sc.contract,
      kind: "tag-changed",
      member: sc.member,
      serializedKey: serializedKeyFromTag(sc.newTag),
      expectedTag: sc.newTag,
      oldTag: sc.oldTag,
      siblingMembers: [...sib.idents].filter((x) => x !== sc.member),
      siblingKeys: [...sib.keys],
      semanticDomain: inferDomain(sc.contract, sc.file),
    });
  }

  return deltas;
}

// ----------------------------------------------------------------------------
// Step B/C — find the local mirror and classify
// ----------------------------------------------------------------------------

function gitGrepFiles(cloneDir: string, idents: string[], lang: Language): string[] {
  if (idents.length === 0) return [];
  const ext = lang === "go" ? "*.go" : "*.rs";
  const args = ["-C", cloneDir, "grep", "-l", "-I"];
  for (const id of idents.slice(0, 8)) args.push("-e", `\\b${id}\\b`);
  args.push("--", ext);
  try {
    const out = execFileSync("git", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 8 * 1024 * 1024 });
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return []; // git grep exits non-zero when nothing matches
  }
}

// Filesystem fallback for non-git dirs (unit tests, or a clone without .git). Bounded walk.
function fsWalkFind(cloneDir: string, idents: string[], lang: Language): string[] {
  if (idents.length === 0) return [];
  const ext = lang === "go" ? ".go" : ".rs";
  const hits: string[] = [];
  const SKIP = new Set([".git", "node_modules", "target", "vendor", "dist", "build"]);
  const walk = (dir: string, depth: number) => {
    if (depth > 12 || hits.length > 200) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (name.endsWith(ext)) {
        try {
          const content = readFileSync(full, "utf-8");
          if (idents.some((id) => new RegExp(`\\b${id}\\b`).test(content))) {
            hits.push(relative(cloneDir, full));
          }
        } catch {
          /* skip */
        }
      }
    }
  };
  walk(cloneDir, 0);
  return hits;
}

function findCandidateFiles(cloneDir: string, idents: string[], lang: Language): string[] {
  // Real clones are git repos: trust git grep (fast; empty result => no mirror, don't walk a huge tree).
  // Non-git dirs (tests / bare copies): fall back to a bounded filesystem walk.
  if (existsSync(join(cloneDir, ".git"))) return gitGrepFiles(cloneDir, idents, lang);
  return fsWalkFind(cloneDir, idents, lang);
}

function memberTagInStruct(s: ParsedStruct, member: string): { present: boolean; tag: string | null } {
  const f = s.fields.find((x) => x.ident === member);
  if (!f) return { present: false, tag: null };
  return { present: true, tag: jsonTagToken(f.rawTag) };
}

export interface FindMirrorOptions {
  architectureNotes?: string | null;
  maxFiles?: number;
}

// Locate ALL qualifying local mirrors for a delta, ranked best-first. Keys off sibling overlap (NOT
// the new member), so a stale mirror missing the new member is still found. Returning all qualifying
// mirrors (not just the single best) ensures a smaller, genuinely-stale mirror is not HIDDEN behind a
// larger already-synced one.
export function findLocalContractMirrors(
  cloneDir: string,
  delta: ContractDelta,
  opts: FindMirrorOptions = {}
): MirrorMatch[] {
  const anchors = [...delta.siblingMembers, ...delta.siblingKeys];
  const archNotes = (opts.architectureNotes ?? "").toLowerCase();
  const siblingSet = new Set(delta.siblingMembers);
  const keySet = new Set(delta.siblingKeys);

  // Common contract fields (ParentHash, Number, …) match MANY files; a plain path-ordered slice can
  // drop the true mirror (which may sort late). Rank candidate files by how many DISTINCT anchors they
  // contain (cheap string scan) and evaluate the densest first — the real mirror has the most overlap.
  const rawCandidates = findCandidateFiles(cloneDir, anchors, delta.language).slice(0, 1500);
  const anchorRes = anchors.map((a) => new RegExp(`\\b${escapeRe(a)}\\b`));
  const scored: Array<{ file: string; content: string; density: number }> = [];
  for (const file of rawCandidates) {
    let content: string;
    try {
      content = readFileSync(join(cloneDir, file), "utf-8");
    } catch {
      continue;
    }
    const density = anchorRes.reduce((n, re) => n + (re.test(content) ? 1 : 0), 0);
    const archMatchFile = archNotes.includes(file.toLowerCase());
    if (density >= MIN_SIBLING_OVERLAP || archMatchFile) scored.push({ file, content, density });
  }
  scored.sort((a, b) => b.density - a.density);
  const candidates = scored.slice(0, opts.maxFiles ?? 80);

  const matches: MirrorMatch[] = [];
  for (const { file, content } of candidates) {
    const structs = parseStructs(content, delta.language);
    for (const s of structs) {
      const identOverlap = s.fields.filter((f) => siblingSet.has(f.ident)).length;
      const keyOverlap = s.fields.filter((f) => {
        const k = serializedKeyFromTag(f.rawTag);
        return k !== null && keySet.has(k);
      }).length;
      const overlap = Math.max(identOverlap, keyOverlap);
      // Sibling overlap is ALWAYS required — a struct with no real field overlap is never a mirror, no
      // matter what the architecture notes say. (Architecture notes are long and mention many paths, so
      // they must NOT be able to promote a zero-overlap struct, nor match on a common struct name.)
      if (overlap < MIN_SIBLING_OVERLAP) continue;

      // Domain guardrail (cross-struct): a struct with a DIFFERENT name than the upstream contract only
      // counts as a mirror if it sits in the SAME, KNOWN semantic domain — OR the specific FILE PATH is
      // named in the target's architecture notes (a deliberate, specific tie, not a loose name match).
      // This stops (a) a header change matching a payload struct, and (b) an unknown-domain delta (e.g. a
      // test-helper struct like `stEnv`) matching arbitrary structs that share a few generic field names.
      const sameName = s.name === delta.enclosingContract;
      const archPathMatch = archNotes.length > 0 && archNotes.includes(file.toLowerCase());
      if (!sameName && !archPathMatch) {
        if (delta.semanticDomain === "unknown" || inferDomain(s.name, file) !== delta.semanticDomain) continue;
      }
      const matchedBy: MirrorMatch["matchedBy"] = sameName || !archPathMatch ? "sibling-overlap" : "architecture-path";

      const { present, tag } = memberTagInStruct(s, delta.member);
      let actual: DriftActual;
      if (!present) {
        actual = "missing";
      } else if (delta.kind === "tag-changed" && delta.expectedTag && tag !== delta.expectedTag) {
        actual = "tag-diverged";
      } else {
        actual = "present";
      }

      matches.push({
        mirror: s.name,
        file,
        lines: `${s.startLine}-${s.endLine}`,
        snippet: s.block,
        member: delta.member,
        serializedKey: delta.serializedKey,
        expectedTag: delta.expectedTag,
        observedTag: tag,
        actual,
        matchedBy,
        siblingOverlap: overlap,
      });
    }
  }
  // Dedup by mirror+file (a struct can be reached via multiple anchors), keep best overlap, rank desc.
  const byKey = new Map<string, MirrorMatch>();
  for (const m of matches) {
    const k = `${m.file}::${m.mirror}`;
    const prev = byKey.get(k);
    if (!prev || rank(m) > rank(prev)) byKey.set(k, m);
  }
  return [...byKey.values()].sort((a, b) => rank(b) - rank(a));
}

// Verify a contractCheck claim against the REAL struct re-parsed from the file — NOT against an
// LLM-provided snippet (which could be partial and omit the member to fake a "missing"). Returns
// {ok:false, reason} when the claim cannot be confirmed against the actual source.
export function verifyContractDrift(
  absFile: string,
  lang: Language,
  cc: { mirror: string; member: string; expectedTag: string | null; observedTag?: string | null; actual: DriftActual }
): { ok: boolean; reason?: string } {
  let content: string;
  try {
    content = readFileSync(absFile, "utf-8");
  } catch {
    return { ok: false, reason: `cannot read ${absFile}` };
  }
  const s = parseStructs(content, lang).find((x) => x.name === cc.mirror);
  if (!s) return { ok: false, reason: `mirror struct '${cc.mirror}' not found in file` };
  const field = s.fields.find((x) => x.ident === cc.member);
  const present = !!field;
  const tag = field ? jsonTagToken(field.rawTag) : null;

  if (cc.actual === "missing") {
    return present ? { ok: false, reason: `'${cc.member}' is actually PRESENT in ${cc.mirror}` } : { ok: true };
  }

  if (cc.actual === "present") {
    if (!present) return { ok: false, reason: `'${cc.member}' is actually ABSENT in ${cc.mirror}` };
    // If a specific tag was expected (synced-to-upstream claim), the real tag must actually carry it.
    if (cc.expectedTag && tag !== cc.expectedTag) {
      return { ok: false, reason: `'${cc.member}' present but its tag ${tag ?? "(none)"} != expected ${cc.expectedTag}` };
    }
    return { ok: true };
  }

  // tag-diverged: the member must EXIST, actually CARRY a (different) tag, and that tag must NOT equal
  // the expected one. A member with no tag, or whose tag already equals expected, is not a divergence.
  if (!present) return { ok: false, reason: `'${cc.member}' absent in ${cc.mirror} (cannot be tag-diverged)` };
  if (!tag) return { ok: false, reason: `'${cc.member}' has no tag in ${cc.mirror} — not a tag-divergence` };
  if (cc.expectedTag && tag === cc.expectedTag) {
    return { ok: false, reason: `'${cc.member}' already carries the expected tag (not diverged)` };
  }
  if (cc.observedTag && tag !== cc.observedTag) {
    return { ok: false, reason: `'${cc.member}' real tag ${tag} != claimed observedTag ${cc.observedTag}` };
  }
  return { ok: true };
}

export function languageForFile(file: string): Language | null {
  return langForFile(file);
}

// Backward-compatible single-best accessor (highest sibling overlap, drift as tiebreak).
export function findLocalContractMirror(
  cloneDir: string,
  delta: ContractDelta,
  opts: FindMirrorOptions = {}
): MirrorMatch | null {
  return findLocalContractMirrors(cloneDir, delta, opts)[0] ?? null;
}

// Select the best STRUCTURAL mirror first (highest sibling overlap = the true mirror of this
// contract), using drift only as a tiebreak. Picking a weakly-overlapping struct just because it is
// "missing" the member would mis-locate the mirror.
function rank(m: MirrorMatch): number {
  const driftTiebreak = m.actual === "missing" ? 2 : m.actual === "tag-diverged" ? 1 : 0;
  return m.siblingOverlap * 10 + driftTiebreak;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
