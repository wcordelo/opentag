# Graphify is pinned to an immutable source commit. The query role extends the
# version-matched Sandbox runtime because GraphQueryContainer uses the Sandbox
# SDK's binding-backed R2 mount; the base image supplies the required control
# plane on port 3000. The builder role still uses this image through the plain
# Containers API and overrides the application entrypoint at runtime.
FROM --platform=linux/amd64 docker.io/cloudflare/sandbox:0.12.4-python

LABEL org.opencontainers.image.rebuild="2026-08-05-graphify-health-recovery-1"

ARG GRAPHIFY_COMMIT=00efd6e7969837ae4a9f11d8d504dcd3b20b09df

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates fuse3 git s3fs \
  && rm -rf /var/lib/apt/lists/* \
  && printf '%s\n' user_allow_other >> /etc/fuse.conf

WORKDIR /opt/graphify-src
RUN git init \
  && test "$GRAPHIFY_COMMIT" = "00efd6e7969837ae4a9f11d8d504dcd3b20b09df" \
  && git remote add origin https://github.com/wcordelo/graphify.git \
  && git fetch --depth=1 origin "$GRAPHIFY_COMMIT" \
  && git checkout --detach "$GRAPHIFY_COMMIT" \
  && test "$(git rev-parse HEAD)" = "$GRAPHIFY_COMMIT" \
  && python3 -m pip install --no-cache-dir .

WORKDIR /app
COPY graphify-api.py graphify-builder.py start-query.sh ./
RUN chmod 0755 /app/graphify-api.py /app/graphify-builder.py /app/start-query.sh

ENV PORT=8080 \
    PATH=/usr/local/python/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    GRAPHIFY_COMMIT=$GRAPHIFY_COMMIT \
    GRAPHIFY_R2_MOUNT=/mnt/graphs
EXPOSE 8080
# The Sandbox base image owns ENTRYPOINT and starts its control plane on 3000;
# this CMD is the application process on the separately configured 8080 port.
CMD ["/app/start-query.sh"]
