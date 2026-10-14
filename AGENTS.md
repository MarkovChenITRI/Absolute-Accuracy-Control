# Repository guidance

## Issue tracker

Issues and specifications are tracked as local Markdown under `.scratch/<feature>/`. Each issue file states the outcome, the acceptance checks, and the triage role.

## Domain glossary

This repository uses a single-context domain glossary. Read `CONTEXT.md` before changing domain behaviour, and use its canonical terms in code, tests, and specifications.

## Local-only directories

`docs/` and `data/` are excluded from version control. They hold field documents and tuning data (per-axis MR Configurator2 projects, experiment records, parameter and sampling files) that exist only on the engineering machine. The layout of `data/` is specified in `.scratch/data-layout/spec.md`.
