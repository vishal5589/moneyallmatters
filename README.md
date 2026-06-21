# moneyallmatters

> A self-hosted household finance portal running entirely on Cloudflare's edge — built to track shared expenses, loans, and payment schedules for a two-person household.

**Stack:** Cloudflare Workers · Cloudflare D1 · Cloudflare Access · React 18 (CDN) · Recharts

**Status:** Live (access-gated via Cloudflare Access). Screenshots below; happy to give a guided walkthrough.

<img width="1683" height="957" alt="image" src="https://github.com/user-attachments/assets/d6274c9e-0c10-40dd-b834-7dcad78f37cf" />

<img width="1688" height="957" alt="image" src="https://github.com/user-attachments/assets/6a567caf-688d-4fb6-98cd-8f8f3838807b" />

---

## Overview

moneyallmatters is a personal project I built to replace the spreadsheet my partner and I used to split household costs. It tracks shared expenses on a configurable contribution split, monitors household loans with proper amortization, and surfaces an at-a-glance payment timeline so nothing slips.

It runs as a **single Cloudflare Worker** — no servers, no containers, no build pipeline. The Worker serves the React frontend and a JSON API backed by a SQLite database at the edge (Cloudflare D1). I designed it deliberately around one constraint: I deploy by pasting a single file into the Cloudflare dashboard, with no local toolchain. That constraint shaped most of the architecture, and I think the result is a good case study in building something real under real limits.

## Features

- **Shared expense tracking** with a configurable contribution split between two contributors.
- **Household loan tracking** with reducing-balance amortization, scheduled-vs-actual reconciliation, and health badges that flag when a loan drifts from its schedule.
- **Payment timeline** — a unified view of upcoming installments and loan payments, with a calendar companion, running totals, and cycle badges.
- **Privacy mode** — one toggle blurs every monetary value on screen, so the portal is safe to open in public or on a shared screen.
- **Responsive** — tested on desktop and at mobile widths (~390–430px).

## Architecture

```
Browser ──HTTPS──▶ Cloudflare Access (zero-trust gate)
                          │  (only authenticated identities pass)
                          ▼
                 Cloudflare Worker  ── serves React SPA + JSON API
                          │
                          ▼
                   Cloudflare D1 (SQLite at the edge)
```

The entire application is one `worker.js`. It returns the HTML shell + React app for page requests, and handles `/api/*` routes against D1 for data. React and Recharts load from a CDN and JSX is transpiled in-browser with Babel — so there is **zero build step**.

### Why a single file?

This is the design decision most likely to raise an eyebrow, so I'll address it head-on. My deployment surface is the Cloudflare dashboard editor — I paste one file and hit deploy, with no local CLI or build tooling available. A single self-contained Worker is the *correct* shape for that constraint: it's atomically deployable, has no dependency-resolution step that could fail in an environment I can't debug locally, and keeps the whole system in one reviewable artifact.

The honest tradeoff: a 9,500-line single file is harder to navigate and review than a modular codebase, and the in-browser Babel transpile costs first-paint performance. With a build pipeline (see *Roadmap*), I'd split this into modules and ship pre-compiled bundles. I chose to ship a working tool first and treat the refactor as a known, deliberate piece of debt rather than a blind spot.

## Security design

I work in security operations (Blue Team), so I treated this app's design as a small threat-modelling exercise rather than an afterthought. The full data set is two people's personal finances, so the goal was simple: **only the two of us can ever read it, and nothing sensitive lives anywhere it doesn't have to.**

**Authentication — offloaded, not rolled.** Auth is handled entirely by Cloudflare Access (zero-trust), not by application code. There is no login form, password store, or session logic in the app for an attacker to probe — the Worker only ever executes after Access has already authenticated the identity at the edge. This removes the single most common vulnerability class for a project like this (broken auth) by removing the auth surface from the app altogether.

**Data exposure model.** Financial data lives only in Cloudflare D1. It is never embedded in the deployed Worker and never committed to this repository — the code in this repo contains application logic only, no balances, no figures, no personal data. The D1 database is referenced by binding name, not by a connection string or credential, so there is nothing exploitable to leak even if the source is fully public.

**No secrets in source.** The repository carries no API keys, account identifiers, or credentials. Resource identifiers needed for deployment live in deployment config outside the application code, and any true secrets would be injected as Worker secrets rather than committed.

**Privacy in shared spaces.** Beyond access control, a privacy toggle blurs all amounts client-side — a defence against shoulder-surfing when the portal is open on a screen others can see. Security isn't only "who can log in"; it's also "who can read over your shoulder."

**Known tradeoff — supply chain.** React, Recharts, and Babel are loaded from a CDN without Subresource Integrity (SRI) hashes. This prioritises a zero-build workflow over supply-chain hardening: a compromised CDN response would execute in the client. The production-grade fix is pinned SRI hashes or self-hosted, pre-built bundles. I'm flagging it explicitly because pretending it isn't there would be the wrong instinct for a security project — and because seeing the risk while making a deliberate pragmatic call is the point.

## Roadmap

- Move deployment to a Git-backed CI/CD pipeline (Cloudflare Workers Builds) for versioned, reviewable deploys.
- Split the monolith into modules and introduce a build step with pre-compiled, SRI-pinned bundles.
- Snapshot history graph and a refinance simulator.
- Light mode and a motion/animation pass.

## Tech notes

- **Runtime:** Cloudflare Workers (V8 isolates, edge).
- **Data:** Cloudflare D1 (SQLite). Schema includes installments with due-day and last-paid tracking, and snapshot-based loan reconciliation.
- **Frontend:** React 18 + Recharts via CDN, in-browser Babel — no bundler.
- **Auth:** Cloudflare Access / Zero Trust.

---

*Personal project. Not affiliated with any employer. All figures shown in screenshots are illustrative.*
