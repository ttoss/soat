# PRD: Quotas & Rate Limiting

> Part of [Agent Operations on Formations](./prd-agent-operations.md).
> Depends on the meter-write choke point from
> [prd-usage-metering.md](./prd-usage-metering.md) (Phase 1) for token/cost
> windows; complements the per-action classification in
> [guardrails](../packages/website/docs/modules/guardrails.md).

**Status: fully shipped.** The module (request/token/cost quotas, the Koa
request middleware, the `QUOTA_EXCEEDED` / `429` contract, monitor mode, the
`quota.exceeded` webhook, and the `quota` formation resource) is live and
documented in the website module doc at
[`packages/website/docs/modules/quotas.md`](../packages/website/docs/modules/quotas.md).

## Pending Work

_None — the module is fully shipped._

- **Monitor-mode audit entries — shipped.** A `monitor`-mode breach now writes a
  platform-originated `AuditEntry` (`action: quotas:MonitorBreach`,
  null `principal_type`/`principal_id`,
  `detail.kind: quota_monitor_breach`) once per
  window at the same `fireQuotaExceeded` choke point that emits the
  `quota.exceeded` webhook. `enforce` breaches surface as the `429` the audit
  middleware already records, so they need no entry here. Live behavior in the
  [quotas](../packages/website/docs/modules/quotas.md#monitor-mode) and
  [audit-log](../packages/website/docs/modules/audit-log.md#system-originated-entries)
  module docs.
