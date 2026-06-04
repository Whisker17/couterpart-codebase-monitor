#!/usr/bin/env bash
set -euo pipefail

DB="data/monitor.db"

# ── Colors ──────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

section() { echo -e "\n${BOLD}${CYAN}═══ $1 ═══${NC}\n"; }
ok()      { echo -e "  ${GREEN}✓${NC} $1"; }
warn()    { echo -e "  ${YELLOW}!${NC} $1"; }
fail()    { echo -e "  ${RED}✗${NC} $1"; }

# ── 0. Prerequisites ───────────────────────────────────────────────
section "0. Prerequisites"

if ! command -v bun &>/dev/null; then
  warn "bun not found, installing..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if command -v bun &>/dev/null; then
    ok "bun installed: $(bun --version)"
  else
    fail "bun installation failed"; exit 1
  fi
else
  ok "bun $(bun --version)"
fi

if [ ! -f "$DB" ]; then
  fail "Database not found: $DB (are you in the project root?)"
  exit 1
fi
ok "Database: $DB"

if [ -f "data/health.json" ]; then
  ok "health.json exists"
else
  warn "health.json not found — pipeline may not have run yet"
fi

HAS_SQLITE=false
if command -v sqlite3 &>/dev/null; then
  HAS_SQLITE=true
  ok "sqlite3 available"
else
  warn "sqlite3 not found, using bun for queries"
fi

