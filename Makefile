# Local workflow. `make dev` is the one-command path: fetch, then serve.
#   make dev QUICK=1   fetch only the runs the latest run is compared against
# The pipeline writes each product to data/<product>/ (data/gfs/), the same
# layout as the R2 bucket; the dev server serves data/ at /data/.

UPDATE_FLAGS := $(if $(QUICK),--quick,)

# The small dataset CI runs the browser tests on: for every product, a pinned
# cycle and its lag runs, F000-F060. The archived sources keep their files (NOAA
# on AWS since 2017-21, ECMWF on Google Cloud since 2025), so those products are
# rebuilt from source each time.
E2E_DATA ?= $(CURDIR)/e2e-data
E2E_CYCLE := 2026101200
E2E_HOURS := 0-60
E2E_PRODUCTS := gfs ecmwf aifs gefs

# NOMADS keeps AIGFS about 11 days and AIGEFS/HGEFS 2, so a pinned cycle can't
# be rebuilt from source. The ECMWF ENS mean can, but reads about 300 MB of
# members an hour (some 13 GB for its pinned runs). Their e2e data is a frozen
# bundle (E2E_CYCLE and the run 12 h before it, F000-F060; `make e2e-fixtures`
# builds it) attached to a GitHub release and pinned by SHA-256 here. `e2e-data`
# checks it against config/ with `wxtrend verify` and fails if fields, bands or
# hours have changed since: then build a new bundle, publish it under a new tag,
# and update the tag and SHA lines.
E2E_FIXTURE_PRODUCTS := aigfs aigefs hgefs ecmwf-ens
# Every product shares E2E_CYCLE, so switching models in the e2e keeps a valid time all have.
E2E_FIXTURE_RUNS := $(E2E_CYCLE) 2026101112
E2E_FIXTURES_TAG := e2e-fixtures-$(E2E_CYCLE)-v3
E2E_FIXTURES_SHA256 := daa9248aa7594b6ae60a10114c242c4b676600f301b59e16bd120c0d38ad0277
E2E_FIXTURES_URL := https://github.com/ChristopherWard13/Weather-Data-Viz/releases/download/$(E2E_FIXTURES_TAG)/e2e-fixtures.tar.gz
# A local bundle instead of the release (e.g. before it's published): E2E_FIXTURES_FILE=e2e-fixtures.tar.gz
E2E_FIXTURES_FILE ?=
# The products a new bundle fetches from source; the rest are copied from the
# pinned bundle, since their source has dropped the pinned cycles (NOMADS).
# Adding a product: make e2e-fixtures E2E_FIXTURES_FETCH=<id>
E2E_FIXTURES_FETCH ?= $(E2E_FIXTURE_PRODUCTS)
E2E_FIXTURES_KEEP = $(filter-out $(E2E_FIXTURES_FETCH),$(E2E_FIXTURE_PRODUCTS))

.PHONY: help setup data dev test test-py test-web e2e e2e-data e2e-fixtures build verify r2-cors

help:
	@grep -E '^[a-z0-9-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-13s %s\n", $$1, $$2}'

setup: ## Install Python and npm dependencies and Playwright's Chromium
	cd pipeline && uv sync
	cd web && npm ci
	cd web && npx playwright install chromium

# NOMADS products (aigfs, aigefs, hgefs) are paced to 60 requests a minute, so
# their first full backfill takes 20-40 minutes each; `make dev QUICK=1` is faster.
# The ECMWF ENS mean averages 50 members, about 300 MB of downloads an hour (some
# 90 GB for its window, 70 with QUICK=1), so it's opt-in: PRODUCTS="... ecmwf-ens".
PRODUCTS ?= gfs ecmwf aifs aigfs gefs aigefs hgefs

data: ## Process each product's latest complete cycle and retention window into data/<product>/
	cd pipeline && for p in $(PRODUCTS); do uv run wxtrend update --product $$p $(UPDATE_FLAGS) || exit 1; done

dev: ## Fetch the latest runs, then serve the site at http://localhost:5173
	cd pipeline && for p in $(PRODUCTS); do uv run wxtrend update --product $$p $(UPDATE_FLAGS) || test -f ../data/$$p/manifest.json || exit 1; done
	cd web && npm run dev

