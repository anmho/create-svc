# Google Observability v1 Design

This document locks the v1 observability direction for `create-service`. It is intentionally docs-only. The follow-up implementation PR should follow this design directly rather than reopen architecture choices.

## 1. Goals and defaults

### Goals

- Standardize runtime telemetry across all four generated service variants:
  - `go + chi`
  - `go + connectrpc`
  - `bun + hono`
  - `bun + connectrpc`
- Give every generated repo the same request ID, log, metric, and trace contract.
- Add generated troubleshooting commands so operators do not need to remember raw `gcloud` or Grafana flows.
- Centralize dashboards and alert definitions in Git while keeping service logs in each service project.
- Run a self-hosted Grafana in a dedicated observability host project so dashboarding and alerting stay under platform control.

### Locked defaults

- Telemetry backend: Google Cloud Operations Suite.
- Grafana runtime: self-hosted Grafana on Cloud Run.
- Grafana host project: a dedicated observability host project.
- Grafana app/config database: Neon Postgres.
- Logging scope in v1: logs stay in each service project.
- Dashboard, datasource, and alert definitions: Git-managed and provisioned on Grafana startup.
- This PR changes documentation only. No executable behavior changes are included here.

### Default generated config shape

Future generated repos add an `observability` block to `scripts/cloudrun/config.ts`:

```ts
observability: {
  enabled: true,
  provider: "google",
  hostProjectId: "anmho-observability-prod",
  google: {
    monitoringProjectId: "anmho-observability-prod",
    loggingProjectId: "",
  },
  grafana: {
    enabled: true,
    serviceName: "grafana",
    region: "us-west1",
    dashboardFolder: "create-svc",
  },
}
```

### Meaning of each default

- `enabled`: emit the shared runtime telemetry contract and generate observability commands/assets.
- `provider`: fixed to `"google"` for v1. Other providers are out of scope.
- `hostProjectId`: GCP project that owns Grafana, its runtime service account, and observability bootstrap resources.
- `google.monitoringProjectId`: project queried for metrics and traces. Default is the observability host project.
- `google.loggingProjectId`: blank means "do not centralize logs in v1". Services keep logging in their own project.
- `grafana.enabled`: generate Grafana provisioning assets and host-project wiring.
- `grafana.dashboardFolder`: top-level folder name used by provisioned dashboards and alerts.

### Non-goals for v1

- No vendor selection work beyond Google.
- No log export or log bucket centralization.
- No per-team dashboard authoring workflow outside Git.
- No click-ops provisioning of Grafana dashboards, datasources, or alerts.
- No implementation in this PR.

## 2. Runtime observability contract

The runtime side is the contract every generated service must implement, regardless of language or framework.

### Request ID contract

- Accept inbound `x-request-id`.
- Generate a request ID if the header is absent.
- Return the normalized value as `X-Request-Id` on the response.
- Store the request ID in request context so handlers, interceptors, and loggers can reuse it.
- If a W3C trace context exists, keep it; otherwise start a trace/span in the runtime library and surface `trace_id` in logs when available.

### Logging contract

All application logs emitted by the generated runtime wrapper are JSON logs written to stdout/stderr for Cloud Run ingestion.

Required log fields:

- `service`
- `environment`
- `runtime`
- `framework`
- `request_id`
- `trace_id`
- `route`
- `method`
- `status_code`
- `latency_ms`

Additional allowed fields:

- `severity`
- `message`
- `project_id`
- `revision`
- `location`
- endpoint-specific structured fields added by the service

Locked v1 logging behavior:

- Access logs come from generated middleware/interceptors, not from ad hoc handler code.
- Error logs reuse the same field set and add `error`, `error_kind`, and optional stack/context fields.
- `trace_id` may be empty when no trace context is available, but the key must still exist.
- Because logs remain per-service-project in v1, operators use generated commands or per-project Grafana queries to inspect them.

### Metrics contract

The shared metric names are fixed for v1:

- `svc_endpoint_requests_total`
- `svc_endpoint_duration_seconds`
- `svc_endpoint_errors_total`
- `svc_endpoint_in_flight`

Metric semantics:

- `svc_endpoint_requests_total`: counter incremented once per completed request.
- `svc_endpoint_duration_seconds`: request duration histogram.
- `svc_endpoint_errors_total`: counter incremented for requests completed with a 5xx status or ConnectRPC error classified as server-side failure.
- `svc_endpoint_in_flight`: gauge incremented on request start and decremented on completion.

Required metric labels:

- `service`
- `environment`
- `runtime`
- `framework`
- `route`
- `method`
- `status_code`

Locked v1 rules:

- The label schema is shared across REST and ConnectRPC.
- `route` uses the normalized route or RPC path template, not raw URLs.
- `status_code` is the final HTTP status code surfaced to the client.
- Histogram bucket selection is implementation detail, but the metric name and label set are not.

### Middleware and interceptor contract

- REST handlers use generated HTTP middleware.
- ConnectRPC handlers use generated unary interceptors or wrapper middleware with the same request ID, logging, metrics, and trace behavior.
- Generated entrypoints wire observability before business handlers.

