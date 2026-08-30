# Changelog

## [1.0.8](https://github.com/dachrisch/devhub/compare/v1.0.7...v1.0.8) (2026-08-30)


### Bug Fixes

* confine board scroll to items area, keep header fixed ([7065f7d](https://github.com/dachrisch/devhub/commit/7065f7d9bbd40bf0eedb9800e8b618af13945b7b))

## [1.0.7](https://github.com/dachrisch/devhub/compare/v1.0.6...v1.0.7) (2026-08-30)


### Bug Fixes

* use PUBLIC_BASE_URL for OAuth redirects ([54d96a8](https://github.com/dachrisch/devhub/commit/54d96a82958b0aa27dbc4000199990bd75dd4751))
* use PUBLIC_BASE_URL for OAuth redirects instead of req.url ([472efc8](https://github.com/dachrisch/devhub/commit/472efc801cc75e9f13bd12603ee19e61679f4155))

## [1.0.6](https://github.com/dachrisch/devhub/compare/v1.0.5...v1.0.6) (2026-08-30)


### Bug Fixes

* correct Dockerfile layering order ([383c9e1](https://github.com/dachrisch/devhub/commit/383c9e19e744a458e0ccbf59e33d6abe4c3cb9db))
* install curl in Docker image, retry health check in CI ([ba1112d](https://github.com/dachrisch/devhub/commit/ba1112dab62a68e7267a19f5d7d5f38b56a5341d))
* remove HEALTHCHECK from Dockerfile, update CI test workflow ([f7117f7](https://github.com/dachrisch/devhub/commit/f7117f7206671ce13ea5c8a5f00c0250ee9285d8))
* use wget for Docker health check instead of node -e fetch ([9e67b89](https://github.com/dachrisch/devhub/commit/9e67b894593f05fc4aba2b056dd10518a957a29a))

## [1.0.5](https://github.com/dachrisch/devhub/compare/v1.0.4...v1.0.5) (2026-08-30)


### Bug Fixes

* health check accepts any non-500 response ([7105de6](https://github.com/dachrisch/devhub/commit/7105de6c130cff63e32b97a9ead8a67342193558))

## [1.0.4](https://github.com/dachrisch/devhub/compare/v1.0.3...v1.0.4) (2026-08-30)


### Bug Fixes

* simplify Dockerfile node_modules layering ([d5c60fd](https://github.com/dachrisch/devhub/commit/d5c60fddf539abbcb56cf196137e6025d56f71cb))

## [1.0.3](https://github.com/dachrisch/devhub/compare/v1.0.2...v1.0.3) (2026-08-30)


### Bug Fixes

* regenerate package-lock.json from clean install ([7caf3e4](https://github.com/dachrisch/devhub/commit/7caf3e45e064bbcdcf32887322e51f65bf5f5ca6))

## [1.0.2](https://github.com/dachrisch/devhub/compare/v1.0.1...v1.0.2) (2026-08-30)


### Bug Fixes

* sync package-lock.json for npm ci ([f6887c7](https://github.com/dachrisch/devhub/commit/f6887c7e12a4db2621257352f8c2f8ef2b2dbb0c))

## [1.0.1](https://github.com/dachrisch/devhub/compare/v1.0.0...v1.0.1) (2026-08-30)


### Bug Fixes

* correct Dockerfile native module overlay and add public dir ([0080f71](https://github.com/dachrisch/devhub/commit/0080f71faf2cdb8f716ca61a155f2efacf90fb2a))

## 1.0.0 (2026-08-30)


### Features

* filter bot issues, friendlier UI, live recap, and GitHub state mirroring ([f5deee4](https://github.com/dachrisch/devhub/commit/f5deee43d00808cb63d048c98f7585ae23111e75))
* GitHub OAuth login replacing static PATs ([81f401a](https://github.com/dachrisch/devhub/commit/81f401af8d86b4db2230cda7decd2eceaf85cf38))
* implement DevHub development command board ([745b56b](https://github.com/dachrisch/devhub/commit/745b56b77a010da9af365234c315dfdbbbc089ac))


### Bug Fixes

* opencode develop prompt and poll robustness ([191ddd6](https://github.com/dachrisch/devhub/commit/191ddd67c51538e5692b5fd89ea4a056f8eaea33))
