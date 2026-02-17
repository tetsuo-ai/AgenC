---
name: github
description: Git and GitHub CLI operations for repository management, PRs, and issues
version: 1.0.0
metadata:
  agenc:
    requires:
      binaries:
        - gh
        - git
    install:
      - type: brew
        package: gh
      - type: apt
        package: gh
    tags:
      - github
      - git
      - devops
---
# GitHub Operations

Git and GitHub CLI workflows for pull requests, issues, branches, and releases.

## Pull Requests

### Create a PR

```bash
gh pr create --title "Add feature X" --body "Description of changes"
gh pr create --title "Fix bug" --body "Root cause and fix" --base main
```

### List and View PRs

```bash
gh pr list
gh pr list --state open --author @me
gh pr view <PR_NUMBER>
gh pr diff <PR_NUMBER>
```

### Merge a PR

```bash
gh pr merge <PR_NUMBER> --squash
gh pr merge <PR_NUMBER> --rebase --delete-branch
```

## Issues

### Create an Issue

```bash
gh issue create --title "Bug report" --body "Steps to reproduce"
gh issue create --title "Feature request" --label enhancement
```

### List and View Issues

```bash
gh issue list
gh issue list --label bug --state open
gh issue view <ISSUE_NUMBER>
```

## Branches

```bash
git checkout -b feature/my-feature
git push -u origin feature/my-feature
git branch -d feature/merged-branch
```

## Releases

```bash
gh release create v1.0.0 --title "v1.0.0" --notes "Release notes"
gh release list
gh release download v1.0.0
```

## Repository Info

```bash
gh repo view
gh repo clone <OWNER>/<REPO>
gh api repos/<OWNER>/<REPO>
```
