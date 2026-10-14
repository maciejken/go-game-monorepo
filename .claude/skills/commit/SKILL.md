---
name: commit
description: Commit but do not push. Use when the user asks to commit changes.
---

# Commit Changes

This skill is for committing changes to the local git repository without pushing them to the remote. Use this when you want to save your work but are not ready to deploy or share it yet. Never commit a change before being asked to do so. When committing, always use a short message describing what actually changed, prefixed by the appropriate conventional-commit type (`feat:` for a new feature, `fix:` for a bug fix, etc. — ask if it's ambiguous). End the message with:
```
Co-Authored-By: Claude {name of the model} <noreply@anthropic.com>