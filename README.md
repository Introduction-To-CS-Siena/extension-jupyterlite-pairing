# JupyterLite Notebook Pairing

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

Each pairing room:

- is addressed by a random ten-character code;
- is isolated in its own Durable Object;
- stores the Yjs document in Durable Object storage; and
- expires after 24 hours by default.

Treat the pairing code like a temporary password. Joining replaces the current
notebook contents, so students should join from a new notebook unless they do
not need the local copy.

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

By default the extension talks to `https://sync.lab.csis110.com`, the Worker
deployed from this repository for its own site. If you're reusing this
extension for a different site, you almost certainly want to point it at
your own Worker — see **Configuration** below.

## Configuration

Nothing here is hard-coded to `csis110.com`; every value below is meant to be
changed by whoever deploys their own copy of this project.

### Extension: which Worker to talk to (`serviceUrl`)

The extension has one setting, `serviceUrl`, the HTTPS base URL of the
Cloudflare Worker it connects to. There are three places to change it,
depending on how permanent the change should be:

1. **Built-in default** — [`extension/schema/plugin.json`](extension/schema/plugin.json)
   sets `properties.serviceUrl.default`. This is the fallback baked into the
   published wheel. If you fork this repository for your own site, change it
   here, bump the version in `extension/package.json` and
   `extension/pyproject.toml`, and cut a new release (see **Publish the
   extension** below).
2. **Site-wide override, no fork required** — a JupyterLite site can override
   any federated extension's settings at build time by adding an
   `overrides.json` file (see the [JupyterLite settings
   docs](https://jupyterlite.readthedocs.io/en/stable/howto/configure/settings.html))
   to the site's `jupyter-lite.json`/build directory:

   ```json
   {
     "@csis110/jupyterlab-pairing:plugin": {
       "serviceUrl": "https://your-worker.example.com"
     }
   }
   ```

   This is the recommended way to point an existing pinned wheel at a
   different Worker without forking or republishing anything.
3. **Per-browser override** — anyone can change **Settings → Notebook
   Pairing → Pairing service URL** in the JupyterLab UI. This only affects
   that person's browser (stored in browser storage), useful for testing
   against a local `npm run dev` Worker.

### Worker: which sites may connect (`ALLOWED_ORIGINS`) and its URL

The Worker side lives in [`worker/wrangler.jsonc`](worker/wrangler.jsonc):

- `vars.ALLOWED_ORIGINS` is a comma-separated CORS allow-list. It must
  include the origin of every JupyterLite site whose `serviceUrl` points at
  this Worker (and any local dev origins you use).
- `vars.ROOM_TTL_SECONDS` controls how long a pairing room lives before it
  expires.
- The Worker's own hostname (`sync.lab.csis110.com` in this repository) is
  set by attaching a [custom
  domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
  in the Cloudflare dashboard, not in this file. Whatever domain you attach
  is the URL you should use for `serviceUrl` above.

After changing `wrangler.jsonc`, redeploy — see **Deploy the Worker** below.

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

See **Configuration** above for `ALLOWED_ORIGINS`, `ROOM_TTL_SECONDS`, and the
Worker's custom domain. Room codes are temporary capabilities, so anyone with
a valid code can join.

## Current trade-offs

- Rooms expire after 24 hours by default.
- The MVP uses standard Durable Object WebSockets because Hocuspocus retains
  active Yjs session state in memory.
- The Worker stores notebook collaboration state, but authentication and Google
  Drive export are intentionally outside its current scope.
- If usage grows substantially, revisit WebSocket hibernation, authenticated
  rooms, rate limits, and per-account retention policies.
