# Cascade Clash overlay

Stream overlay (`index.html`), bracket scene (`bracket.html`) and a control panel (`control.html`).

## Run with Docker

1. Set a password:
   ```bash
    cp .env.example .env    # edit it: set CONTROL_PASSWORD to something long
   ```
2. Start (listens on `127.0.0.1:7999` ):
   ```bash
    docker compose up -d --build
   ```

## Run locally (no Docker)

```bash
python3 server.py    # http://localhost:7999, no password needed
```

Append `?preview=1` to a scene URL to see it in a normal browser window.
