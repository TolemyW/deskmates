# Test-only derivative for ADR-0048's native GUI and independent saved-file oracle. Never used by
# the release or stable deployment scripts; the optional production variant has no fixture.
ARG DESKTOP_IMAGE
FROM ${DESKTOP_IMAGE}
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3-gi gir1.2-gtk-3.0 \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*
COPY native-fixture.py /opt/deskmates/desktop-fixture.py
