# Changelog

## [0.2.0](https://github.com/andrewkomkov/wherehouse/compare/v0.1.0...v0.2.0) (2026-07-21)


### Features

* add oltp postgres schema with cdc publication ([e89a76b](https://github.com/andrewkomkov/wherehouse/commit/e89a76b86ecb425bd7a72b7e332c54b6128c9d61))
* **agent:** answer site selection with three progressive map layers ([0739aa7](https://github.com/andrewkomkov/wherehouse/commit/0739aa71e8f6ad27499a239172057867ae0dac75))
* **db:** load kontur population so demand is people, not a proxy ([fc5541d](https://github.com/andrewkomkov/wherehouse/commit/fc5541d9c63e17df4fc8c8b988d1a35f57c2b80b))
* **db:** load overture places for berlin, amsterdam and belgrade ([ff629b1](https://github.com/andrewkomkov/wherehouse/commit/ff629b1e07125d05e79191bc1dc29b5f5322d9bc))
* **infra:** add readonly console user for the demo video console beat ([151a6f9](https://github.com/andrewkomkov/wherehouse/commit/151a6f9e05065536a124b2832b1ecd912b1cf372))
* **infra:** add the Overture built-environment demand layer ([49976ee](https://github.com/andrewkomkov/wherehouse/commit/49976ee4e3e353735e37108eec5a5615487f2385))
* **infra:** cut Amsterdam and Belgrade basemaps ([8530229](https://github.com/andrewkomkov/wherehouse/commit/8530229029ca03789b6c5091f7214b2189ef5e42))
* **infra:** cut berlin pmtiles to r2 and serve them from a worker ([e7c0922](https://github.com/andrewkomkov/wherehouse/commit/e7c09221043b98212ba8f0f68dcb78f6c4abc205))
* **infra:** deploy the chat agent to a Trigger.dev prod environment ([bc77f00](https://github.com/andrewkomkov/wherehouse/commit/bc77f0002bfa22c9bd480fb4d0681ee797e8d2d7))
* **infra:** scaffold spider-web (network-expansion) walk catchment ([138b91e](https://github.com/andrewkomkov/wherehouse/commit/138b91e8d8d41a381a2a49dbecf350658f7af159))
* **infra:** serve the app out of ClickHouse behind a Cloudflare Worker (ADR-003) ([9c4ead6](https://github.com/andrewkomkov/wherehouse/commit/9c4ead6c46acac8b8c1201690b36e799152deda8))
* **trigger:** add scheduled Overture-demand refresh task ([3f908fa](https://github.com/andrewkomkov/wherehouse/commit/3f908fa5e6116ee1df69a6dec4ae4b699501ff33))
* **trigger:** extend the scheduled refresh to places, population and districts ([31a59ce](https://github.com/andrewkomkov/wherehouse/commit/31a59ceabc1959a7eebd0cfc752c33b6458991dc))
* **video:** add Amsterdam and Belgrade beat sheets and narration ([0291f12](https://github.com/andrewkomkov/wherehouse/commit/0291f12c2e57b9cc6c356991b22e0116a8adb306))
* **video:** add the demo video production pipeline ([dda3f10](https://github.com/andrewkomkov/wherehouse/commit/dda3f10de0b3f16bd324dad6375ead5d142c3b59))
* **video:** cinematic live-map push into the pick's spider-web during capture ([76ba8fe](https://github.com/andrewkomkov/wherehouse/commit/76ba8fe55009aeed31f4cfea06f6c75fb6ae5f53))
* **video:** city-aware pipeline + per-city build wrapper ([969db53](https://github.com/andrewkomkov/wherehouse/commit/969db531e57f05708475f0fa58873f6aab04d231))
* **video:** consultant demo for amsterdam and belgrade + embed all three in README ([19fcba4](https://github.com/andrewkomkov/wherehouse/commit/19fcba43722f4737e8ec6ea2e368a0b39c6a825a))
* **video:** rewrite demo script and voiceover around the consultant story ([31e371f](https://github.com/andrewkomkov/wherehouse/commit/31e371f45ab822514026f6d7ffea0fe37ab72dba))
* **web:** 3-column dashboard — agent-runs stack, KPI strip, map well ([a454c2a](https://github.com/andrewkomkov/wherehouse/commit/a454c2a49798c0a0a9958a1178b576323e6a9b42))
* **web:** add first-visit landing omnibar with per-city example prompts ([2099cce](https://github.com/andrewkomkov/wherehouse/commit/2099cce7b7c0288ff48d136120dbdb3ac4469002))
* **web:** add the built-capacity map layer from the cell_capacity MV ([0d22fb6](https://github.com/andrewkomkov/wherehouse/commit/0d22fb6b5bbe816aec614a9af0218312df1480b5))
* **web:** bloom the spider-web catchment outward by walk-time ([3e8a017](https://github.com/andrewkomkov/wherehouse/commit/3e8a0179afa3d95c0514c144ee711287488c2948))
* **web:** click a top-pick pin to draw its spider-web, to compare picks' reach ([e9e7379](https://github.com/andrewkomkov/wherehouse/commit/e9e73796f2c9824d9cac7731adc34bbf3e8ad62e))
* **web:** complementary-business affinity as an editorial neighbourhood signal ([ae04ca8](https://github.com/andrewkomkov/wherehouse/commit/ae04ca87c569e2a13fd47fb9a4a5c1ca243b8862))
* **web:** consultant ranking variety — lenses, worst mode, district, six pins ([bf62b8f](https://github.com/andrewkomkov/wherehouse/commit/bf62b8f52e34520de788b33ca1331568992da754))
* **web:** curate queryable trades to those that shine in all three cities ([12144d4](https://github.com/andrewkomkov/wherehouse/commit/12144d41f8b949f36e61a9386ddf93af940e0e88))
* **web:** draw the walk catchment as the spider-web street network ([2585311](https://github.com/andrewkomkov/wherehouse/commit/258531185cbe29e3a70948c7cbf7c73ac7642ab8))
* **web:** fold built-environment demand into the GAP score ([25e6100](https://github.com/andrewkomkov/wherehouse/commit/25e6100e44dc66dbf083c5ef720dc9cb60baeb7d))
* **web:** historical momentum — is this market rising, flat, or saturating? ([6d58ad5](https://github.com/andrewkomkov/wherehouse/commit/6d58ad5222b5b2b58b296c24b600db880f9efd61))
* **web:** market-at-a-glance dashboard strip framing the map ([d60a59a](https://github.com/andrewkomkov/wherehouse/commit/d60a59a30bdb86084bccb33775bfa31063791822))
* **web:** name the districts, port the design, precompute walk catchments ([269fb9b](https://github.com/andrewkomkov/wherehouse/commit/269fb9b311e8aae09a96deeea0e0e03038cb1515))
* **web:** read saved sites from ClickHouse via CDC, not Postgres direct ([823fdbe](https://github.com/andrewkomkov/wherehouse/commit/823fdbe1f286b571b2542e190d2a2b77e8d4ff54))
* **web:** saved-site history — your sites vs the market (OLTP+OLAP) ([eec3c27](https://github.com/andrewkomkov/wherehouse/commit/eec3c2787fa8f73aba6ff909265e2278e1cd3da0))
* **web:** the agent operates the whole UI, and exports a PDF report ([68b0514](https://github.com/andrewkomkov/wherehouse/commit/68b0514ba265d97037b508d31a8823d7b98693b6))
* **web:** vendor map glyphs and sprites into ClickHouse — zero external hosts ([f7f1036](https://github.com/andrewkomkov/wherehouse/commit/f7f10367c427611c966f96d39b3a04349e937bb6))
* **web:** walk catchment layer and accessibility as a third factor ([a18f62f](https://github.com/andrewkomkov/wherehouse/commit/a18f62f7823a3e2ca0a20c595421705a3a34d5ad))
* **web:** walking skeleton proving chat.agent() drives the map ([7c61a2c](https://github.com/andrewkomkov/wherehouse/commit/7c61a2cf0ed6ad0eec80e05f901bc001c8c79732))
* **web:** wire our own protomaps basemap into the skeleton ([5937827](https://github.com/andrewkomkov/wherehouse/commit/593782709683757bbfe4b26ac625e3851ac5a597))


### Bug Fixes

* **docs:** use clickable poster links for the demo videos ([708a00f](https://github.com/andrewkomkov/wherehouse/commit/708a00f8291ab6f230d806c50132f223c6ca71f4))
* **infra:** make the spider-web expansion batch load and verify against real data ([bd48043](https://github.com/andrewkomkov/wherehouse/commit/bd48043fbfb371b56387b2edaec58a37e6887b0c))
* **infra:** stop check-env false-flagging a healthy system ([60e0081](https://github.com/andrewkomkov/wherehouse/commit/60e008107baf9fb8a5b9e874d8571cd5341120af))
* **specs:** correct district names we invented the same way the agent did ([308e2c8](https://github.com/andrewkomkov/wherehouse/commit/308e2c894ebd8960e9095bf41235b026e92545e2))
* **trigger:** close idle chat sessions after 5 min, not the ~1h default ([ceb0117](https://github.com/andrewkomkov/wherehouse/commit/ceb0117e0ef6ee13077c026b3f1fe89522a57a25))
* **video:** frame the pick's spider-web via querySourceFeatures, not src._data ([a795340](https://github.com/andrewkomkov/wherehouse/commit/a795340f457adbccb442cd051c0305df49a129a6))
* **video:** rebalance VO to a uniform words-per-second + REMIX mode ([31a6130](https://github.com/andrewkomkov/wherehouse/commit/31a613094af214a93e9bf5a33ee334957a41a486))
* **video:** shorten amsterdam compare line to fit its short 7s window ([23d16a0](https://github.com/andrewkomkov/wherehouse/commit/23d16a07b3321cdb2e46fe996b9af3802bd6d021))
* **video:** stop a saved pick and a slow load from bloating capture timings ([bba1ef5](https://github.com/andrewkomkov/wherehouse/commit/bba1ef51eeb77bbf1d9e091e732cc12dbac77aed))
* **web:** point the basemap at the answer's city, not always Berlin ([42e432e](https://github.com/andrewkomkov/wherehouse/commit/42e432eecb0560d1a6e1666d3db40f54ec240ce5))
* **web:** resolve code-review findings in the chat/map and saved-sites paths ([cc38077](https://github.com/andrewkomkov/wherehouse/commit/cc38077abc7f6b5cdbd20c53c612a4e3d5d22c1b))
* **web:** stop the docked composer input overflowing under the send button ([a880f61](https://github.com/andrewkomkov/wherehouse/commit/a880f61e85f3285366b186d8f47de16d4778da25))
* **web:** track the vendored map glyphs (were caught by *.pbf ignore) ([9f020aa](https://github.com/andrewkomkov/wherehouse/commit/9f020aa14ebe20c1f80933af98cf0f59e60d98ac))


### Documentation

* add ADR-001 on progressive map streaming via chat.agent data parts ([35c0ffb](https://github.com/andrewkomkov/wherehouse/commit/35c0ffbeb772303a2a38adab8266fa05f6603dad))
* add ADR-002 on overture maps as verified poi source ([8d895ce](https://github.com/andrewkomkov/wherehouse/commit/8d895cee8f975955a061e59736f09587dd184baf))
* add day-by-day implementation plan with cuts and risk register ([7893882](https://github.com/andrewkomkov/wherehouse/commit/7893882be667887713fe397c91bc440b1636cd9e))
* add designer brief with stack context and animation spec ([71a84d9](https://github.com/andrewkomkov/wherehouse/commit/71a84d9086c290713137230a34c12ce721f7ad36))
* add research digest, adr-003 on clickhouse as webserver, claude.md and readme ([4250963](https://github.com/andrewkomkov/wherehouse/commit/4250963840b86a6c72311c927226c15284bba43f))
* bring valhalla batch on cf containers back into scope ([91eb326](https://github.com/andrewkomkov/wherehouse/commit/91eb326b6522245eb05a52dfb3d0ef69df9e2b08))
* confirm trigger.dev provides no llm — we bring anthropic key ([b211038](https://github.com/andrewkomkov/wherehouse/commit/b211038b7bd419edbfb912a01daf2640724fbe77))
* **constitution:** add principle VII — work through agents, reproducible from a script ([197c8c1](https://github.com/andrewkomkov/wherehouse/commit/197c8c1289e5278e72741407c40797711278f47b))
* **constitution:** extend principle II to our own prose ([95d8acd](https://github.com/andrewkomkov/wherehouse/commit/95d8acd0173cfd71ec94f0198d6f83e8051afc20))
* correct overture places license attribution ([a133ff2](https://github.com/andrewkomkov/wherehouse/commit/a133ff2eb3ff52812256be0b37107bffb0937214))
* de-stale the rankSites validation example ([8c2145b](https://github.com/andrewkomkov/wherehouse/commit/8c2145b11f4e2b2de0f2532a22bc2e925673114f))
* **design:** round-2 brief — dashboard, momentum, agentic conversation ([c52a721](https://github.com/andrewkomkov/wherehouse/commit/c52a7211e07f6ca6bfae501952e7991604904286))
* document infra-as-code track, ci gates and release-please ([3992939](https://github.com/andrewkomkov/wherehouse/commit/3992939d2637a90ed0d5a37f31a9ae629f49efe6))
* document the video pipeline, agents/skills and the curated trade set ([8c1be9f](https://github.com/andrewkomkov/wherehouse/commit/8c1be9f4549fb705d1669017866c9dc1f2273e29))
* **plan:** add researched feature backlog F2-F5 ([a38eb01](https://github.com/andrewkomkov/wherehouse/commit/a38eb01737fbe730ab10a38e45167288196bfed7))
* **plan:** mark F1-F5 shipped, browser-verified, and CI-green ([644e2f2](https://github.com/andrewkomkov/wherehouse/commit/644e2f2c49c8c6e979e6ee2375f3d433e37d3f9c))
* **plan:** record how the isochrone check failed, and how it didn't ([ad300e5](https://github.com/andrewkomkov/wherehouse/commit/ad300e5d9af604d12bb800c091865a8a1afa2eeb))
* **plan:** stop pacing against a schedule we already outran ([07ed4cc](https://github.com/andrewkomkov/wherehouse/commit/07ed4cc0316e5edff9d08506c35d9a82e467fb47))
* point the demo stills at the youtube uploads ([25732af](https://github.com/andrewkomkov/wherehouse/commit/25732af937f445542be760dd8b05506a77a2b100))
* record adr-001 as proven and the 1 mib stream cap that broke it ([99c760d](https://github.com/andrewkomkov/wherehouse/commit/99c760d5685143a4de8affae3f68603c12cfc26f))
* record cdc slot failure and resync fix in adr-004 ([3d105fa](https://github.com/andrewkomkov/wherehouse/commit/3d105fafcab172b02672cd7974cb5d915e414a63))
* record decision to cut runtime valhalla, snap clicks to h3 instead ([0397324](https://github.com/andrewkomkov/wherehouse/commit/039732487c9dc23f47b6cdc391d3f61b6e330aab))
* refresh CLAUDE.md, README and plan for shipped feature 007 ([93a1650](https://github.com/andrewkomkov/wherehouse/commit/93a165034d0efb7cfc5f076b359a8b0859043cd6))
* refresh two stale "verified" numbers flagged by a live validation pass ([c285ac1](https://github.com/andrewkomkov/wherehouse/commit/c285ac1216264524d54dcab313de8a9812ec1ae4))
* replace valhalla estimates with measured numbers ([0ab60f8](https://github.com/andrewkomkov/wherehouse/commit/0ab60f855f629dc13c78c5763b0fcb2973375c28))
* **specs:** spec the site-selection answer flow ([1896c94](https://github.com/andrewkomkov/wherehouse/commit/1896c9443e32ed0c403410b2653b87942d1e92d5))
* **video:** adapt scenario + skill for the spider-web and the live-map push-in ([ca2e7e1](https://github.com/andrewkomkov/wherehouse/commit/ca2e7e175a6d1b3b23580003f1e481ac9479d84e))
* **video:** describe the walk catchment as the spider-web street network ([1d8612a](https://github.com/andrewkomkov/wherehouse/commit/1d8612adf3d46c7492ea4e934b70f1c324c04ca7))


### Refactoring

* **infra:** move the basemap to wherehouse.slim-shaggy.com ([92053d5](https://github.com/andrewkomkov/wherehouse/commit/92053d565e487328664c0def92d89f0534fd8d4b))
* **infra:** serve the basemap from basemap.slim-shaggy.com ([b5b1a81](https://github.com/andrewkomkov/wherehouse/commit/b5b1a81975615289dd7017a6479fb04ab74e081a))


### Build & Infrastructure

* add check-env script verifying every credential against live services ([005fa1f](https://github.com/andrewkomkov/wherehouse/commit/005fa1fdef31b23700b60bbbaa3fcb23ec4f3285))
* add infra-as-code scripts, secret scanning, and release-please ([654a381](https://github.com/andrewkomkov/wherehouse/commit/654a381315cd631b2d4bbca3d8bb991fc52a125c))
* adopt spec-kit and ratify project constitution ([a58ad67](https://github.com/andrewkomkov/wherehouse/commit/a58ad6782dd8652909ef55a5dad6bb1c24a91e48))
* wire deepseek-v4-flash via anthropic-compatible endpoint ([f59750f](https://github.com/andrewkomkov/wherehouse/commit/f59750f51f0674c2971581e67ad0451e1720be39))
