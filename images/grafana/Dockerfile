# Grafana for run observability (ADR-0046 decision 6): the pinned official image with the SQLite
# datasource plugin installed at build time. Nothing is downloaded when the container runs: plugin
# preinstallation, update checks and usage reporting are off. Provisioning (the datasource for the
# selected engine and that engine's dashboards) is not baked in; `scripts/stable/stable.sh grafana
# start` mounts it from the active release's observability/grafana/<engine>/.
#
# Build context is this directory; it copies nothing:
#   scripts/build-grafana-image.sh builds it as deskmates/grafana:<arch>-<hash12>
#
# The tag is pinned to an exact release and to its multi-architecture index digest (read from
# Docker Hub on 2026-10-17). The Ubuntu variant, because the plugin's backend is a glibc binary.
FROM grafana/grafana:12.4.12-ubuntu@sha256:9d71f26403380c2150fd9365cf85f14b68c0ab54c91fdfdccbfb023f03bde54b

ARG SQLITE_DATASOURCE_VERSION=3.5.0

# Plugins live outside /var/lib/grafana, which stable.sh mounts as Grafana's own state directory
# and would otherwise hide them.
ENV GF_PATHS_PLUGINS=/opt/deskmates/grafana-plugins \
    GF_PLUGINS_PREINSTALL_DISABLED=true \
    GF_ANALYTICS_REPORTING_ENABLED=false \
    GF_ANALYTICS_CHECK_FOR_UPDATES=false \
    GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES=false \
    GF_NEWS_NEWS_FEED_ENABLED=false

USER root
RUN mkdir -p /opt/deskmates/grafana-plugins \
 && grafana cli --pluginsDir /opt/deskmates/grafana-plugins \
      plugins install frser-sqlite-datasource "${SQLITE_DATASOURCE_VERSION}" \
 && test -f /opt/deskmates/grafana-plugins/frser-sqlite-datasource/plugin.json \
 && chmod -R a+rX /opt/deskmates/grafana-plugins
# stable.sh runs the container as the host user that owns the data directory; the image's own
# user stays the default for anyone running it by hand.
USER grafana
