# 98Tuber viewer

98Tuber is a LAN-only, HTTP viewer for Windows 98SE and IE6. It searches
YouTube through the YouTube Data API, converts an explicitly requested video
to MPEG-1/VCD, and serves the result to Windows Media Player 6.4.

It is deliberately viewer-only. Accounts, favorites, comments, uploads, the
legacy PostgreSQL sidecar, and old cached videos are not part of Dockernet.

## Runtime contract

- Intended URL: `http://youtube.98se.mowattech.ca/`.
- HTTP is intentional for IE6 and permitted only on the trusted LAN. Do not
  publish it to the Internet or use it for reusable credentials.
- `YOUTUBE_API_KEY` is required at runtime and comes from a protected
  Dockernet secret file; never Git, image layers, or labels.
- `/data/cache` is persistent but regenerable. It is not backed up as user
  data. The current Windows cache remains the rollback source.
- One conversion runs at a time. The defaults limit input to 15 minutes and
  output to 300 MiB, protecting Dockernet's A4-9120 CPU and SSD.
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
npm run check
docker compose up --build
```

Open `http://127.0.0.1:3000/health/live`. A successful search verifies the
API key and browse path; a small authorized video verifies conversion.

## Delivery to Dockernet

1. CI validates dependencies, syntax, vulnerabilities, and an image build.
   Merge to `main` publishes a GHCR commit tag.
2. Record the resulting immutable image digest.
3. Promote that digest in a separate `dockernet-infra` pull request with the
   role, route, secret playbook, inventory, runbook, and acceptance test.
4. After merge, an operator runs the Ansible playbook twice from Debian WSL
   and performs the Windows 98/IE6 acceptance test.

Publishing never deploys. The old Windows instance stays available through the
reviewed rollback window.
