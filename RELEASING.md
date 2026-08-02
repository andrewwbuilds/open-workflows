# Releasing

1. Update the version in `package.json` and run `npm install` so the lockfile is consistent.
2. Run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`.
3. Commit the changes.
4. `npm login` (once per machine) and `npm publish --access public`.
5. Tag the release: `git tag v0.x.y && git push --tags`.
6. Bump the version locally for the next cycle if you want a fresh working tree.