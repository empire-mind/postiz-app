# Shorts production readiness

The current starting point is the dependency-free, local loopback pilot in `scripts/shorts-draft.mjs`. See the [Shorts draft pilot](shorts-draft-pilot.md) for use. Managed staging needs separate evidence from the actual Postiz API, PostgreSQL, Redis, Temporal and media storage. Record local, staging and production results independently.

## 1. Build a release candidate

- Keep the [build workflow](../.github/workflows/build.yml), local builds and the container on the runtime and package manager versions in [`package.json`](../package.json) and [`Dockerfile.dev`](../Dockerfile.dev). Install from the frozen lockfile. Pin the base image, service images and build tools, including PM2. Use a clean build context that excludes runtime configuration and credentials. Record the commit, dependency inventory, image digests and build results.
- Adapt the [container workflow](../.github/workflows/build-containers.yml) for an authorised registry before enabling image publication. The checked-in workflow targets the upstream image and updates `latest`. Carry the exact tested image digest through staging and production.
- Run the pilot tests, affected frontend, backend and worker tests, and the full workspace build on the candidate. Rerun the affected tests and staging fixtures after changes to code, schema, deployment configuration or dependencies. Keep the [AGPL licence](../LICENSE) with the release and provide corresponding source for the deployed revision as applicable under section 13.

## 2. Prove the full stack in isolated staging

Use a private environment with its own Postiz database, Redis, Temporal namespace and task queue, and media storage. Provision two fixture tenants with separate users, integrations and media. Use owned or synthetic MP4s and deny real provider publishing egress. Supply credentials at runtime, restrict admin ports, keep registration closed once fixture users are provisioned, and leave `NOT_SECURED` unset when testing HTTPS sessions. The default [Compose file](../docker-compose.yaml) exposes administration ports and uses mutable images. The default [Nginx configuration](../var/docker/nginx.conf) serves local uploads directly. Verify the chosen media access controls before using unpublished footage.

Check the web app, authenticated API and persisted draft in the browser. Verify Temporal namespace health via the orchestrator's `/health/status` endpoint and run a separate harmless queue task to confirm a worker actually polls and completes work. Capture database and Temporal state for each draft fixture before and after the request. Use the real staging API and database for all three fixtures.

| Fixture | Passing evidence |
| --- | --- |
| New draft and replay | One draft with the expected tenant, integration, content and MP4 digest. Sequential and concurrent replays of the same request return the same draft ID with one durable record, including after an API restart. Reusing the key with changed content or destination fails safely. |
| Isolation and scope | A second tenant cannot read or mutate the first tenant's draft or use its media or integration. The draft credential cannot schedule or publish. Attempts to change the approved revision, media, destination or publishing time require new approval. |
| Interrupted request | After a simulated response timeout following commit, reconcile by the persisted request identifier. Read back the existing draft and its media, and prove retry creates no duplicate draft or orphaned media. |

For all three fixtures, capture draft IDs and states, no scheduled entries, **zero publish workflow starts** and zero provider mutations. The current draft path may inspect Temporal for earlier work, so use workflow history to count starts. Durable server idempotency needs a tenant-scoped uniqueness constraint or equivalent atomic guarantee. Its matching request must return the persisted outcome, and a mismatched request must fail without a mutation. A local receipt or client retry policy alone cannot establish this guarantee.

## 3. Prepare production and promotion

- Separate schema changes from application restarts. The current `pm2-run` runs `prisma db push` during startup. Prepare versioned, reviewed changes, apply them once per release and rehearse against representative sanitised data. Verify the candidate and rollback worker versions can read and replay any in-flight workflow histories they will handle.
- Verify production TLS and OAuth redirects, encrypted token storage with both backend and worker configured, restricted access to PostgreSQL, Redis and Temporal, private storage for unpublished media, and backups for application data, Temporal state and media. Restore them to an isolated environment and record elapsed recovery time and integrity checks.
- Name an owner for each environment, worker queue, connected social account, approval, alert and rollback. Use a draft-only credential for automation and one designated publishing writer per destination account. Record human approval for the exact content revision, MP4 digest, destination account and intended posting time or window. Verify active alerts for API errors, queue lag, stuck workflows and delivery reconciliation.
- Promote the same digest only after staging evidence and deployment approval are recorded. Require separate publishing authorisation for any live canary. For an authorised canary, publish to one named destination, read back the native provider ID and verify exactly one matching post. Record the candidate, approval, tenant, destination, draft ID, media digest, workflow evidence and native post ID without credentials.

## 4. Rehearse rollback before promotion

Pause publishing when draft isolation, queue processing or delivery reconciliation fails. Preserve application, Temporal and media evidence, then reconcile uncertain sends against the provider before retrying. Roll back to the previous image digest only when its schema and in-flight workflow histories are compatible. Otherwise roll forward with a reviewed fix or restore a coordinated set of backups. Verify access and data isolation with both fixture tenants, then verify worker polling, draft read-back and the absence of duplicate provider posts before resuming publishing.

Use the [Postiz architecture](https://docs.postiz.com/self-host/architecture) and [Docker Compose installation guide](https://docs.postiz.com/self-host/installation/docker-compose) to check supported deployment components.
