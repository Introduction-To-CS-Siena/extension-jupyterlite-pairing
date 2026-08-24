# JupyterLite Notebook Pairing

## Notebook pairing

The pairing extension is maintained and deployed from its own repository. This
site consumes its prebuilt wheel using an exact PyPI pin:

```text
csis110-jupyterlab-pairing==0.1.1
```

Each pairing room:

- is addressed by a random ten-character code;
- is isolated in its own Durable Object;
- stores the Yjs document in Durable Object storage; and
- expires after 24 hours by default.

Treat the pairing code like a temporary password. Joining replaces the current
notebook contents, so students should join from a new notebook unless they do
not need the local copy.

### Pairing service

The Worker is built and deployed by the pairing extension repository, not by
this site's workflow. The extension connects to `sync.lab.csis110.com` by
default; another URL can be selected with `serviceUrl` in the JupyterLab
**Notebook Pairing** settings.



A self-contained JupyterLab extension and Cloudflare Durable Object service for
pairing browser-based JupyterLite notebooks with a short room code.

```text
JupyterLite site
  └─ prebuilt JupyterLab extension
       └─ Hocuspocus/Yjs over WebSocket
            └─ Cloudflare Worker
                 └─ one Durable Object per room code
```

The extension is distributed as a Python wheel so a consuming JupyterLite site
does not need Node.js or a source-extension build. The Worker is deployed
independently and can be shared by multiple sites listed in `ALLOWED_ORIGINS`.

## Repository layout

- `extension/` — TypeScript extension plus its Python wheel wrapper.
- `worker/` — Worker, Durable Object, persistence, expiration, and WebSockets.
- `.github/workflows/ci.yml` — validates both deliverables.
- `.github/workflows/release-extension.yml` — publishes release wheels to PyPI.
- `.github/workflows/deploy-worker.yml` — manually deploys the Worker.

## Use the extension from another JupyterLite site

After publishing a release, add an exact pin to that site's `requirements.txt`:

```text
csis110-jupyterlab-pairing==0.2.0
```

Installing the wheel registers the prebuilt extension. A normal
`jupyter lite build` then copies it into the static site automatically.

The extension defaults to `https://sync.lab.csis110.com`. Change the
`serviceUrl` setting under **Notebook Pairing** in JupyterLab when using another
Worker URL.

## Develop and test

Node.js 24 and Python 3.14 are used in CI.

```bash
python -m pip install -r extension/requirements-build.txt

cd extension
npm ci
npm run build
python -m build --wheel --no-isolation
cd ..

cd worker
npm ci
npm run check
npm run dev
```

## Publish the extension

Keep the version in `extension/package.json` and `extension/pyproject.toml` in
sync, then create a GitHub release for that version. The release workflow builds
the JavaScript bundle, creates a platform-independent wheel, and publishes it
using PyPI Trusted Publishing.

Before the first release, create the `csis110-jupyterlab-pairing` project or a
pending publisher on PyPI and configure this GitHub repository as a Trusted
Publisher with the `pypi` environment and
`.github/workflows/release-extension.yml` workflow.

## Deploy the Worker

Set these GitHub repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Run the **Deploy pairing Worker** workflow, or deploy locally:

```bash
cd worker
npm ci
npm run check
npx wrangler login
npm run deploy
```

Attach `sync.lab.csis110.com` as a Worker custom domain in Cloudflare. Change
`ALLOWED_ORIGINS` and `ROOM_TTL_SECONDS` in `worker/wrangler.jsonc` as needed.
Room codes are temporary capabilities, so anyone with a valid code can join.

## Current trade-offs

- Rooms expire after 24 hours by default.
- The MVP uses standard Durable Object WebSockets because Hocuspocus retains
  active Yjs session state in memory.
- The Worker stores notebook collaboration state, but authentication and Google
  Drive export are intentionally outside its current scope.
- If usage grows substantially, revisit WebSocket hibernation, authenticated
  rooms, rate limits, and per-account retention policies.

# extension-jupyterlite-pairing
