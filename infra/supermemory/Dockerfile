# Build context: infra/supermemory/. This image is inert until stop gate R1.
FROM debian:bookworm-slim

ARG TARGETARCH
ARG SUPERMEMORY_VERSION=server-v0.0.5
ARG SUPERMEMORY_X64_SHA256=b2fccca3ff2b5607ce41028c759f375c4ecf5461adc9f3306f41c2757edaf375
ARG SUPERMEMORY_ARM64_SHA256=dd3e48fbabbffc628c5f61b3d895c27abf803c5a2f9fb485d73bc72f40613c0f

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl perl tini \
  && rm -rf /var/lib/apt/lists/* \
  && case "$TARGETARCH" in \
       amd64) asset="x64"; checksum="$SUPERMEMORY_X64_SHA256" ;; \
       arm64) asset="arm64"; checksum="$SUPERMEMORY_ARM64_SHA256" ;; \
       *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 64 ;; \
     esac \
  && tempdir="$(mktemp -d)" \
  && curl -fsSL -o "$tempdir/supermemory-server" "https://github.com/supermemoryai/supermemory/releases/download/$SUPERMEMORY_VERSION/supermemory-server-linux-$asset" \
  && echo "$checksum  $tempdir/supermemory-server" | sha256sum -c - \
  && install -m 0755 "$tempdir/supermemory-server" /usr/local/bin/supermemory-server \
  && mkdir -p /usr/share/doc/supermemory \
  && curl -fsSL -o /usr/share/doc/supermemory/LICENSE "https://raw.githubusercontent.com/supermemoryai/supermemory/97888ce/LICENSE" \
  && printf '%s\n' "Supermemory Local $SUPERMEMORY_VERSION binary; source notice preserved from commit 97888ce." > /usr/share/doc/supermemory/NOTICE \
  && rm -rf "$tempdir" \
  && groupadd --system supermemory \
  && useradd --system --gid supermemory --home-dir /var/lib/supermemory --shell /usr/sbin/nologin supermemory \
  && install -d -o supermemory -g supermemory -m 0700 /var/lib/supermemory

COPY --chmod=0755 entrypoint.sh /usr/local/bin/supermemory-entrypoint

ENV SUPERMEMORY_DATA_DIR=/var/lib/supermemory \
    OPENAI_MODEL=gpt-5.1 \
    OPENAI_FAST_MODEL=gpt-5.1 \
    OPENAI_TEXT_MODEL=gpt-5.1 \
    SUPERMEMORY_EMBEDDING_PROVIDER=local \
    SUPERMEMORY_EMBEDDING_MODEL=Xenova/bge-base-en-v1.5 \
    SUPERMEMORY_EMBEDDING_DIMENSIONS=768

USER supermemory
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/supermemory-entrypoint"]
# The wrapper owns the pinned binary. Docker supplies no duplicate argv item.
CMD []
