.PHONY: publish deploy-docs beta deploy


deploy-docs:  ## Deploy documentation to MinIO
	bun run build:docs
	mc cp -r docs/static/.vitepress/dist/ neo/lpdjs/frs/

publish: deploy-docs  ## Publish stable release to npm (promotes current beta to stable)
	@VERSION=$$(node -p "require('./package.json').version.replace(/-.*/, '')") && \
	npm version $$VERSION --no-git-tag-version && \
	npm pkg set --prefix test/functions dependencies["@lpdjs/firestore-repo-service"]=$$VERSION && \
	npm publish --access public
beta:
	@VERSION=$$(npm version prerelease --preid=beta --no-git-tag-version | tr -d 'v') && \
	npm pkg set --prefix test/functions dependencies["@lpdjs/firestore-repo-service"]=$$VERSION && \
	npm publish --tag beta --access public
deploy:
	bun run deploy
