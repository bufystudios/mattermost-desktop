# Bufy fork: reproducible Linux + Windows packaging environment for the Mattermost desktop app.
#
# electronuserland/builder:wine = Ubuntu 22.04, Node 24, Wine 11, rpm/dpkg/fpm deps for electron-builder.
# Pinned by digest (resolved from the `wine` tag on 2026-11-20); bump deliberately.
ARG BUILDER_IMAGE=docker.io/electronuserland/builder@sha256:f3a8d451994c881d0972e7b1846ee4d4fdc15eb41fc6b1f350b38cbf99ca90fe
FROM ${BUILDER_IMAGE}

# - rsync: copy the (read-only mounted) source tree into the container
# - cross compilers: node-gyp builds (empty on Linux) the upstream native add-ons for linux-arm64 on an x64 host
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        rsync gcc-aarch64-linux-gnu g++-aarch64-linux-gnu \
 && rm -rf /var/lib/apt/lists/*

# caches live on a mounted volume so repeated builds do not re-download Electron & co.
ENV ELECTRON_CACHE=/cache/electron \
    ELECTRON_BUILDER_CACHE=/cache/electron-builder \
    npm_config_cache=/cache/npm \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false \
    CI=true \
    USE_HARD_LINKS=false

WORKDIR /work
COPY build-in-container.sh /usr/local/bin/bufy-build-in-container
RUN chmod +x /usr/local/bin/bufy-build-in-container
ENTRYPOINT ["/usr/local/bin/bufy-build-in-container"]