test: test-py test-web ## Run all unit tests

test-py:
	cd pipeline && uv run pytest

test-web:
	cd web && npm test

e2e: ## Headless browser tests against the production build and data/ (WXTREND_DATA_DIR=<abs path to e2e-data> for the CI dataset)
	cd web && npx playwright test

e2e-data: ## Build the CI e2e dataset (each product's pinned cycle and lag runs, F000-F060) into e2e-data/
	cd pipeline && for p in $(E2E_PRODUCTS); do \
	  uv run wxtrend --data-dir $(E2E_DATA) update --product $$p --cycle $(E2E_CYCLE) --quick --hours $(E2E_HOURS) || exit 1; \
	done
	mkdir -p $(E2E_DATA)
	$(if $(E2E_FIXTURES_FILE),cp $(E2E_FIXTURES_FILE),curl -fsSL --retry 3 -o) $(E2E_DATA)/fixtures.tar.gz $(if $(E2E_FIXTURES_FILE),,$(E2E_FIXTURES_URL))
	echo "$(E2E_FIXTURES_SHA256)  $(E2E_DATA)/fixtures.tar.gz" | shasum -a 256 -c -
	tar -xzf $(E2E_DATA)/fixtures.tar.gz -C $(E2E_DATA) && rm $(E2E_DATA)/fixtures.tar.gz
	cd pipeline && for p in $(E2E_FIXTURE_PRODUCTS); do \
	  uv run wxtrend --data-dir $(E2E_DATA) verify --product $$p || { \
	    echo "The $$p e2e fixtures no longer match config/: run make e2e-fixtures and publish a new release (see the Makefile)"; exit 1; }; \
	done

e2e-fixtures: ## Build the frozen e2e bundle (NOMADS products, ECMWF ENS) into e2e-fixtures.tar.gz and print its SHA-256
	rm -rf e2e-fixtures && mkdir -p e2e-fixtures
	$(if $(E2E_FIXTURES_KEEP),$(if $(E2E_FIXTURES_FILE),cp $(E2E_FIXTURES_FILE),curl -fsSL --retry 3 -o) e2e-fixtures/pinned.tar.gz $(if $(E2E_FIXTURES_FILE),,$(E2E_FIXTURES_URL)))
	$(if $(E2E_FIXTURES_KEEP),echo "$(E2E_FIXTURES_SHA256)  e2e-fixtures/pinned.tar.gz" | shasum -a 256 -c -)
	$(if $(E2E_FIXTURES_KEEP),tar -xzf e2e-fixtures/pinned.tar.gz -C e2e-fixtures $(E2E_FIXTURES_KEEP) && rm e2e-fixtures/pinned.tar.gz)
	rm -f e2e-fixtures.tar.gz
	cd pipeline && for p in $(E2E_FIXTURES_FETCH); do for c in $(E2E_FIXTURE_RUNS); do \
	  uv run wxtrend --data-dir $(CURDIR)/e2e-fixtures fetch --product $$p --cycle $$c --hours $(E2E_HOURS) || exit 1; \
	done; done
	cd pipeline && for p in $(E2E_FIXTURE_PRODUCTS); do uv run wxtrend --data-dir $(CURDIR)/e2e-fixtures verify --product $$p || exit 1; done
	tar -czf e2e-fixtures.tar.gz -C e2e-fixtures $(E2E_FIXTURE_PRODUCTS)
	shasum -a 256 e2e-fixtures.tar.gz

build: ## Build the static site into web/dist (it loads data from VITE_DATA_BASE, not dist/)
	cd web && npm run build

verify: ## Check each product's manifest schema and every frame's size
	cd pipeline && for p in $(PRODUCTS); do uv run wxtrend verify --product $$p || exit 1; done

r2-cors: ## Apply infra/r2-cors.json to the R2 bucket: R2_BUCKET=<name>, after `npx wrangler@4 login`
	@test -n "$(R2_BUCKET)" || { echo "usage: make r2-cors R2_BUCKET=<bucket name>"; exit 2; }
	npx wrangler@4 r2 bucket cors set "$(R2_BUCKET)" --file infra/r2-cors.json
	npx wrangler@4 r2 bucket cors list "$(R2_BUCKET)"
