You are a release automation agent. Execute these steps exactly in cwd  with non-interactive commands only. Stop on any error and print the failing command + stderr.

Goal:
1) Commit all pending changes into a new feature branch
2) Push branch
3) Open PR
4) Merge PR
5) Build release binaries locally
6) Upload binaires and Publish GitHub release
7) Ensure release tag equals `package.json` version
8) If main already has that tag, delete main branch tag first, then recreate/push

Constraints:
- Use branch names prefixed with `feat/`.
- Do not use interactive git flows.
- SUPER IMPORTANT: Do not modify code beyond already-pending changes.

Steps:

2. Resolve version/tag and base branch
- Read version from package.json:
  - `VERSION=$(node -p "require('./package.json').version")`
- Set tag:
  - `TAG="$VERSION"`
- Detect default branch of main:
  - `BASE_BRANCH=$(git remote show main | sed -n '/HEAD branch/s/.*: //p')`
- Fail if `VERSION` or `BASE_BRANCH` is empty.

3. Create feature branch
- `BRANCH="feat/release-${TAG}-$(date +%Y%m%d-%H%M%S)"`
- `git checkout -b "$BRANCH"`

4. Commit pending changes
- `git add -A`
- `git commit -m "release: expand release matrix and installer for multi-platform artifacts"`

5. Push branch
- `git push -u main "$BRANCH"`

6. Create PR
- `PR_URL=$(gh pr create --base "$BASE_BRANCH" --head "$BRANCH" --title "release: multi-platform matrix + installer updates" --body "Automated release prep for version $TAG.")`
- Print `PR_URL`.

7. Merge PR
- `gh pr merge "$BRANCH" --squash --delete-branch`
- `git checkout "$BASE_BRANCH"`
- `git pull --ff-only main "$BASE_BRANCH"`

8. Handle tag collisions (main + local)
- If main tag exists, delete it:
  - `if git ls-remote --exit-code --tags main "refs/tags/$TAG" >/dev/null 2>&1; then git push main ":refs/tags/$TAG"; fi`
- If local tag exists, delete it:
  - `if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then git tag -d "$TAG"; fi`
- Recreate tag at current HEAD:
  - `git tag -a "$TAG" -m "Release $TAG"`
- Push tag:
  - `git push main "$TAG"`

9. Build release binaries locally
- `bun install`
- `bash scripts/release.sh`
- Verify expected files exist:
  - `dist/release/cook-darwin-arm64`
  - `dist/release/cook-darwin-x64`
  - `dist/release/cook-linux-x64`
  - `dist/release/cook-linux-x64-musl`
  - `dist/release/cook-linux-arm64`
  - `dist/release/cook-windows-x64.exe`
- Run:
  - `ls -lh dist/release`
  - `file dist/release/*`

10. Publish GitHub release for tag
- If a GitHub release for this tag already exists, delete it:
  - `if gh release view "$TAG" >/dev/null 2>&1; then gh release delete "$TAG" --yes; fi`
- Create release with binaries:
  - `gh release create "$TAG" dist/release/* --title "$TAG" --generate-notes`
- Capture URL:
  - `RELEASE_URL=$(gh release view "$TAG" --json url -q .url)`

11. Final report (print clearly)
- Branch name
- Commit SHA merged
- PR URL
- Tag name
- Release URL
- Output of `git status --short` (should be clean except allowed local artifacts)
