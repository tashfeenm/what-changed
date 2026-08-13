# Release Notes — Sprint 14

Owner: **Dana Osei**. Target: Q3.

> WARNING: payment rate limits unresolved (PROJ-42).

## Deployment

```bash
helm upgrade checkout ./charts/checkout --set replicas=2
```

## Tasks

- [x] Feature flag created
- [ ] Load test at 2x traffic
- [ ] Update runbook

| Stage | Traffic |
| ----- | ------- |
| Canary | 5% |
