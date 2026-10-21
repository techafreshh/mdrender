# mdrender

A Markdown-to-HTML rendering service, grown issue-by-issue by the
pi-dark-factory. Single plain-Node process, zero runtime dependencies.

## What it does

`POST /render` accepts Markdown and returns HTML for a small, precisely
specified subset (headings, emphasis, inline code, links, lists, fenced
code blocks), with **everything else HTML-escaped** — untrusted input can
never yield executable markup.

## Documents

- [`PRD.md`](./PRD.md) — the product document: background, the exact render
  contract (golden input→output pairs), non-goals, and the delivery
  requirements (CI workflow + docker-compose worker shipped by the factory).

## Operating model

Built autonomously: issues come from slicing `PRD.md`; every issue is
implemented, verified black-box (runtime + adversarial holdout scenarios),
reviewed, and squash-merged. The verifier's probe contract lives outside
this repo by design.
