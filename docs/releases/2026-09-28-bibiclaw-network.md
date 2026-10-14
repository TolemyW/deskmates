# Testbox network, from containers

2026-09-28, Testbox network, from containers. Corrects an earlier entry
here that read `--dns` success as bypassing the fake-IP: every port-53
query, to any server (Docker DNS, 223.5.5.5, 8.8.8.8, 119.29.29.29), gets a
`198.18.x` answer; the earlier fetches worked only because the host TUN
routes fake IPs. DoH to `https://223.5.5.5/resolve` returns real addresses,
and direct connections to them succeeded 9/9 (example.com, www.baidu.com,
github.com; 0.06–0.9 s). `ghcr.io` and `pkg-containers.githubusercontent.com`
are reset on the direct path (10/10) and fail 3 of 4 through the fake-IP;
the Docker daemon's `docker login ghcr.io` failed with EOF.
