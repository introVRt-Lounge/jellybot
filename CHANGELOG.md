# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.0.0 (2026-05-25)


### Features

* **ci:** auto-merge ai-safe Cursor agent PRs when ci is green ([#51](https://github.com/introVRt-Lounge/jellybot/issues/51)) ([3282da9](https://github.com/introVRt-Lounge/jellybot/commit/3282da9ff4f296ddb12c2fba673d0b42dfba3886)), closes [#50](https://github.com/introVRt-Lounge/jellybot/issues/50)
* **clip:** ephemeral preview before posting to channel ([#49](https://github.com/introVRt-Lounge/jellybot/issues/49)) ([f7926d3](https://github.com/introVRt-Lounge/jellybot/commit/f7926d322f14722d7979faae832e7887872704ad))
* **clip:** ephemeral preview with Post, Cancel, and Try again ([f7926d3](https://github.com/introVRt-Lounge/jellybot/commit/f7926d322f14722d7979faae832e7887872704ad)), closes [#40](https://github.com/introVRt-Lounge/jellybot/issues/40)
* complete public OSS GitHub baseline (Tiers A-H) ([#15](https://github.com/introVRt-Lounge/jellybot/issues/15)) ([1b69dd8](https://github.com/introVRt-Lounge/jellybot/commit/1b69dd88ce7ebd0e7d381c3517aea23ee93b7c2b))
* marketing docs site, bind-mount subtitle DB, incremental index ([#21](https://github.com/introVRt-Lounge/jellybot/issues/21)) ([5947af7](https://github.com/introVRt-Lounge/jellybot/commit/5947af7f8e8b8ac8a0ac9069d9d0faedec5365de))
* **release:** new announce channel and GitHub feature credits ([#53](https://github.com/introVRt-Lounge/jellybot/issues/53)) ([f0612ad](https://github.com/introVRt-Lounge/jellybot/commit/f0612adad3a4c6ca83e556ae7b91f76cd98e215b)), closes [#52](https://github.com/introVRt-Lounge/jellybot/issues/52)
* **release:** prod pipeline with on_ready announce and jellybot-dev layout ([#33](https://github.com/introVRt-Lounge/jellybot/issues/33)) ([15e5534](https://github.com/introVRt-Lounge/jellybot/commit/15e5534d87aa0ef893168f988e92669229fa0c9d)), closes [#32](https://github.com/introVRt-Lounge/jellybot/issues/32)
* share runtime image across compose profiles ([#18](https://github.com/introVRt-Lounge/jellybot/issues/18)) ([1ebece8](https://github.com/introVRt-Lounge/jellybot/commit/1ebece82615e8ad9e67cb9a3a040b1e692d99522))
* shared runtime image and build-runtime Makefile target ([#19](https://github.com/introVRt-Lounge/jellybot/issues/19)) ([1ebece8](https://github.com/introVRt-Lounge/jellybot/commit/1ebece82615e8ad9e67cb9a3a040b1e692d99522))


### Bug Fixes

* **ci:** checkout repo before label sync ([#42](https://github.com/introVRt-Lounge/jellybot/issues/42)) ([4c81fcc](https://github.com/introVRt-Lounge/jellybot/commit/4c81fcc49f0057fdf7b73c066ae22017c93ce362)), closes [#41](https://github.com/introVRt-Lounge/jellybot/issues/41)
* **ci:** correct gh label guard in Cursor triage ([#48](https://github.com/introVRt-Lounge/jellybot/issues/48)) ([136cff3](https://github.com/introVRt-Lounge/jellybot/commit/136cff3c49e91bbc1838b2b4c18aaa4389d99fa2))
* **ci:** correct gh label guard in Cursor triage workflow ([136cff3](https://github.com/introVRt-Lounge/jellybot/commit/136cff3c49e91bbc1838b2b4c18aaa4389d99fa2))
* **ci:** Cursor issue triage for ai-safe and ai-triage labels ([#45](https://github.com/introVRt-Lounge/jellybot/issues/45)) ([b1f78f0](https://github.com/introVRt-Lounge/jellybot/commit/b1f78f063080e0c70a238728e70455ec30167297))
* **ci:** guard Cursor triage to issue labeled events ([#46](https://github.com/introVRt-Lounge/jellybot/issues/46)) ([9a2f1bc](https://github.com/introVRt-Lounge/jellybot/commit/9a2f1bc518fba1def0f236bcda2a599325730ec3))
* **ci:** guard Cursor triage workflow to issue labeled events only ([9a2f1bc](https://github.com/introVRt-Lounge/jellybot/commit/9a2f1bc518fba1def0f236bcda2a599325730ec3))
* **ci:** inline Cursor triage API call in workflow ([6d46a21](https://github.com/introVRt-Lounge/jellybot/commit/6d46a2138f2efbb8531e6bf1336ebae8168aa4e2))
* **ci:** inline Cursor triage API in workflow ([#47](https://github.com/introVRt-Lounge/jellybot/issues/47)) ([6d46a21](https://github.com/introVRt-Lounge/jellybot/commit/6d46a2138f2efbb8531e6bf1336ebae8168aa4e2))
* **ci:** quote label colors for EndBug label-sync ([#44](https://github.com/introVRt-Lounge/jellybot/issues/44)) ([f15ea61](https://github.com/introVRt-Lounge/jellybot/commit/f15ea61580a5d95cfccd8f9ba958829aa4cc1116)), closes [#43](https://github.com/introVRt-Lounge/jellybot/issues/43)
* **ci:** trigger Cursor triage on ai-safe and ai-triage issues ([b1f78f0](https://github.com/introVRt-Lounge/jellybot/commit/b1f78f063080e0c70a238728e70455ec30167297))
* **clip:** English audio mapping, subtitle burn-in, Cursor triage ([9255917](https://github.com/introVRt-Lounge/jellybot/commit/9255917f48f42fbb6903f0de914c55b93f51be8e)), closes [#35](https://github.com/introVRt-Lounge/jellybot/issues/35) [#36](https://github.com/introVRt-Lounge/jellybot/issues/36) [#37](https://github.com/introVRt-Lounge/jellybot/issues/37)
* **clip:** English audio, subtitle burn-in, radgey-cmd Cursor triage ([#38](https://github.com/introVRt-Lounge/jellybot/issues/38)) ([9255917](https://github.com/introVRt-Lounge/jellybot/commit/9255917f48f42fbb6903f0de914c55b93f51be8e))
* **clip:** prefer English audio on multi-track releases ([#31](https://github.com/introVRt-Lounge/jellybot/issues/31)) ([185cd38](https://github.com/introVRt-Lounge/jellybot/commit/185cd38fb65e7ddbffa50a80d55c259081e119e9))
* **docs:** render homepage banner on GitHub Pages ([#22](https://github.com/introVRt-Lounge/jellybot/issues/22)) ([2bff2f6](https://github.com/introVRt-Lounge/jellybot/commit/2bff2f65040670ba1266d733c7fa4869ff2d8bd1))
* **docs:** render homepage banner via md_in_html ([2bff2f6](https://github.com/introVRt-Lounge/jellybot/commit/2bff2f65040670ba1266d733c7fa4869ff2d8bd1))
* **index:** migrate subtitle FTS from trigram to unicode61 ([054e7b8](https://github.com/introVRt-Lounge/jellybot/commit/054e7b827cdfa6a9589a738c8a9eaf1afc371f6f)), closes [#27](https://github.com/introVRt-Lounge/jellybot/issues/27)
* **index:** unicode61 FTS replaces trigram (smaller subtitle DB) ([#28](https://github.com/introVRt-Lounge/jellybot/issues/28)) ([054e7b8](https://github.com/introVRt-Lounge/jellybot/commit/054e7b827cdfa6a9589a738c8a9eaf1afc371f6f))
* **index:** VACUUM after FTS migration ([#29](https://github.com/introVRt-Lounge/jellybot/issues/29)) ([33255df](https://github.com/introVRt-Lounge/jellybot/commit/33255df123eaebc303b956233fd6cf3119a4a322))
* **index:** VACUUM after FTS tokenizer migration ([33255df](https://github.com/introVRt-Lounge/jellybot/commit/33255df123eaebc303b956233fd6cf3119a4a322))
* use config-file input for EndBug label-sync v2 ([#16](https://github.com/introVRt-Lounge/jellybot/issues/16)) ([48c99ef](https://github.com/introVRt-Lounge/jellybot/commit/48c99ef74c66ee8d4ad64c3b170b3fd6914ac050))

## [Unreleased]

## [1.0.0] - 2026-05-24

### Added

- Public release: Discord `/clip` and `/quote` slash commands for Jellyfin libraries
- Subtitle FTS index and quote search
- Docker runtime with GHCR publishing, health endpoint, and Compose profiles
- CI: tests, gitleaks secret scan, Semgrep OWASP SAST, dependency audit
- Community health files, issue templates, and docs site
