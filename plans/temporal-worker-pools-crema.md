# Serverless Temporal workers: Cloud Run Worker Pools + CREMA

Status: proposed
Owner: platform
Related code: `src/service-commands/cloudrun/{deploy,lib,deploy-args}.ts`, `templates/shared/service.yaml`

## Problem

`create-service` deploys every Temporal worker as an always-on Cloud Run
**Service** pinned at `min-instances=1` with CPU always allocated. That is
*correct* for a classic long-polling worker (it receives no inbound HTTP
requests, so request-based autoscaling can never wake it from zero), but it
means each worker burns one instance 24/7 even when its Task Queue is empty.

`omnichannel-worker` is the live example: one 1 vCPU / 512Mi instance running
continuously, which is the bulk of the steady Cloud Run spend.

We want workers to **scale to zero when their Task Queue is empty** without
breaking workflow/activity execution.

## Why not just `min-instances=0` on the Service?

A Temporal worker long-polls `WorkflowService`/`ActivityService`. With a plain
request-driven Cloud Run Service:

- `min-instances=0` → it scales to zero, stops polling, and workflows stall.
- CPU throttling between requests → the poll loop starves even at `min=1`.

So scale-to-zero is impossible in the Service model. It requires a different
resource type plus an external autoscaler.

## Chosen approach

Per Temporal's current GCP guidance ("Deploying Temporal Workers to Google
Cloud Run", May 2026) and Cloud Run docs:

1. Deploy the worker as a Cloud Run **Worker Pool** (no HTTP ingress).
2. Autoscale it with **CREMA** (Cloud Run External Metrics Autoscaling) keyed on
   Temporal's **Task Queue backlog** (Approximate Backlog Count). CREMA can
   scale the pool to **zero** when the queue drains.

Temporal's own "Serverless Workers" feature (Temporal invokes the compute) is
**AWS Lambda-only today**; Cloud Run support is on the roadmap, not shipped. So
Worker Pools + CREMA is the GCP-native path now.

```
                  polls backlog (every ~15s)
  ┌───────────────┐   via Temporal metrics    ┌──────────────────────────┐
  │ CREMA          │ ────────────────────────▶ │ Temporal Cloud / server   │
  │ autoscaler svc │                            └──────────────────────────┘
  │ (Service,      │   sets replica count
  │  min=1)        │ ────────────────────────▶ ┌──────────────────────────┐
  └───────────────┘   desired = ceil(backlog   │ omnichannel-worker        │
                       / targetQueueSize)       │ (Worker Pool, scales 0→N) │
                                                └──────────────────────────┘
```

Scaling formula (CREMA): `desiredReplicas = ceil(metricValue / targetValue)`
where `metricValue` = Task Queue backlog and `targetValue` = `targetQueueSize`.

## Prerequisites (one-time, per billed project)

1. **CREMA autoscaler service** — deploy the OSS CREMA image as an always-on
   Cloud Run Service. It must stay up (`min-instances=1`); if it scales to zero,
   nothing watches the queue:

   ```bash
   gcloud beta run deploy crema-autoscaler \
     --image=us-central1-docker.pkg.dev/cloud-run-oss-images/crema-v1/autoscaler:1.0 \
     --region="$REGION" \
     --service-account="crema-sa@$PROJECT.iam.gserviceaccount.com" \
     --no-allow-unauthenticated \
     --no-cpu-throttling \
     --min-instances=1 \
     --set-env-vars="CREMA_CONFIG=projects/$PROJECT/locations/global/parameters/crema-config/versions/1"
   ```

2. **CREMA config** in Parameter Manager (`crema-config`), one `scaledObject`
   per worker pool. Example for the `omnichannel` task queue:

   ```yaml
   scaledObjects:
     - spec:
         scaleTargetRef:
           name: projects/$PROJECT/locations/$REGION/workerpools/omnichannel-worker
         minReplicaCount: 0          # scale to zero
         maxReplicaCount: 5
         triggers:
           - type: temporal
             metadata:
               endpoint: temporal-grpc.anmho.com:7233
               namespace: default
               taskQueue: omnichannel
               targetQueueSize: "5"
               activationTargetQueueSize: "1"
               queueTypes: workflow,activity   # both, or you miss workflow starts
               selectUnversioned: "true"        # required for workers without Build IDs
       pollingInterval: 15
   ```

3. **IAM** for `crema-sa`:
   - `roles/run.developer` (scale the worker pool) — grant on the pool:
     ```bash
     gcloud run worker-pools add-iam-policy-binding omnichannel-worker \
       --region="$REGION" \
       --member="serviceAccount:crema-sa@$PROJECT.iam.gserviceaccount.com" \
       --role="roles/run.developer"
     ```
   - `roles/secretmanager.secretAccessor` (read the Temporal API key/credentials)
   - `roles/parametermanager.parameterViewer` (read `crema-config`)

## `create-service` changes

- **Worker manifest → Worker Pool.** Replace the worker branch of
  `renderManifest`/`deploy.ts` (currently `gcloud run services replace` on a
  `kind: Service`) with a Worker Pool deploy (`gcloud run worker-pools deploy`
  / `replace`) using a new `templates/shared/worker-pool.yaml`. The API service
  path is unchanged.
- **`autoscalingForProcess`** (in `deploy-args.ts`) becomes the seam: the
  `worker` case stops emitting `minScale=1` for a Service and instead drives the
  Worker Pool's `minReplicaCount=0` + CREMA wiring. The interim Service values
  it returns today are the safe fallback until this lands.
- **Provisioning** of the CREMA autoscaler service, Parameter Manager config,
  and IAM belongs in the Terraform/bootstrap path alongside the existing
  per-service resources.

## Terraform sketch

```hcl
resource "google_cloud_run_v2_worker_pool" "omnichannel_worker" {
  name     = "omnichannel-worker"
  location = var.region
  template {
    containers {
      image = var.worker_image
      resources { limits = { cpu = "1", memory = "512Mi" } }
    }
    service_account = var.runtime_sa
  }
  scaling { min_instance_count = 0 }   # CREMA drives the count up from here
}

# CREMA autoscaler (always-on) + Parameter Manager config + IAM bindings
# (crema-sa: run.developer on the pool, secretAccessor, parameterViewer)
# omitted for brevity — see Prerequisites above.
```

## Rollout

1. Land `create-service` Worker Pool support behind the existing `worker` role
   (this PR ships the safe interim Service config + this plan).
2. Stand up CREMA autoscaler + config + IAM in one non-prod project; deploy a
   throwaway worker pool; confirm scale 0→N→0 against a test task queue.
3. Cut `omnichannel-worker` over: deploy the Worker Pool, verify it drains a
   backlog, then delete the old always-on worker Service.
4. Make Worker Pool the default for `service_role: worker`.

## Rollback

Each step is independent. If the pool misbehaves, redeploy the worker as the
always-on Service (`autoscalingForProcess("worker")` → `min=1`, CPU always on)
and delete the pool. No workflow state is lost — Temporal retains the backlog.

## References

- Temporal: Deploying Temporal Workers to Google Cloud Run (May 2026)
- Cloud Run: Deploy worker pools; Autoscale worker pools with external metrics (CREMA)
- Temporal: Serverless Workers (Lambda today; Cloud Run roadmap)
