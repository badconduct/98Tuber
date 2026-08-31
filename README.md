# 98Tuber viewer

98Tuber is a LAN-only, HTTP viewer for Windows 98SE and IE6. Its table-based
period layout searches YouTube through the YouTube Data API, converts an
explicitly requested video to MPEG-1/VCD, and serves the result to Windows
Media Player 6.4.

It is deliberately viewer-only. Accounts, favorites, comments, uploads, the
legacy PostgreSQL sidecar, and old cached videos are not part of Dockernet.

## Runtime contract

- Intended URL: `http://youtube.98se.mowattech.ca/`.
- HTTP is intentional for IE6 and permitted only on the trusted LAN. Do not
  publish it to the Internet or use it for reusable credentials.
- Production uses `YOUTUBE_API_KEY_FILE` with a read-only mounted secret.
  `YOUTUBE_API_KEY` remains available only for local development. Setting both
  is rejected; values never belong in Git, image layers, or labels.
- `/data/cache` is persistent but regenerable. It is not backed up as user
  data. The current Windows cache remains the rollback source.
- One conversion runs at a time. The defaults limit input to 15 minutes and
  output to 300 MiB. The derived cache is capped at 20 GiB and evicts its
  oldest complete files before conversion, protecting the A4-9120 and SSD.
- Media URL deciphering uses the application-provided Jinter evaluator required
  by `youtubei.js`; a real authorized video remains part of deployment
  acceptance because YouTube can change this interface independently of us.
- This service stays always on; Sablier is unsuitable for long transcodes.

Only process content you are authorized to access, consistent with the
upstream service's applicable terms.

## Local development

Create an ignored `.env`:

```env
YOUTUBE_API_KEY=replace-me
```

```bash
npm ci
npm test
docker compose up --build
```

Open `http://127.0.0.1:3000/health/live`. A successful search verifies the
API key and browse path; a small authorized video verifies conversion.

Before a full conversion, exercise the volatile YouTube player, signature,
and media-download path with an authorized video ID. The preflight fetches at
most 1 KiB and saves nothing:

```bash
MEDIA_PREFLIGHT_VIDEO_ID=REPLACE_WITH_AUTHORIZED_VIDEO_ID \
  npm run preflight:media
```

In the production container, run the same bounded check with:

```bash
docker exec -e MEDIA_PREFLIGHT_VIDEO_ID=REPLACE_WITH_AUTHORIZED_VIDEO_ID \
  dockernet-98tuber node scripts/media-preflight.js
```

To inspect the populated period layout without an API key or Docker, run
`npm run preview:layout` and open `http://127.0.0.1:3211/`. The preview binds
only to loopback and uses fixture metadata.

## Delivery to Dockernet

1. CI scans Git history for secrets, validates dependencies and tests, builds
   one image, smoke-tests it, and scans it for vulnerabilities. On `main`, that
   exact local image is tagged and pushed to GHCR without rebuilding.
2. Record the resulting immutable image digest.
3. Promote that digest in a separate `dockernet-infra` pull request with the
   role, route, secret playbook, inventory, runbook, and acceptance test.
4. After merge, an operator runs the Ansible playbook twice from Debian WSL
   and performs the Windows 98/IE6 acceptance test.

Publishing never deploys. The old Windows instance stays available through the
reviewed rollback window.
