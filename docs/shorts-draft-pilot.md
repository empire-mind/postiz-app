# Shorts Studio draft handoff pilot

This pilot takes a reviewed MP4 and its caption into an isolated Postiz workspace as a draft. Use a local Postiz instance with local media storage, a fixture workspace and a fixture integration. Keep social provider publishing unavailable in this environment. Serve the public API and uploads on the same loopback origin. Set `FRONTEND_URL=http://127.0.0.1:4007` for the example below, using the exact port and host in the API endpoint. The [production readiness path](./shorts-production-readiness.md) covers staging and promotion.

## Prepare one export

Use media that you own or are allowed to process. Put a finished MP4 and its JSON manifest in the same local bundle directory. Keep the bundle, credential and receipt outside the source checkout.

Use these exact manifest fields. Replace the sample account and integration identifiers with the values read back from the fixture workspace. Use one stable content ID per intended draft.

```json
{
  "version": 1,
  "contentId": "studio-export-001",
  "workspaceId": "fixture-workspace",
  "integrationId": "fixture-integration",
  "provider": "linkedin",
  "date": "2026-12-01T10:00:00Z",
  "caption": "Reviewed draft caption.",
  "media": "export.mp4",
  "mediaSha256": "replace-with-the-lowercase-sha256-of-export.mp4"
}
```

The UTC date selects where the draft appears in the calendar. Calculate the file digest with `shasum -a 256 export.mp4` on macOS or `sha256sum export.mp4` on Linux.

## Review and apply

Run a plan with the repository's pinned Node version. Planning reads the local bundle and prints the content identity and both SHA-256 digests.

```sh
node scripts/shorts-draft.mjs \
  --manifest ./owned-bundle/manifest.json \
  --endpoint http://127.0.0.1:4007/api/public/v1
```

Review the exact manifest and export. Use the manifest digest from the plan. Supply the isolated workspace key to the process as `POSTIZ_API_KEY` through the environment. Use the same persistent journal directory for every operator and retry in this local pilot.

```sh
node scripts/shorts-draft.mjs \
  --manifest ./owned-bundle/manifest.json \
  --endpoint http://127.0.0.1:4007/api/public/v1 \
  --apply \
  --expected-manifest-sha256 REVIEWED_MANIFEST_SHA256 \
  --journal-dir ./local-pilot-receipts
```

The command checks workspace and integration identity before uploading. It uploads the exact reviewed MP4 through the public Postiz upload API, passes the returned media reference to a draft-only create request, then verifies the returned post ID in the authenticated calendar listing. Success requires state `DRAFT`, the reviewed caption and calendar time, the expected account and provider, and empty release identifiers. If the provider rewrites the caption, the command reports a mismatch and retains the receipt for reconciliation. Review the stored asset in the calendar.

The journal uses a stable operation ID for the Postiz origin, workspace, integration and content ID. It stores digests, phase and returned IDs. A repeat of the same manifest with a known post ID performs read-back. A different manifest or an unfinished write blocks another attempt. The local operation guard covers concurrent calls and process interruptions for callers sharing the same journal directory.

If an attempt is interrupted, keep the journal. Check the recorded phase, media and post IDs against the Postiz workspace and audit evidence. An upload or create request can have taken effect even when its response was missing. Pause and reconcile before another write.

## Configure a scoped staging fixture

Use a dedicated fixture workspace. Configure `POSTIZ_PILOT_DRAFT_API_ORG_ID` with its ID and `POSTIZ_PILOT_DRAFT_API_KEY_SHA256` with the lowercase SHA-256 digest of a dedicated `pzd_` credential followed by 64 random lowercase hexadecimal characters. Supply the original credential to the CLI using `POSTIZ_API_KEY` from the approved secret source and add `--require-scoped-key` to the apply command. Give editorial playback to a separate authorised browser session.

The scoped credential can read workspace identity, integrations and drafts, upload files, and create one new unpublished draft. The CLI sends a stable `Idempotency-Key` and the reviewed manifest digest. PostgreSQL commits the organisation-scoped receipt and draft together. Repeating the same request with the same media reference while the workspace and integration remain available returns the stored result. Reusing the key with changed fields is rejected. The upload is a separate operation, so retain the media reference when reconciling a retry.

For private local playback, use `STORAGE_PROVIDER=local` and set `POSTIZ_PRIVATE_LOCAL_MEDIA_DIRECTORY` to an existing dedicated directory outside public mounts. Set `FRONTEND_URL` to the exact HTTP(S) frontend origin and route `/api/` to the authenticated backend with the prefix removed. An authorised workspace session can stream the private file with byte ranges and a private, non-cacheable response. Use a fresh isolated fixture store when qualifying this route.

For a container rehearsal, pin the Postiz candidate digest and mount a separate writable volume at `POSTIZ_PRIVATE_LOCAL_MEDIA_DIRECTORY`. Include that volume in the same recovery drill as the database. Preserve the original browser-facing origin during restore because private media URLs stored in the database are absolute.

## Verify the pilot

```sh
node --test scripts/*.test.mjs
python3 -B -m unittest discover -s scripts -p test_shorts_draft_fixture_restore.py
pnpm test
```

The Node fixture tests check the CLI, the isolation preflight and media handling. `pnpm test` runs the application's Jest suites after dependencies are installed. To verify the real local stack on Linux, use Python 3.11+, FFmpeg, PostgreSQL, Redis, Temporal CLI and the Node version pinned in the repository. Install workspace dependencies and build the backend and orchestrator before entering the isolated network namespace.

```sh
pnpm install --frozen-lockfile
pnpm run build:backend
pnpm run build:orchestrator

unshare --user --map-user="$(id -u)" --map-group="$(id -g)" \
  --net --keep-caps --pid --fork --kill-child \
  sh -c 'ip link set lo up && exec python3 -B "$@"' sh \
  scripts/shorts-draft-native-smoke.py --postgres-bin-dir "$(pg_config --bindir)" \
  --verify-private-media --verify-restore
```

The smoke script requires a non-root user and a namespace with only a working loopback interface. It starts fresh services, uses generated media and temporary fixture keys, and emits a JSON receipt. Verify that the wrong workspace cannot see the draft or submit the handoff, a same-journal replay after the API restarts adds no rows, and the stored MP4 matches its digest and decodes. The smoke test also drops a successful create response and checks that the draft persisted once and retry leaves the stored result alone. The Temporal execution counts should be zero before and after the cases.

With `--verify-restore`, the harness uses `pg_dump`, `createdb` and `pg_restore` from the same PostgreSQL binaries. It restores the quiescent fixture into a second disposable database and a separate media directory, verifies asset digests and opens a fresh API process to check tenant visibility. The recorded durations measure the local fixture. Measure hosted recovery separately on the approved candidate.

With `--verify-private-media`, the smoke test uses synthetic browser sessions to verify owner access, an exact `206` byte range, cache controls and access denial for anonymous and other-tenant requests over HTTP. Play and seek in a real browser on the approved staging candidate to complete playback acceptance.
