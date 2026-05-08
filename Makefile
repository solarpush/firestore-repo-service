.PHONY: publish deploy-docs beta deploy


deploy-docs:  ## Deploy documentation to MinIO
	bun run build:docs
	mc cp -r docs/static/.vitepress/dist/ neo/lpdjs/frs/

publish: deploy-docs  ## Publish package to npm
	npm publish
beta:
	@VERSION=$$(npm version prerelease --preid=beta --no-git-tag-version | tr -d 'v') && \
	npm pkg set --prefix test/functions dependencies["@lpdjs/firestore-repo-service"]=$$VERSION && \
	npm publish --tag beta --access public
deploy:
	bun run deploy
