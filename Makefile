# Local workflow. `make dev` is the one-command path: fetch, then serve.
#   make dev QUICK=1   fetch only the runs the latest run is compared against

UPDATE_FLAGS := $(if $(QUICK),--quick,)

.PHONY: help setup data dev test test-py test-web e2e build verify

help:
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-10s %s\n", $$1, $$2}'

setup: ## Install Python and npm dependencies and Playwright's Chromium
	cd pipeline && uv sync
	cd web && npm ci
	cd web && npx playwright install chromium

data: ## Process the latest complete GFS cycle and its retention window into data/
	cd pipeline && uv run wxtrend update $(UPDATE_FLAGS)

dev: ## Fetch the latest runs, then serve the site at http://localhost:5173
	cd pipeline && (uv run wxtrend update $(UPDATE_FLAGS) || test -f ../data/manifest.json)
	cd web && npm run dev

test: test-py test-web ## Run all unit tests

test-py:
	cd pipeline && uv run pytest

test-web:
	cd web && npm test

e2e: ## Headless browser tests against the production build and real data
	cd web && npx playwright test

build: ## Build the static site with data into web/dist
	cd web && npm run build && cp -R ../data dist/data

verify: ## Check the manifest schema and every frame's size
	cd pipeline && uv run wxtrend verify
