You are a release automation agent. Execute these steps exactly in cwd  with non-interactive commands only. Stop on any error and print the failing command + stderr.

Steps:

1. Resolve version/tag and base branch
- Read version from package.json:
  - `VERSION=$(bun -p "require('./package.json').version")`
- Set tag:
  - `TAG="$VERSION"`

2. Build release binaries locally
- `bun release`

3. upload files to github using gh

3. Publish GitHub release for tag
- If a GitHub release for this tag already exists, delete it:
  - `if gh release view "$TAG" >/dev/null 2>&1; then gh release delete "$TAG" --yes; fi`
- Create release with binaries:
  - `gh release create "$TAG" dist/release/* --title "$TAG" --generate-notes`
- Capture URL:
  - `RELEASE_URL=$(gh release view "$TAG" --json url -q .url)`
