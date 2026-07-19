# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

ARG CLIPROXY_VERSION=7.2.88
ARG CLIPROXY_AMD64_SHA256=9ab153cf450ea7d4cb359dbb1de88873578f3dffef34d569c2388c5f5152e294

# The slim Node image intentionally omits a system CA bundle. CLIProxyAPI is a
# Go binary and reads /etc/ssl/certs/ca-certificates.crt, so materialize the
# exact root set bundled in the digest-pinned Node runtime.
RUN mkdir -p /etc/ssl/certs \
    && node -e 'const fs=require("node:fs"),tls=require("node:tls");fs.writeFileSync("/etc/ssl/certs/ca-certificates.crt",tls.rootCertificates.join("\n")+"\n",{mode:0o644})'

ADD --checksum=sha256:9ab153cf450ea7d4cb359dbb1de88873578f3dffef34d569c2388c5f5152e294 \
  https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.88/CLIProxyAPI_7.2.88_linux_amd64_no-plugin.tar.gz \
  /tmp/cliproxy.tar.gz

RUN mkdir -p /opt/cliproxy /opt/opentag-claudex /var/lib/cliproxy/auth \
    && echo "${CLIPROXY_AMD64_SHA256}  /tmp/cliproxy.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/cliproxy.tar.gz -C /opt/cliproxy \
    && /opt/cliproxy/cli-proxy-api --help 2>&1 | grep -F "CLIProxyAPI Version: ${CLIPROXY_VERSION}," \
    && chown -R node:node /var/lib/cliproxy \
    && chmod 0700 /var/lib/cliproxy /var/lib/cliproxy/auth \
    && rm /tmp/cliproxy.tar.gz

COPY containers/claudex-proxy/server.mjs /opt/opentag-claudex/server.mjs

RUN chown -R root:root /opt/cliproxy /opt/opentag-claudex \
    && find /opt/cliproxy /opt/opentag-claudex -type f -exec chmod 0555 {} +

ENV HOME=/var/lib/cliproxy
USER node
EXPOSE 8080

ENTRYPOINT ["node", "/opt/opentag-claudex/server.mjs"]
