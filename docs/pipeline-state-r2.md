# Pipeline state in R2

The refresh pipeline carries 27 files from one run to the next: ledgers, archives and inputs to the build
and publish phases (for example `all_stocks_fundamental_analysis.json.gz`,
`market_breadth_contributions_v2.json.gz` and `quarterly_financial_history.json.gz`). They used to be committed by
every refresh. Git keeps every version, so they added about 41 MiB to repository history per refresh.

They now live in the private `pipeline-state/` prefix of the `nexus-screener-chart-data` bucket. The list is
`FILES` in [`tools/pipeline_state.py`](../tools/pipeline_state.py).

| Step | Workflow | What happens |
|---|---|---|
| `Pull pipeline state from R2` | daily, weekly, backfill | Overwrites the checkout's copies with the R2 ones, before fetching. |
| `Push pipeline state to R2` | daily, weekly | After a successful build, copies each current object to `pipeline-state/previous/`, uploads the new file, and verifies it by reading it back. A failure stops the run before anything is committed. |
| `Commit and Push Results` | daily, weekly | No longer stages these files. |

**Rollback:** `pipeline-state/previous/<file>` holds the version before the latest run. Copy it back over
`pipeline-state/<file>` to undo one bad run.

**Not public:** the data Worker only serves `objects/`, `releases/`, `daily/`, `monthly/` and `snapshots/`.

**Bootstrap:** the files stay tracked in Git, frozen at their last committed version. The first run after
this change finds nothing in R2, uses those copies, and pushes its results. From then on R2 is
authoritative. Local runs use the frozen Git copies unless you pull with R2 credentials set:

```bash
python tools/pipeline_state.py pull
```

**Follow-up:** once a few refreshes have run from R2, remove the frozen copies from Git (`git rm --cached` plus
`.gitignore`). Freezing them already stops history growth. Removing them only tidies the checkout.
