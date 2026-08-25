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
- `worker/migrations/` — D1 schema for the session index behind `/admin`.
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
- `workers_dev` is set to `false` on purpose. See **Why `workers_dev` is
  off** under the admin dashboard below before changing it.

After changing `wrangler.jsonc`, redeploy — see **Deploy the Worker** below.

### Session index (D1)

The dashboard needs to list every pairing room, and rooms are Durable Objects
addressed by their code. A Durable Object's storage is private to that one
instance, so there is no way to enumerate them — rooms report themselves into
a D1 table instead, which the dashboard reads.

Create the database once per deployment, then put the name you chose and the
id it prints into `d1_databases[0]` in `worker/wrangler.jsonc`:

```bash
cd worker
npx wrangler d1 create csis110-jupyterlite-pairing
npx wrangler d1 migrations apply csis110-jupyterlite-pairing --remote
```

Neither value is a secret — a `database_id` is an identifier, and reaching the
database still requires your Cloudflare API token — so both live in
`wrangler.jsonc` alongside the rest of the Worker's configuration rather than
in GitHub secrets. Wrangler does not interpolate environment variables into its
config, so these cannot be supplied from the environment at deploy time.

The database name appears in two places: `worker/wrangler.jsonc` and the
migration step in `.github/workflows/deploy-worker.yml`. Change both together.

The deploy workflow applies migrations before each deploy, so later schema
changes only need a new file in `worker/migrations/`.

Index writes are best-effort by design: if D1 is unavailable, pairing keeps
working and the room simply does not appear on the dashboard.

## Admin dashboard

`https://<your-worker-domain>/admin` lists every pairing session — code,
status, how many people are connected, when it was created, and when it
expires — and can end a session early or preview the notebook inside one.

It is disabled until you configure Cloudflare Access. With
`ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` unset, every `/admin` route returns 404,
so a deployment that skips this section has no dashboard rather than an open
one.

### Setup

1. In the Cloudflare dashboard, create a **self-hosted Access application**
   for `<your-worker-domain>/admin*`. The single `/admin*` prefix covers both
   the page and its API, so there is no second path to remember.
2. Add a policy for whoever should get in (an email, a group, an identity
   provider rule).
3. Copy the application's **AUD tag**.
4. Set both values in `worker/wrangler.jsonc`:

   ```jsonc
   "ACCESS_TEAM_DOMAIN": "yourteam.cloudflareaccess.com",
   "ACCESS_AUD": "<the AUD tag>"
   ```

5. Redeploy.

### Why `workers_dev` is off

An Access application is scoped to a hostname. If the Worker is also reachable
at `<name>.<account>.workers.dev`, that hostname is not covered by a policy
written for your custom domain, and `/admin` is served there with no
authentication at all. `workers_dev: false` removes that second door. The same
applies to any extra route or custom domain you bind later.

### Why the Worker verifies the token too

The Worker independently verifies the `Cf-Access-Jwt-Assertion` header rather
than trusting that a request arrived through Access. This keeps the check in
version control next to the thing it protects — an Access policy edited or
deleted in the dashboard cannot silently unprotect the route — and it gives the
Worker the caller's identity, which the edge gate alone does not. Admin actions
that reach student notebooks are logged with that verified email.

### What admins can see

Two things worth being explicit about, since this touches student work:

- Pairing codes are shown masked (`ABCDE-•••••`) and reveal on click. A
  revealed code is a working capability — anyone holding it can join that
  session.
- **Inspect** renders a read-only preview of the notebook's current contents.

Both are deliberate instructor powers, not incidental. `ADMIN_HISTORY_SECONDS`
controls how long ended sessions stay listed (default 7 days) before being
pruned.

### Working on the dashboard locally

`wrangler dev` cannot mint Access assertions, so local runs use a shared-secret
header instead. Create `worker/.dev.vars` (gitignored, never deployed):

```text
ADMIN_DEV_TOKEN=some-local-secret
```

Then apply the schema to the local database and pass the header:

```bash
cd worker
npx wrangler d1 migrations apply csis110-jupyterlite-pairing --local
npm run dev
curl -H "x-admin-dev-token: some-local-secret" http://127.0.0.1:8787/admin/api/rooms
```

Production never sets `ADMIN_DEV_TOKEN`, and when it is set the Access check is
skipped entirely — so it belongs only in `.dev.vars`.

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
