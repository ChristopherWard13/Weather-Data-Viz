# Local workflow. `make dev` is the one-command path: fetch, then serve.
#   make dev QUICK=1   fetch only the runs the latest run is compared against
# The pipeline writes each product to data/<product>/ (data/gfs/), the same
# layout as the R2 bucket; the dev server serves data/ at /data/.

UPDATE_FLAGS := $(if $(QUICK),--quick,)

# The small dataset CI runs the browser tests on: a pinned GFS cycle (NOAA keeps
# it on AWS, so it's reproducible) and its lag runs, F000-F060.
E2E_DATA ?= $(CURDIR)/e2e-data
E2E_CYCLE := 2026100900
E2E_HOURS := 0-60

.PHONY: help setup data dev test test-py test-web e2e e2e-data build verify r2-cors

help:
	@grep -E '^[a-z0-9-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-10s %s\n", $$1, $$2}'

setup: ## Install Python and npm dependencies and Playwright's Chromium
	cd pipeline && uv sync
	cd web && npm ci
	cd web && npx playwright install chromium

data: ## Process the latest complete GFS cycle and its retention window into data/gfs/
	cd pipeline && uv run wxtrend update $(UPDATE_FLAGS)

dev: ## Fetch the latest runs, then serve the site at http://localhost:5173
	cd pipeline && (uv run wxtrend update $(UPDATE_FLAGS) || test -f ../data/gfs/manifest.json)
	cd web && npm run dev

test: test-py test-web ## Run all unit tests

test-py:
	cd pipeline && uv run pytest

test-web:
	cd web && npm test

e2e: ## Headless browser tests against the production build and data/ (WXTREND_DATA_DIR=<abs path to e2e-data> for the CI dataset)
	cd web && npx playwright test

e2e-data: ## Build the CI e2e dataset (5 GFS runs, F000-F060) into e2e-data/
	cd pipeline && uv run wxtrend --data-dir $(E2E_DATA) update --product gfs --cycle $(E2E_CYCLE) --quick --hours $(E2E_HOURS)

build: ## Build the static site into web/dist (it loads data from VITE_DATA_BASE, not dist/)
	cd web && npm run build

verify: ## Check the manifest schema and every frame's size
	cd pipeline && uv run wxtrend verify

r2-cors: ## Apply infra/r2-cors.json to the R2 bucket: R2_BUCKET=<name>, after `npx wrangler@4 login`
	@test -n "$(R2_BUCKET)" || { echo "usage: make r2-cors R2_BUCKET=<bucket name>"; exit 2; }
	npx wrangler@4 r2 bucket cors set "$(R2_BUCKET)" --file infra/r2-cors.json
	npx wrangler@4 r2 bucket cors list "$(R2_BUCKET)"
