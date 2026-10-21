"""Runtime configuration for the EDL pipeline."""

from dataclasses import dataclass
import os


def env_bool(name, default):
    """Read a boolean env var while preserving the supplied default."""
    value = os.getenv(name)
    if value is None:
        return default

    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "y", "on"}:
        return True
    if normalized in {"0", "false", "no", "n", "off"}:
        return False

    print(f"  WARNING: Ignoring invalid {name}={value!r}; using {default}.")
    return default


@dataclass(frozen=True)
class PipelineConfig:
    fetch_ohlcv: bool = True
    fetch_optional: bool = False
    cleanup_intermediate: bool = True
    build_thematic_rrg: bool = True

    @classmethod
    def from_env(cls):
        return cls(
            fetch_ohlcv=env_bool("EDL_FETCH_OHLCV", True),
            fetch_optional=env_bool("EDL_FETCH_OPTIONAL", False),
            cleanup_intermediate=env_bool("EDL_CLEANUP_INTERMEDIATE", True),
            build_thematic_rrg=env_bool("EDL_BUILD_THEMATIC_RRG", True),
        )
