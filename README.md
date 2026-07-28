# Shared DFG Subset Comparison

Research prototype supporting exploratory process mining through Shared
DFG-based comparison of case-level subsets.

The prototype lets analysts construct case-level subsets, retain complete event
traces for matching cases, compute a DFG for each selected subset, and compare
the resulting behavior in one aligned Shared DFG. Stable subset colors,
parallel connection strokes, visibility controls, coverage thresholds, and
detail cards support comparison and visual simplification.

## Thesis Scope

The artifact focuses on:

- case-level subset construction using categorical, numeric, date, and activity
  conditions;
- complete-case and complete-trace filtering;
- subset-specific DFG computation;
- Shared DFG merging by aligned activities and source-target edges;
- subset-aware visual encoding;
- activity and connection visibility controls;
- case-coverage thresholds, ranking, sliders, hiding, and details-on-demand;
- browser-side Graphviz layout and custom SVG rendering.

It is a visual analytics prototype for exploratory process mining. It is not a
new process discovery algorithm or a full process mining platform.

## Architecture

The default runtime is a static React, TypeScript, and Vite frontend. It loads
the prepared CSV files in the browser and directly performs complete-case
filtering, subset-specific DFG computation, Shared DFG merging, and visible
graph derivation. Graphviz is used only as a layout engine. The Shared DFG is
rendered with custom SVG.

Optional Vercel functions provide server-side DFG computation and Graphviz
layout through:

- `POST /api/mine`
- `POST /api/layout`
- `GET /api/health`

These endpoints are optional deployment support. They are not required for the
default browser-side thesis artifact, and the interface falls back to local
computation if server computation is unavailable.

## Data Availability

The repository includes an anonymized, filtered, and transformed logistics
dataset prepared from company operational data for the thesis prototype. It
contains:

- `public/data/attributes.csv`: 6,485 case-level records;
- `public/data/eventlog.csv`: 77,212 timestamped events.

The public event timestamps retain second-level precision after a consistent
confidential date shift. Case identifiers, operator identifiers, and
company-related fields are anonymized or pseudonymized. Direct identifiers and
confidential operational details were removed.

The original operational data is confidential and is not publicly available.
Private mapping files are excluded from this repository. The included data
supports reproduction of the prototype workflow, but it cannot be used to
reconstruct the original confidential source data.

## Run Locally

Requirements:

- Node.js
- pnpm

Install dependencies and start the frontend:

```bash
pnpm install
pnpm dev
```

The development server prints the local URL, normally
`http://127.0.0.1:5173`.

## Verification

Run the frontend tests and production build:

```bash
pnpm test
pnpm build
```

The optional Python backend tests require Python 3.12 and the dependencies in
`requirements.txt`:

```bash
python -m pip install -r requirements.txt
python -m unittest tests/test_backend.py
```

## Optional API Protection

No environment variables are needed for browser-side computation. The optional
Vercel functions can be protected with `PMT_API_TOKEN`. When enabled, the
frontend may send the matching `VITE_PMT_API_TOKEN`.

`VITE_PMT_API_TOKEN` is included in browser JavaScript and must not be treated
as a strong secret for a public deployment.

## License

The source code in this repository is licensed under the MIT License.
