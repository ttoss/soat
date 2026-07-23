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

- **Monitor-mode audit entries — deferred.** A persisted audit record for a
  monitor-mode breach is owned by the audit-log module. The `AuditEntry` model
  now exists (audit-log Phase 1 shipped), so this is unblocked wiring rather
  than a blocked dependency; the `quota.exceeded` webhook remains the interim
  durable signal. Tracked under the audit-log module.
