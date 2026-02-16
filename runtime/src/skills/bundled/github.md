---
name: github
description: Git and GitHub CLI operations — PRs, issues, branches, releases, and code review
version: 1.0.0
metadata:
  agenc:
    emoji: "🐙"
    primaryEnv: node
    requires:
      binaries:
        - git
        - gh
      os:
        - linux
        - macos
    tags:
      - git
      - github
      - version-control
      - pull-requests
      - issues
---

# Git & GitHub CLI Operations

Git version control and GitHub operations via `git` and `gh` CLI.

## Branch Management

```bash
# Create and switch to a new branch
git checkout -b feature/my-feature

# Push branch to remote
git push -u origin feature/my-feature

# Rebase onto latest main
git fetch origin && git rebase origin/main

# Delete a merged branch
git branch -d feature/my-feature
git push origin --delete feature/my-feature
```

## Pull Requests

### Create a PR

```bash
gh pr create --title "Add feature X" --body "## Summary
- Added X
- Updated Y

## Test plan
- [ ] Unit tests pass
- [ ] Manual testing done"
```

### Review PRs

```bash
# List open PRs
gh pr list

# View PR details
gh pr view 123

# Check PR diff
gh pr diff 123

# View PR comments
gh api repos/OWNER/REPO/pulls/123/comments

# Approve a PR
gh pr review 123 --approve

# Request changes
gh pr review 123 --request-changes --body "Please fix X"
```

### Merge a PR

```bash
gh pr merge 123 --squash --delete-branch
```

## Issues

```bash
# Create an issue
gh issue create --title "Bug: X" --body "Steps to reproduce..."

# List issues
gh issue list --state open --label bug

# Close an issue
gh issue close 123 --comment "Fixed in #456"

# View issue details
gh issue view 123
```

## Releases

```bash
# Create a release
gh release create v1.0.0 --title "v1.0.0" --notes "Release notes here"

# List releases
gh release list

# Download release assets
gh release download v1.0.0
```

## Git Operations

### Staging and Committing

```bash
# Stage specific files
git add src/file.ts tests/file.test.ts

# Commit with descriptive message
git commit -m "feat: add feature X for Y"

# Amend the last commit
git commit --amend
```

### Stashing

```bash
git stash push -m "wip: feature X"
git stash list
git stash pop
```

### Viewing History

```bash
git log --oneline -20
git diff HEAD~1
git blame src/file.ts
```

## Common Pitfalls

- Never force-push to main/master without team agreement
- Always fetch before rebasing to avoid stale conflicts
- Use `--squash` merge for clean history on feature branches
- Check `gh auth status` if commands fail with authentication errors
- Use specific file paths with `git add` instead of `git add .` to avoid committing secrets
