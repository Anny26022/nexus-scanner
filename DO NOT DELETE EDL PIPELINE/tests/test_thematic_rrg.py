import os
import json
import gzip
import unittest

class TestThematicRrg(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
        cls.json_path = os.path.join(cls.repo_root, "frontend", "public", "data", "thematic_rrg.json")
        cls.gz_path = os.path.join(cls.repo_root, "frontend", "public", "data", "thematic_rrg.json.gz")
        
        if not os.path.exists(cls.json_path):
            if os.path.exists(cls.gz_path):
                with gzip.open(cls.gz_path, "rt", encoding="utf-8") as f:
                    cls.data = json.load(f)
            else:
                raise FileNotFoundError(f"Missing {cls.json_path} and {cls.gz_path}")
        else:
            with open(cls.json_path, "r", encoding="utf-8") as f:
                cls.data = json.load(f)

    def test_schema_top_level(self):
        d = self.data
        self.assertEqual(d.get("schemaVersion"), 1)
        self.assertIn("asOfDate", d)
        self.assertEqual(d.get("benchmark"), "NIFTY 500")
        self.assertIsInstance(d.get("benchmark3mReturn"), (int, float))
        self.assertEqual(d.get("trailWeeks"), 12)
        self.assertGreaterEqual(d.get("totalBlocks"), 20)
        self.assertGreaterEqual(d.get("totalNiches"), 100)
        self.assertGreaterEqual(d.get("totalEquities"), 2000)
        self.assertIsInstance(d.get("blocks"), list)
        self.assertIsInstance(d.get("niches"), list)

    def test_quadrant_assignment(self):
        for block in self.data["blocks"]:
            x = block["x"]
            y = block["y"]
            q = block["quadrant"]
            if x >= 0 and y >= 0:
                self.assertEqual(q, "Leading", f"Block {block['name']} with x={x}, y={y} should be Leading")
            elif x >= 0 and y < 0:
                self.assertEqual(q, "Weakening", f"Block {block['name']} with x={x}, y={y} should be Weakening")
            elif x < 0 and y < 0:
                self.assertEqual(q, "Lagging", f"Block {block['name']} with x={x}, y={y} should be Lagging")
            else:
                self.assertEqual(q, "Improving", f"Block {block['name']} with x={x}, y={y} should be Improving")

    def test_trail_points(self):
        for block in self.data["blocks"]:
            trail = block["trail"]
            self.assertEqual(len(trail), 13, f"Block {block['name']} should have 13 trail points (0 to 12)")
            weeks = [pt["week"] for pt in trail]
            self.assertEqual(weeks, list(range(12, -1, -1)), "Weeks should be sequentially 12 down to 0 (oldest to current)")
            # Current point (week 0) should match block (x, y, quadrant)
            w0 = trail[-1]
            self.assertEqual(w0["week"], 0)
            self.assertAlmostEqual(w0["x"], block["x"], places=2)
            self.assertAlmostEqual(w0["y"], block["y"], places=2)
            self.assertEqual(w0["quadrant"], block["quadrant"])

    def test_block_constituents_and_metrics(self):
        for block in self.data["blocks"]:
            metrics = block["metrics"]
            self.assertIn("excessReturn3m", metrics)
            self.assertIn("rsMomentum21d", metrics)
            self.assertIn("medianRs", metrics)
            self.assertIn("beatingBenchmarkPct", metrics)
            self.assertIn("improvingRsPct", metrics)
            self.assertIn("setupCoveragePct", metrics)
            self.assertIn("constituentCount", metrics)
            self.assertEqual(metrics["constituentCount"], len(block["constituents"]))

            for stock in block["constituents"]:
                self.assertIn("symbol", stock)
                self.assertIn("close", stock)
                self.assertIn("changePct", stock)
                self.assertIn("marketCapCr", stock)
                self.assertIn("setups", stock)
                setups = stock["setups"]
                for k in ["stage2", "vcp", "darvas", "bullFlag", "cupHandle", "pocketPivot", "coiled", "tightWeeks"]:
                    self.assertIn(k, setups)
                    self.assertIsInstance(setups[k], bool)

    def test_niche_parent_block_linkage(self):
        block_names = {b["name"] for b in self.data["blocks"]}
        for niche in self.data["niches"]:
            self.assertIsNotNone(niche["parentBlock"])
            self.assertIn(niche["parentBlock"], block_names, f"Niche {niche['name']} points to unknown block {niche['parentBlock']}")
            self.assertEqual(len(niche["trail"]), 13)

    def test_tactical_ipo_rrg(self):
        self.assertIn("ipoTactical", self.data)
        ipos = self.data["ipoTactical"]
        self.assertGreaterEqual(len(ipos), 100)
        symbols = {item["symbol"] for item in ipos}
        for expected in ["DEEPA", "PRIORITY", "LALITHAA", "HEROMOTORS", "VARMORA"]:
            self.assertIn(expected, symbols, f"Recent IPO {expected} missing from tactical IPO RRG")

        for item in ipos:
            self.assertIn("excessReturn10d", item)
            self.assertIn("turnoverIntensity", item)
            self.assertIn("quadrant", item)
            self.assertIn("listingDate", item)
            self.assertIn("listingAgeDays", item)
            self.assertIn("sessions", item)
            self.assertGreaterEqual(item["sessions"], 5)
            self.assertLessEqual(item["listingAgeDays"], 300)
            self.assertGreaterEqual(len(item["trail"]), 1)
            x = item["x"]
            y = item["y"]
            q = item["quadrant"]
            if x >= 0 and y >= 0:
                self.assertEqual(q, "Leading")
            elif x >= 0 and y < 0:
                self.assertEqual(q, "Weakening")
            elif x < 0 and y < 0:
                self.assertEqual(q, "Lagging")
            else:
                self.assertEqual(q, "Improving")

if __name__ == "__main__":
    unittest.main()
