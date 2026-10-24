# EDL pipeline

The data pipeline behind Nexus Screener. It builds the daily and weekly market snapshots that the
frontend publishes, validates every stage, and stops publication when a required stage fails.

Run the checks with:

```bash
python -m unittest discover -s tests -v
```
