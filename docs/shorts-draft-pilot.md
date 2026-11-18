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

## Verify the pilot

```sh
node --test scripts/shorts-draft.test.mjs scripts/shorts-draft-native-smoke.test.mjs
```

The fixture tests check the HTTP contract and the isolation preflight. To verify the real local stack on Linux, use Python 3.11+, FFmpeg, PostgreSQL, Redis, Temporal CLI and the Node version pinned in the repository. Install workspace dependencies and build the backend and orchestrator before entering the isolated network namespace.

```sh
pnpm install --frozen-lockfile
pnpm run build:backend
pnpm run build:orchestrator

unshare --user --map-user="$(id -u)" --map-group="$(id -g)" \
  --net --keep-caps --pid --fork --kill-child \
  sh -c 'ip link set lo up && exec python3 "$@"' sh \
  scripts/shorts-draft-native-smoke.py --postgres-bin-dir "$(pg_config --bindir)"
```

The smoke script requires a non-root user and a namespace with only a working loopback interface. It starts fresh services, uses generated media and temporary fixture keys, and emits a JSON receipt. Verify that the wrong workspace cannot see the draft or submit the handoff, a same-journal replay after the API restarts adds no rows, and the stored MP4 matches its digest and decodes. The smoke test also drops a successful create response and checks that the draft persisted once and retry leaves the stored result alone. The Temporal execution counts should be zero before and after the cases. Managed staging must separately qualify its own image, browser playback, scoped credentials and server-side duplicate protection.
