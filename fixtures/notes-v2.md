# Release Notes — Sprint 14

Owner: **Dana Osei**. Target: Q3.

## Deployment

```bash
helm upgrade checkout ./charts/checkout --set replicas=4 --set canary=true
```

## Tasks

- [x] Feature flag created
- [x] Load test at 2x traffic
- [ ] Update runbook

| Stage | Traffic |
| ----- | ------- |
| Canary | 5% |
| Wave 1 | 25% |

## Comms

Announce in #eng-announce once Wave 1 is stable.
