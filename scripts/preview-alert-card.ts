// Render a representative impact-alert card and (optionally) send it to Lark so we can iterate on the
// card's style. Uses a realistic contract-drift sample (EIP-7843 / RPCHeader).
//   bun run scripts/preview-alert-card.ts          # print the card JSON only
//   bun run scripts/preview-alert-card.ts --send   # also POST it to LARK_WEBHOOK_URL
import { renderAlertCard, renderAlertCardZh, type AlertCardInput } from "../src/extensions/impact-checker/alert-card";
import { sendCard } from "../src/extensions/lark-dispatcher/webhook";
import { getSettings } from "../src/config/settings";

// --zh: feed ENGLISH verdict text and translate via the LLM gateway (exercises the real send path for
// fork_of/LLM verdicts that come back in English).
const ZH_PATH = process.argv.includes("--zh");

const RPCHEADER_SNIPPET = `type RPCHeader struct {
\tParentHash  common.Hash      \`json:"parentHash"\`
\tUncleHash   common.Hash      \`json:"sha3Uncles"\`
\tCoinbase    common.Address   \`json:"miner"\`
\tRoot        common.Hash      \`json:"stateRoot"\`
\tNumber      hexutil.Uint64   \`json:"number"\`
\t// BaseFee was added by EIP-1559 and is ignored in legacy headers.
\tBaseFee *hexutil.Big \`json:"baseFeePerGas"\`
\t// RequestsHash was added by EIP-7685 and is ignored in legacy headers.
\tRequestsHash *common.Hash \`json:"requestsHash,omitempty"\`
}`;

const sample: AlertCardInput = {
  checkId: 94,
  verdict: {
    affected: "yes",
    severity: "critical",
    confidence: "high",
    impactType: "breaking_change",
    evidenceKind: "code_evidence",
    summary:
      "Mantle 在下游手写维护了一份上游 `Header` 的副本 `RPCHeader`（op-service/sources/types.go），用来解析/构造区块头。上游这次给 `Header` 新增了 `SlotNumber` 字段,但下游这份副本还没跟上、缺了该字段,两边已经对不上。一旦 op-geth 升级到含 EIP-7843 的版本,用这份旧副本算区块头哈希时会丢掉 slotNumber,导致 op-node 校验失败、拒绝区块。",
    recommendedAction:
      "在 op-service/sources/types.go 的 `RPCHeader` 里补上 `SlotNumber *hexutil.Uint64 `json:\"slotNumber,omitempty\"`` 字段,并在 `CreateGethHeader()` 中透传,让它跟上游 `Header` 保持一致。",
    evidence: [
      {
        file: "op-service/sources/types.go",
        lines: "33-70",
        snippet: RPCHEADER_SNIPPET,
        note: "镜像漂移：`RPCHeader` 缺少成员 `SlotNumber`（上游 `Header`）。",
        contractCheck: {
          mirror: "RPCHeader",
          member: "SlotNumber",
          serializedKey: "slotNumber",
          expectedTag: 'json:"slotNumber"',
          observedTag: null,
          actual: "missing",
        },
      },
    ],
  },
  prNumber: 33589,
  prTitle: "core/vm: implement eip-7843: SLOTNUM",
  sourceProjectId: "ethereum/go-ethereum",
  targetProjectId: "mantle-xyz/mantle-v2",
  targetCommit: "46803658bf7c4b2835f9ab8b2dbc1dfecff08f59",
  checkedAt: "2026-06-15",
};

if (ZH_PATH) {
  // English verdict text — renderAlertCardZh should translate it to Chinese.
  sample.verdict.summary =
    "Contract mirror drift: local mirror struct `RPCHeader` (op-service/sources/types.go) is missing the `SlotNumber` field that upstream `Header` added. The fork maintains its own copy of the upstream header and it is now out of sync; once op-geth bumps to include EIP-7843, Amsterdam-era block headers will drop slotNumber during hash computation and op-node will reject blocks.";
  sample.verdict.recommendedAction =
    "Add `SlotNumber *hexutil.Uint64` to `RPCHeader` in op-service/sources/types.go and pass it through in CreateGethHeader() to mirror upstream `Header`.";
  sample.verdict.evidence[0]!.note = "Stale local mirror: `RPCHeader` is missing member `SlotNumber` (upstream `Header`).";
}

const json = ZH_PATH ? await renderAlertCardZh(sample, getSettings(), {}) : renderAlertCard(sample);
if (!json) {
  console.error("card did not render (gate)");
  process.exit(1);
}
console.log(JSON.stringify(JSON.parse(json), null, 2));

if (process.argv.includes("--send")) {
  const webhook = getSettings().lark.webhookUrl;
  if (!webhook) {
    console.error("LARK_WEBHOOK_URL not set");
    process.exit(1);
  }
  const res = await sendCard(webhook, JSON.parse(json));
  console.log(`\nsendCard: code=${res.code} msg=${res.msg}`);
}
