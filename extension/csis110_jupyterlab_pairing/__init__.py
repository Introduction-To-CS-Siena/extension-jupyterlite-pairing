def _jupyter_labextension_paths() -> list[dict[str, str]]:
    return [
        {
            "src": "labextension",
            "dest": "@csis110/jupyterlab-pairing",
        }
    ]

