# Security Policy

## Supported versions

The latest version published to npm is the only one that gets fixes.

## Reporting a vulnerability

Please **don't** open a public issue for a security problem.

Use GitHub's [private vulnerability reporting](https://github.com/Booyaka101/runner-drift/security/advisories/new) instead. Expect a first response within a week.

Please include what you found, how to reproduce it, and what an attacker gets out of it.

## What this touches

Reads your workflows and the public runner-images manifests. It changes nothing in your repo unless you ask it to.

- **It reads public runner-image manifests** over HTTPS and your own workflow files from disk. It sends nothing.
- **`runner-drift runners` and `guard --fail-on-deprecation` additionally read your self-hosted runner listing**, which needs a token with administration read (`GITHUB_TOKEN` / `GH_TOKEN`). That token is sent as a bearer header to `api.github.com` and nowhere else, the allowlist in `src/http.mjs` refuses every other host, and it is never written to the lock file, the step summary or the log. Runner names appear in the output, so keep in mind that a public job summary will show them.

## Scope

In scope: anything that leaks a credential, reads data belonging to someone else, or lets untrusted input reach code execution.

Out of scope: findings that require an attacker to already control the machine it runs on.
