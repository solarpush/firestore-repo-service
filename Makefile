.PHONY: publish deploy-docs


deploy-docs:  ## Deploy documentation to MinIO
	bun run build:docs
	mc cp -r docs/static/.vitepress/dist/ neo/lpdjs/frs/

publish: deploy-docs  ## Publish package to npm
	npm publish