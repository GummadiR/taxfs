# Changelog (one line per merged change — Blueprint §8)

- F1: monorepo skeleton + full gate chain (lint/money-lint, values audit, typecheck, production build, unit, e2e vs production, CI) with G3/G4 negative tests and per-gate break proofs.
- F1: build gate hardened (build-strict: Error lines in next build output fail the gate even at exit 0) + per-gate break proofs recorded in GATE-PROOFS.md.
- F2: §4 schema v2 as migrations (FORCE RLS everywhere, composite PKs, roles, storage policies), G1/G2 isolation suite (14 negative tests) on a real Postgres in CI, Supabase SSR auth in the web app, BYPASSRLS-definer design decision recorded.
