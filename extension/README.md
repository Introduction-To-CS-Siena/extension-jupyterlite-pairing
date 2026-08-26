# JupyterLab Pairing

JupyterLab extension for pairing JupyterLite notebooks through the
Cloudflare Durable Object service.

After installation, notebooks receive **Start pairing** and **Join pairing**
toolbar buttons, a **Join Notebook Pairing** launcher tile, and a **Notebook
Pairing** panel in the right sidebar.

The sidebar panel keeps the active session's pairing code on screen with a copy
button, so it can still be shared with a third person after the session has
started.

**Settings → Notebook Pairing → Show the admin dashboard link** adds a link to
the pairing service's admin dashboard at the bottom of that panel. It is off by
default, since the sidebar is visible to everyone.

The Worker this extension talks to is controlled by the `serviceUrl` setting
(**Settings → Notebook Pairing** in JupyterLab). See the [repository
README's Configuration section](../README.md#configuration) for how to set a
site-wide default without forking this extension.

