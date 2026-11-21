FROM python:3.12-slim

# Listen on all addresses inside the container; docker-compose.yml only publishes the port to the VPS itself.
ENV PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=8000 \
    STATE_FILE=/data/state.json

# Run as an unprivileged user that owns the data folder (where state.json lives).
RUN useradd --system --uid 10001 app && mkdir /data && chown app /data

WORKDIR /app
# The server, and src/ (the scenes, control panel, assets and fonts: the only files it serves).
COPY server.py ./
COPY src ./src

USER app
VOLUME /data
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/api/session' % os.environ['PORT'], timeout=2)"

CMD ["python", "server.py"]