# ── Helper: run SQL ────────────────────────────────────────────────
run_sql() {
  local query="$1"
  if $HAS_SQLITE; then
    sqlite3 -header -column "$DB" "$query"
  else
    bun -e "
      const { Database } = require('bun:sqlite');
      const db = new Database('${DB}', { readonly: true });
      const rows = db.query(\`${query}\`).all();
      if (rows.length === 0) { console.log('  (no rows)'); }
      else { console.table(rows); }
    "
  fi
}

# ── 1. Health ──────────────────────────────────────────────────────
section "1. Health Status"

if [ -f "data/health.json" ]; then
  bun -e "
    const h = JSON.parse(require('fs').readFileSync('data/health.json', 'utf8'));
    const age = Date.now() - new Date(h.lastRun).getTime();
    const ageH = (age / 3600000).toFixed(1);
    console.log('  Last run:    ', h.lastRun);
    console.log('  Success:     ', h.success);
    console.log('  PRs processed:', h.prsProcessed);
    console.log('  Age:         ', ageH + 'h ago');
    console.log('  Consecutive failures:', h.consecutiveFailures);
    if (h.errors?.length > 0) console.log('  Errors:', h.errors.join(', '));
  "
fi

# ── 2. Time Windows ───────────────────────────────────────────────
section "2. Report Time Windows"

WINDOWS=$(bun -e "
  import { getYesterdayPeriod, getWeekPeriod } from './src/utils/time-window.ts';
  const tz = 'Asia/Shanghai';
  const d = getYesterdayPeriod(tz);
  const w = getWeekPeriod(tz);
  console.log(JSON.stringify({ ds: d.startUnix, de: d.endUnix, ws: w.startUnix, we: w.endUnix }));
")

DS=$(echo "$WINDOWS" | bun -e "const w=JSON.parse(await Bun.stdin.text()); process.stdout.write(String(w.ds))")
DE=$(echo "$WINDOWS" | bun -e "const w=JSON.parse(await Bun.stdin.text()); process.stdout.write(String(w.de))")
WS=$(echo "$WINDOWS" | bun -e "const w=JSON.parse(await Bun.stdin.text()); process.stdout.write(String(w.ws))")
WE=$(echo "$WINDOWS" | bun -e "const w=JSON.parse(await Bun.stdin.text()); process.stdout.write(String(w.we))")

echo "  Daily window (Shanghai yesterday):"
echo "    start: $DS  $(date -u -d @$DS 2>/dev/null || date -u -r $DS 2>/dev/null || echo '?') UTC"
echo "    end:   $DE  $(date -u -d @$DE 2>/dev/null || date -u -r $DE 2>/dev/null || echo '?') UTC"
echo ""
echo "  Weekly window (Shanghai past 7 days):"
echo "    start: $WS  $(date -u -d @$WS 2>/dev/null || date -u -r $WS 2>/dev/null || echo '?') UTC"
echo "    end:   $WE  $(date -u -d @$WE 2>/dev/null || date -u -r $WE 2>/dev/null || echo '?') UTC"

# ── 3. Collect — PR counts ────────────────────────────────────────
section "3. Collect: PRs in Daily Window"

run_sql "
SELECT project_id, COUNT(*) as pr_count,
       SUM(CASE WHEN diff_status = 'available' THEN 1 ELSE 0 END) as diff_ok,
       SUM(CASE WHEN analysis_status = 'complete' THEN 1 ELSE 0 END) as analyzed,
       SUM(CASE WHEN analysis_status = 'failed' THEN 1 ELSE 0 END) as failed,
       SUM(CASE WHEN analysis_status = 'pending' THEN 1 ELSE 0 END) as pending
FROM pull_requests
WHERE merged_at BETWEEN $DS AND $DE
GROUP BY project_id;
"

TOTAL_PRS=$(bun -e "
  const { Database } = require('bun:sqlite');
  const db = new Database('${DB}', { readonly: true });
  const r = db.query('SELECT COUNT(*) as n FROM pull_requests WHERE merged_at BETWEEN ? AND ?').get($DS, $DE);
  process.stdout.write(String(r.n));
")
echo ""
echo "  Total PRs in window: $TOTAL_PRS"

# ── 4. Analyze — significance breakdown ───────────────────────────
section "4. Analyze: Significance Breakdown"

run_sql "
SELECT a.significance, COUNT(*) as count
FROM analyses a
JOIN pull_requests p ON a.pr_id = p.id
WHERE p.merged_at BETWEEN $DS AND $DE
GROUP BY a.significance
ORDER BY
  CASE a.significance
    WHEN 'directional_shift' THEN 0
    WHEN 'notable' THEN 1
    ELSE 2
  END;
"

# ── 5. Analyze — top PRs ──────────────────────────────────────────
section "5. Analyze: PR Details"

run_sql "
SELECT p.project_id, p.pr_number, p.title,
       a.significance,
       COALESCE(a.direction_signal, '-') as direction,
       substr(a.summary, 1, 60) as summary
FROM analyses a
JOIN pull_requests p ON a.pr_id = p.id
WHERE p.merged_at BETWEEN $DS AND $DE
ORDER BY
  CASE a.significance
    WHEN 'directional_shift' THEN 0
    WHEN 'notable' THEN 1
    ELSE 2
  END,
  p.project_id
LIMIT 30;
"

# ── 6. Analysis Inputs — diff quality ─────────────────────────────
section "6. Analysis Inputs: Diff Quality"

run_sql "
SELECT ai.input_quality, COUNT(*) as count,
       SUM(ai.diff_truncated) as truncated_count,
       AVG(ai.diff_included_files) as avg_files_included,
       AVG(ai.diff_total_files) as avg_files_total
FROM analysis_inputs ai
JOIN analyses a ON ai.analysis_id = a.id
JOIN pull_requests p ON a.pr_id = p.id
WHERE p.merged_at BETWEEN $DS AND $DE
GROUP BY ai.input_quality;
"

# ── 7. Report & Delivery ──────────────────────────────────────────
section "7. Reports & Deliveries (recent 10)"

run_sql "
SELECT r.id, r.type,
       datetime(r.period_start, 'unixepoch') as start_utc,
       datetime(r.period_end, 'unixepoch') as end_utc,
       datetime(r.created_at, 'unixepoch') as created_utc
FROM reports r
ORDER BY r.created_at DESC
LIMIT 10;
"

echo ""
echo "  Delivery status:"
run_sql "
SELECT r.type, d.card_index, d.status,
       COALESCE(d.lark_message_id, '-') as msg_id,
       COALESCE(datetime(d.sent_at, 'unixepoch'), '-') as sent_utc
FROM report_deliveries d
JOIN reports r ON d.report_id = r.id
ORDER BY d.id DESC
LIMIT 10;
"

# ── 8. Cost ────────────────────────────────────────────────────────
section "8. LLM Cost (current month)"

run_sql "
SELECT COUNT(*) as analyses,
       SUM(input_tokens) as input_tokens,
       SUM(output_tokens) as output_tokens,
       printf('\$%.2f', SUM(estimated_cost_usd)) as total_cost
FROM analyses
WHERE analyzed_at >= unixepoch('now', 'start of month');
"

# ── 9. Report files ───────────────────────────────────────────────
section "9. Report Files"

if [ -d "data/reports" ]; then
  ls -lhrt data/reports/ | tail -10
else
  warn "data/reports/ not found"
fi

# ── Done ──────────────────────────────────────────────────────────
section "Done"
echo -e "  Full diagnosis complete. Check ${YELLOW}docs/ops-runbook.md${NC} for manual queries."
