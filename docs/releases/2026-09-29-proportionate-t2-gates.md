# Proportionate T2 gates

2026-09-29, proportionate T2 gates, T0 and workstation only:
`stable.test.mjs` drives `verify` through the patch default (smoke), the
minor default (full), both `T2_SCOPE` overrides and a refused value, and
checks that `t2.json` records the scope and files. On colima (4 CPUs,
shared), the smoke subset passed 6/6 files in 27 s with 3 workers and the
full suite 25/25 in 271 s with 2 workers (304 s before the T2 wait and
stack changes). Not yet run by `stable.sh verify` on Testbox.
