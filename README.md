# JupyterLite Notebook Pairing

A JupyterLab extension and Cloudflare Worker that let two browser-based
JupyterLite notebooks edit the same document through a short room code.

```text
JupyterLite site
  └─ prebuilt JupyterLab extension
       └─ Hocuspocus/Yjs over WebSocket
            └─ Cloudflare Worker
                 └─ one Durable Object per room code
```

---

# Deploying a change

**Nothing here deploys automatically.** Merging to `main` runs CI and stops.
Both deliverables ship by hand, and they ship separately.

| What you changed | How it reaches users |
|---|---|
| `worker/` — Worker, admin dashboard, D1 schema | Run the Worker deploy |
| `extension/` — extension, sidebar, `schema/plugin.json` | Bump the version, cut a release, rebuild the site |

## Deploy the Worker

**Actions → Deploy pairing Worker → Run workflow**, on `main`.

That workflow applies any pending D1 migrations and then deploys. It needs two
repository secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

To deploy from your machine instead:

```bash
cd worker
npm ci
npm run check
npx wrangler login
npx wrangler d1 migrations apply csis110-jupyterlite-pairing --remote
npm run deploy
```

If `/admin` returns `{"error":"Not found."}` after a successful Access login,
the deployed Worker predates the admin routes — deploy it.

## Release the extension

The version lives in **two files, and they must match**:

| File | Field |
|---|---|
| `extension/package.json` | `"version"` |
| `extension/pyproject.toml` | `version` |

1. Set both to the same new value.
2. Merge to `main`.
3. Create a GitHub release tagged with that version. The release workflow
   builds the wheel and publishes it to PyPI via Trusted Publishing.
4. On the JupyterLite site, pin the new version in `requirements.txt` and
   re-run `jupyter lite build`.

Steps 3 and 4 are what actually reach users. A change to
`extension/schema/plugin.json` — the default `serviceUrl`, say — sits inert
until the site installs the new wheel. And a setting a user has already saved
in their browser keeps its stored value even then; schema defaults only apply
where nothing is set.

Before the first release, create the `csis110-jupyterlab-pairing` project (or a
pending publisher) on PyPI and configure this repository as a Trusted Publisher
with the `pypi` environment and `.github/workflows/release-extension.yml`.

---

# Configuration

Nothing is hard-coded to `csis110.com`; every value below is meant to be
changed by whoever deploys their own copy.

## Which Worker the extension talks to (`serviceUrl`)

Three places to set it, from most permanent to least:

1. **The shipped default** —
   [`extension/schema/plugin.json`](extension/schema/plugin.json),
   `properties.serviceUrl.default`. Changing it requires a release (above).
