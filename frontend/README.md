# frontend/

Despite the name, this folder no longer holds a UI. The screener UI lives in Nexus Journal
(`packages/nexus-scanner` in that repository). In production the `nexus-scanner` Worker redirects its pages there
(`UI_REDIRECT`); the local Worker (`wrangler.dev.jsonc`) has no redirect and serves only data and the AI endpoint.

What remains:

| Location | Used by |
| --- | --- |
| `*.py` (`publish_snapshot.py`, `site_data.py`, `publish_etfs.py`, …) and `test_*.py` | The daily and weekly refresh workflows: browser snapshot, site data and R2 publication. |
| `src/data/*.json` | The pipeline (`scanner_bridge.py`, `snapshot_technicals.py`, `publish_snapshot.py`) and the AI Worker. |
| `src/api`, `src/data/*.ts`, `src/types`, `src/utils` | The AI screen compiler in `workers/screener-ai`. Nexus Journal has its own copy; change both together. |
| `src/__tests__` | Tests of the shared catalogue and the Worker. `fixtures/packedSnapshot.json` is also read by `test_packed_snapshot.py`. |
| `public/data/` | Local publications (`EDL_CHART_STORAGE=local`) and the local Worker's data. Production data is in R2. |

Run these from `frontend/`:

```bash
cd frontend
npm install
npm test          # catalogue and Worker tests
npm run typecheck
python3 -m unittest discover -s . -p 'test_*.py' -v
```
