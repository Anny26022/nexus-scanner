"""Copy canonical root resources into the wheel without moving script inputs."""

from pathlib import Path

from setuptools import setup
from setuptools.command.build_py import build_py


class BuildPy(build_py):
    def run(self):
        super().run()
        target = Path(self.build_lib) / "edl_pipeline" / "data"
        target.mkdir(parents=True, exist_ok=True)
        for name in ("breadth_methodology.json", "filing_source_labels.json"):
            self.copy_file(str(Path(__file__).resolve().parent / name), str(target / name))


setup(cmdclass={"build_py": BuildPy})