2. **A site-wide override, no fork needed** — the recommended way to point an
   existing pinned wheel at a different Worker. Add an `overrides.json` to the
   site's build ([JupyterLite settings
   docs](https://jupyterlite.readthedocs.io/en/stable/howto/configure/settings.html)):

   ```json
   {
     "@csis110/jupyterlab-pairing:plugin": {
       "serviceUrl": "https://your-worker.example.com"
     }
   }
   ```

3. **Per-browser** — **Settings → Notebook Pairing → Pairing service URL** in
   the JupyterLab UI. Affects that browser only; handy against a local
   `npm run dev` Worker.

## Worker settings

In [`worker/wrangler.jsonc`](worker/wrangler.jsonc):

| Key | Purpose |
|---|---|
| `ALLOWED_ORIGINS` | Comma-separated CORS allow-list. Must include every JupyterLite site whose `serviceUrl` points here, plus local dev origins. |
| `ROOM_TTL_SECONDS` | How long a room lives before expiring. |
| `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` | Gate the admin dashboard. Both unset ⇒ `/admin` 404s. |
| `ADMIN_HISTORY_SECONDS` | How long ended sessions stay listed (default 7 days). |
| `workers_dev` | Deliberately `false` — see below. |

The Worker's hostname (`sync-lab.csis110.com` here) comes from a [custom
domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
attached in the Cloudflare dashboard, not from this file. Whatever you attach
is what `serviceUrl` must point at.

## Session index (D1)

Rooms are Durable Objects addressed by their code, and a Durable Object's
storage is private to that instance — there is no way to enumerate them. So
rooms report themselves into a D1 table, which the dashboard reads.

Create it once, then put the name and the id it prints into `d1_databases[0]`:

```bash
cd worker
npx wrangler d1 create csis110-jupyterlite-pairing
npx wrangler d1 migrations apply csis110-jupyterlite-pairing --remote
```

The database name appears in **two** places — `worker/wrangler.jsonc` and the
migration step in `.github/workflows/deploy-worker.yml`. Change both together.

Neither the name nor the `database_id` is a secret: an id is an identifier, and
reaching the database still requires your API token. They live in the config
because Wrangler does not interpolate environment variables into it, so they
cannot come from the environment at deploy time.

Later schema changes only need a new file in `worker/migrations/`; the deploy
applies them. Index writes are best-effort — if D1 is down, pairing keeps
working and the room just doesn't appear on the dashboard.

---

# Admin dashboard

`https://<your-worker-domain>/admin` lists every pairing session — code,
status, participants, created, expires — and can end a session early or preview
the notebook inside one.

It stays disabled until Cloudflare Access is configured. With
`ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` unset, every `/admin` route returns 404,
so forgetting this section leaves you with no dashboard rather than an open one.

## Setup

1. Create a **self-hosted Access application** for
   `<your-worker-domain>/admin*`.

   Two details that cause real confusion:

   - Use `admin*`, not `admin`. A bare `/admin` matches that one path and
     leaves `/admin/api/…` ungated.
   - List **only the Worker's hostname**. Access issues its session cookie per
     hostname, so a second destination (your JupyterLite site, say) makes login
     bounce through `<other-host>/cdn-cgi/access/authorized` to plant a cookie
     there — which looks like the dashboard redirecting to the wrong domain.

2. Add a policy for who gets in.
3. Copy the application's **AUD tag**.
4. Put both values in `worker/wrangler.jsonc`:

   ```jsonc
   "ACCESS_TEAM_DOMAIN": "yourteam.cloudflareaccess.com",
   "ACCESS_AUD": "<the AUD tag>"
   ```

5. Deploy the Worker.

## What admins can see

This touches student work, so being explicit:

- Codes are masked (`ABCDE-•••••`) and reveal on click. A revealed code is a
  working capability — anyone holding it can join that session.
- **Inspect** renders a read-only preview of the notebook's contents.

Both are deliberate instructor powers. Admin actions are logged with the
verified email of whoever performed them.

## Working on it locally

`wrangler dev` cannot mint Access assertions, so local runs use a shared secret.
Create `worker/.dev.vars` (gitignored, never deployed):

```text
ADMIN_DEV_TOKEN=some-local-secret
```

```bash
cd worker
npx wrangler d1 migrations apply csis110-jupyterlite-pairing --local
npm run dev
curl -H "x-admin-dev-token: some-local-secret" http://127.0.0.1:8787/admin/api/rooms
```

When `ADMIN_DEV_TOKEN` is set the Access check is skipped entirely, so it
belongs only in `.dev.vars`. Production never sets it.

---

# Develop and test

Node.js 24 and Python 3.14 in CI.

```bash
python -m pip install -r extension/requirements-build.txt

cd extension && npm ci && npm run build && python -m build --wheel --no-isolation

cd ../worker && npm ci && npm run check && npm run dev
```

## Repository layout

- `extension/` — TypeScript extension plus its Python wheel wrapper.
- `worker/` — Worker, Durable Object, persistence, expiration, WebSockets.
- `worker/migrations/` — D1 schema for the session index behind `/admin`.
- `.github/workflows/ci.yml` — validates both deliverables on every push.
- `.github/workflows/release-extension.yml` — publishes release wheels to PyPI.
- `.github/workflows/deploy-worker.yml` — deploys the Worker, manually.

---

# Design notes

**Rooms.** Each is addressed by a random ten-character code, isolated in its own
Durable Object, stores its Yjs document in that object's storage, and expires
after 24 hours. Treat the code like a temporary password — anyone holding a
valid one can join. Joining replaces the current notebook's contents, so join
from a new notebook unless you don't need the local copy.

**Why `workers_dev` is off.** An Access application is scoped to a hostname. If
the Worker is also reachable at `<name>.<account>.workers.dev`, that hostname
isn't covered by a policy written for your custom domain, and `/admin` is served
there unauthenticated. The same applies to any extra route or domain you bind.

**Why the Worker verifies the Access token itself.** Rather than trusting that a
request arrived through Access, it checks the `Cf-Access-Jwt-Assertion` header.
That keeps the check in version control next to what it protects — a policy
edited or deleted in the dashboard can't silently unprotect the route — and
yields the caller's identity, which the edge gate alone does not.

**Known trade-offs.** The Worker uses standard Durable Object WebSockets
because Hocuspocus keeps live Yjs state in memory, so an active room bills for
wall-clock duration; revisit hibernation if usage grows. Authentication for
pairing itself and Google Drive export are out of scope. Rate limits and
per-account retention are unaddressed.
