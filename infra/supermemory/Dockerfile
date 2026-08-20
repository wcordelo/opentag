FROM --platform=linux/amd64 docker.io/cloudflare/sandbox:0.12.4

LABEL org.opentag.rollout="supermemory-provider-lifecycle-v2"
LABEL org.opencontainers.image.rebuild="2026-08-05-supermemory-r2-recovery-2"

ARG TARGETARCH=amd64
ARG SUPERMEMORY_VERSION=server-v0.0.5
ARG SUPERMEMORY_X64_SHA256=b2fccca3ff2b5607ce41028c759f375c4ecf5461adc9f3306f41c2757edaf375
ARG TIGRISFS_VERSION=v1.2.1
ARG TIGRISFS_LINUX_AMD64_SHA256=9fd6e7a9f3e7d86571ea55c66459205e94dfa5f6a25887d7e95c0a46f7641ed4

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl fuse3 perl socat tini util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && test "$TARGETARCH" = "amd64" \
  && test "$SUPERMEMORY_VERSION" = "server-v0.0.5" \
  && test "$TIGRISFS_VERSION" = "v1.2.1" \
  && tempdir="$(mktemp -d)" \
  && curl -fsSL -o "$tempdir/supermemory-server" "https://github.com/supermemoryai/supermemory/releases/download/$SUPERMEMORY_VERSION/supermemory-server-linux-x64" \
  && echo "$SUPERMEMORY_X64_SHA256  $tempdir/supermemory-server" | sha256sum -c - \
  && install -m 0755 "$tempdir/supermemory-server" /usr/local/bin/supermemory-server \
  && curl -fsSL -o "$tempdir/tigrisfs.tar.gz" "https://github.com/tigrisdata/tigrisfs/releases/download/$TIGRISFS_VERSION/tigrisfs_${TIGRISFS_VERSION#v}_linux_amd64.tar.gz" \
  && echo "$TIGRISFS_LINUX_AMD64_SHA256  $tempdir/tigrisfs.tar.gz" | sha256sum -c - \
  && mkdir -p "$tempdir/tigrisfs" \
  && tar -xzf "$tempdir/tigrisfs.tar.gz" -C "$tempdir/tigrisfs" \
  && tigrisfs_binary="$(find "$tempdir/tigrisfs" -type f -name tigrisfs -print -quit)" \
  && test -n "$tigrisfs_binary" \
  && install -m 0755 "$tigrisfs_binary" /usr/local/bin/tigrisfs \
  && mkdir -p /etc/fuse.conf.d \
  && printf '%s\n' 'user_allow_other' >> /etc/fuse.conf \
  && mkdir -p /usr/share/doc/supermemory \
  && curl -fsSL -o /usr/share/doc/supermemory/LICENSE "https://raw.githubusercontent.com/supermemoryai/supermemory/97888ce/LICENSE" \
  && printf '%s\n' "Supermemory Local $SUPERMEMORY_VERSION binary; source notice preserved from commit 97888ce." > /usr/share/doc/supermemory/NOTICE \
  && rm -rf "$tempdir" \
  && groupadd --system --gid 999 supermemory \
  && useradd --system --uid 999 --gid supermemory --home-dir /var/lib/supermemory --shell /usr/sbin/nologin supermemory \
  && install -d -o supermemory -g supermemory -m 0700 /var/lib/supermemory

COPY --chmod=0755 entrypoint.sh /usr/local/bin/supermemory-entrypoint
COPY --chmod=0755 port-gate.sh /usr/local/bin/supermemory-port-gate

ENV SUPERMEMORY_DATA_DIR=/var/lib/supermemory \
    PORT=6768 \
    OPENAI_MODEL=gpt-5.1 \
    OPENAI_FAST_MODEL=gpt-5.1 \
    OPENAI_TEXT_MODEL=gpt-5.1 \
    SUPERMEMORY_EMBEDDING_PROVIDER=local \
    SUPERMEMORY_EMBEDDING_MODEL=Xenova/bge-base-en-v1.5 \
    SUPERMEMORY_EMBEDDING_DIMENSIONS=768 \
    SUPERMEMORY_DISABLE_TELEMETRY=1

EXPOSE 6767 6768

USER root
CMD ["/usr/local/bin/supermemory-entrypoint"]
