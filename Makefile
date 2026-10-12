# Local workflow. `make dev` is the one-command path: fetch, then serve.
#   make dev QUICK=1   fetch only the runs the latest run is compared against
# The pipeline writes each product to data/<product>/ (data/gfs/), the same
# layout as the R2 bucket; the dev server serves data/ at /data/.

UPDATE_FLAGS := $(if $(QUICK),--quick,)

# The small dataset CI runs the browser tests on: for every product, a pinned
# cycle and its lag runs, F000-F060. The sources keep their archives (NOAA on
# AWS since 2021, ECMWF on Google Cloud since 2025), so it's reproducible.
E2E_DATA ?= $(CURDIR)/e2e-data
E2E_CYCLE := 2026100900
E2E_HOURS := 0-60
E2E_PRODUCTS := gfs ecmwf aifs

.PHONY: help setup data dev test test-py test-web e2e e2e-data build verify r2-cors

help:
	@grep -E '^[a-z0-9-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-10s %s\n", $$1, $$2}'

setup: ## Install Python and npm dependencies and Playwright's Chromium
	cd pipeline && uv sync
	cd web && npm ci
	cd web && npx playwright install chromium

PRODUCTS := gfs ecmwf aifs

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

build: ## Build the static site into web/dist (it loads data from VITE_DATA_BASE, not dist/)
	cd web && npm run build

verify: ## Check each product's manifest schema and every frame's size
	cd pipeline && for p in $(PRODUCTS); do uv run wxtrend verify --product $$p || exit 1; done

r2-cors: ## Apply infra/r2-cors.json to the R2 bucket: R2_BUCKET=<name>, after `npx wrangler@4 login`
	@test -n "$(R2_BUCKET)" || { echo "usage: make r2-cors R2_BUCKET=<bucket name>"; exit 2; }
	npx wrangler@4 r2 bucket cors set "$(R2_BUCKET)" --file infra/r2-cors.json
	npx wrangler@4 r2 bucket cors list "$(R2_BUCKET)"