Illustrative Go runtime snippet:

```go
router.Use(obs.HTTPMiddleware(obs.Config{Service: "{{SERVICE_NAME}}"}))
path, handler := connectapi.NewHandler(service /* later with obs interceptor */)
router.Mount(path, handler)
```

Illustrative Bun runtime shape:

```ts
const obsConfig = { service: "{{SERVICE_NAME}}", runtime: "bun", framework: "hono" };
app.use("*", obs.httpMiddleware(obsConfig));
```

### Transport expectations by template

- `go + chi`: HTTP middleware wraps REST routes and ConnectRPC mount points.
- `go + connectrpc`: same middleware plus ConnectRPC interceptor on the primary RPC path.
- `bun + hono`: Hono middleware wraps all routes.
- `bun + connectrpc`: fetch wrapper handles request ID, structured logs, metrics, and trace correlation around the ConnectRPC handler.

## 3. Generated connectors / CLI surface

The generator side adds a first-class observability section to generated config and expands the generated Cloud Run CLI.

### Generated config additions

The shared generated config file remains `scripts/cloudrun/config.ts`. v1 adds:

- `observability.enabled`
- `observability.provider`
- `observability.hostProjectId`
- `observability.google.monitoringProjectId`
- `observability.google.loggingProjectId`
- `observability.grafana.enabled`
- `observability.grafana.serviceName`
- `observability.grafana.region`
- `observability.grafana.dashboardFolder`

### New generated commands

The generated `service` CLI gains these new commands:

- `logs`
- `metrics`
- `traces`
- `doctor`
- `observability-bootstrap`

Their intended behavior is locked now:

- `logs`: open the standard Cloud Logging query path for the service project and selected environment.
- `metrics`: open or print the standard metric explorer query set for the four shared metrics.
- `traces`: open or print the standard trace query path for the service and environment.
- `doctor`: run an opinionated health/troubleshooting sweep covering Cloud Run status, recent logs, recent traces, and required observability wiring.
- `observability-bootstrap`: provision or update observability host-project assets, Grafana service wiring, datasource/dashboard/alert provisioning assets, and required IAM.

Illustrative CLI snippet:

```ts
if (command === "doctor") {
  await runMain("Doctor", () => doctor(rest));
}
if (command === "observability-bootstrap") {
  await runMain("Observability Bootstrap", () => observabilityBootstrap(rest));
}
```

### Generated Make targets

Generated repos add matching top-level Make targets:

- `make logs`
- `make metrics`
- `make traces`
- `make doctor`
- `make observability-bootstrap`

The targets remain thin wrappers around `npx --no-install service ...`, matching the current `create`, `deploy`, and `destroy` pattern.

### Generated implementation boundaries

- "Connectors" here means generated repo commands and platform integration code inside the scaffolded repository.
- v1 does not introduce MCP/plugin dependencies.
- The generator owns the shared CLI and config surfaces in `templates/shared/scripts/cloudrun`.

## 4. Grafana-on-Cloud-Run architecture

### Topology

v1 uses one dedicated observability host project that owns the shared Grafana deployment:

- Cloud Run service: `grafana`
- Region: `us-west1` by default
- Database: Neon Postgres for Grafana application/config state
- Datasource backend: Google Cloud Monitoring / Cloud Trace / Cloud Logging via Grafana's Google Cloud integration
- Dashboard and alert definitions: provisioned from files committed to Git

### Why this architecture is locked

- Cloud Run keeps Grafana deployment aligned with the rest of the platform.
- Neon avoids introducing Cloud SQL as another platform dependency for v1.
- Git-managed provisioning removes dashboard drift and keeps PR review as the control point.
- Keeping logs in each service project avoids introducing a log-routing program in the first rollout.

### Host-project wiring

`observability-bootstrap` is responsible for creating or reconciling:

- the Grafana Cloud Run service
- a dedicated Grafana runtime service account in the host project
- host-project Secret Manager secrets for Grafana admin credentials and Neon connection info
- IAM bindings required for the Grafana service account
- startup-mounted provisioning assets for datasources, dashboards, and alert rules

Locked IAM model:

- The Grafana service account gets `roles/monitoring.viewer` and `roles/cloudtrace.user` on the monitoring project.
- The Grafana service account gets `roles/logging.viewer` on each service project whose logs should be queryable from Grafana.
- Service projects do not host Grafana in v1.

### Provisioning assets

The implementation PR generates repo-managed assets for:

- datasource provisioning YAML
- dashboard provider YAML
- dashboard JSON
- alerting/contact-point/notification-policy provisioning files
- Grafana Cloud Run deployment manifest or create inputs

Locked provisioning model:

- Datasources, dashboards, and alert rules are source-controlled.
- Grafana loads them at container startup.
- Grafana's Neon database stores runtime state such as users, sessions, annotations, and alert evaluation state.
- The database is not the source of truth for dashboard definitions.

## 5. Dashboard and alert contract

### Dashboard foldering and naming

- Grafana folder: `create-svc`
- Dashboard naming convention: `<service> / <view>`
- Required variables: `service`, `environment`, `region`

