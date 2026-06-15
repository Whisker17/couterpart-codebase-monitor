-- 008_impact_check_severity: add operational-severity dimension to impact checks.
-- Drives the Lark alert gate (only critical/high are pushed); medium/low go to the digest.
ALTER TABLE impact_checks
  ADD COLUMN severity TEXT CHECK(severity IN ('critical','high','medium','low'));
