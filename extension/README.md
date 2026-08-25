# JupyterLab Pairing

JupyterLab extension for pairing JupyterLite notebooks through the
Cloudflare Durable Object service.

After installation, notebooks receive **Start pairing** and **Join pairing**
toolbar buttons, and a **Join Notebook Pairing** launcher tile.

The Worker this extension talks to is controlled by the `serviceUrl` setting
(**Settings → Notebook Pairing** in JupyterLab). See the [repository
README's Configuration section](../README.md#configuration) for how to set a
site-wide default without forking this extension.