### Required starter dashboards

Every service gets provisioned dashboards that follow the same layout:

- `Service Overview`
- `Endpoint Detail`
- `Recent Logs and Traces`

Minimum panel set:

- request rate from `svc_endpoint_requests_total`
- latency p50/p95/p99 from `svc_endpoint_duration_seconds`
- error rate from `svc_endpoint_errors_total`
- in-flight requests from `svc_endpoint_in_flight`
- recent structured logs filtered by service/environment
- trace lookup panel or links filtered by service/environment

### Alert contract

v1 provisions Grafana-managed alert rules from Git. The default rules are:

- `high-error-rate`: error ratio over 5% for 10 minutes
- `high-latency-p95`: p95 latency over 1 second for 10 minutes

Alert labels must include:

- `service`
- `environment`
- `severity`
- `source`

Locked alerting behavior:

- Alerts are provisioned, not created manually in the UI.
- Thresholds are platform defaults and may be overridden only by editing Git-managed assets.
- Notification routing is owned by the observability host project configuration.

### Query model

- Metrics and traces query the monitoring project configured in `observability.google.monitoringProjectId`.
- Logs query the service project by default because `observability.google.loggingProjectId` is blank in v1.
- Dashboards may mix host-project metrics/traces with per-project logs through separate datasource/query configuration, but the source-of-truth project mapping is fixed by the config block.

## 6. Phased implementation plan

The implementation work is intentionally phased. Each phase is considered complete only when its acceptance criteria are met without expanding scope.

### Phase 1: runtime instrumentation in all 4 templates

Generated files/assets:

- shared observability helper templates for Go runtimes
- shared observability helper templates for Bun runtimes
- entrypoint updates in all four generated runtime variants
- any required config-loading additions to expose environment/service metadata to the runtime wrapper

New commands:

- none

Acceptance criteria:

- Every generated service variant emits JSON access logs with the required fields.
- Every generated service variant propagates or generates request IDs and returns `X-Request-Id`.
- REST and ConnectRPC paths both flow through the shared observability wrapper for their runtime.
- The four shared metric names are emitted consistently across variants.

Explicit out-of-scope:

- Grafana deployment
- generated troubleshooting commands
- centralized log routing
- alert provisioning

### Phase 2: generated Google troubleshooting connectors and Make targets

Generated files/assets:

- `templates/shared/scripts/cloudrun/cli.ts` updates for `logs`, `metrics`, `traces`, and `doctor`
- supporting Cloud Run command modules under `templates/shared/scripts/cloudrun/`
- generated Makefile target additions in every runtime template
- generated README updates in scaffolded repos documenting the new commands

New commands:

- `logs`
- `metrics`
- `traces`
- `doctor`

Acceptance criteria:

- New generated repos expose the four commands through both `service` and `make`.
- Each command resolves the correct project, region, service, and environment without hand-edited arguments for the default case.
- `doctor` surfaces missing or broken observability wiring in a single opinionated report.

Explicit out-of-scope:

- Grafana deployment
- dashboard provisioning
- alert provisioning
- log centralization

### Phase 3: Google dashboard/alert artifacts and observability bootstrap

Generated files/assets:

- Grafana datasource provisioning files
- Grafana dashboard provider files
- baseline dashboard JSON files
- Grafana alert rule and notification provisioning files
- `templates/shared/scripts/cloudrun/observability-bootstrap.ts`
- config additions for the `observability` block

New commands:

- `observability-bootstrap`

Acceptance criteria:

- Generated repos include the locked observability config block.
- `observability-bootstrap` can reconcile the required provisioning assets and host-project IAM inputs.
- Dashboards and alerts are sourced from Git-managed files only.

Explicit out-of-scope:

- alternate dashboard backends
- centralized logging project rollout
- custom per-service alert authoring UX

### Phase 4: self-hosted Grafana on Cloud Run with provisioned datasource/dashboards and Neon-backed config DB

Generated files/assets:

- host-project deployment inputs for the Grafana Cloud Run service
- Secret Manager wiring for Grafana admin credentials and Neon connection material
- Cloud Run deployment configuration for mounting/loading provisioning assets
- any repo templates needed to keep Grafana deployment reproducible from Git

New commands:

- no additional commands beyond `observability-bootstrap`

Acceptance criteria:

- Grafana runs in the configured host project and region.
- Grafana uses Neon Postgres as its application/config database.
- Provisioned datasources, dashboards, and alert rules load on startup without UI click-ops.
- Grafana can query host-project metrics/traces and service-project logs according to the IAM model in this document.

Explicit out-of-scope:

- Grafana HA/multi-region deployment
- SSO/provider-specific auth customization
- tenant-isolated Grafana instances per service

## Implementation notes for the follow-up PR

- Treat this document as the contract source.
- Prefer small shared runtime helpers over per-template bespoke logic.
- Preserve the current generated repo ergonomics: config in `scripts/cloudrun/config.ts`, CLI entrypoint in `scripts/cloudrun/cli.ts`, top-level `make` wrappers, and scaffolded README command documentation.
- If an implementation detail must vary by language, keep the user-facing contract identical.
