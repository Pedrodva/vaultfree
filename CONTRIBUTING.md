# Contributing

Thanks for helping! VaultFree is intentionally dependency-free (Node ≥ 20, vanilla JS).

1. Fork, branch, `npm test` must pass.
2. Add tests under `test/` for server or `shared/` changes (`node:test`).
3. Keep the zero-dependency, no-build-step philosophy; discuss before adding a dependency.
4. Shared logic (parsing, link resolution, merge) lives in `shared/` and runs in both Node and the browser.
5. Security-sensitive changes (auth, paths, rendering) need a test and a note in the PR.

Report vulnerabilities privately — see [SECURITY.md](SECURITY.md).
