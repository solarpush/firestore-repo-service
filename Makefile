.PHONY: deploy

deploy:
	npm publish
	mc cp -r docs/static/.vitepress/dist/ neo/lpdjs/frs/