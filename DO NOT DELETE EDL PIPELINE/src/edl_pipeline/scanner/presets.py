"""Versioned offline screener preset library.

The public client bundle publishes named preset metadata and a declarative
condition-expression tree.  This module vendors that *data contract* at a
specific version so a Nexus scan is offline, reproducible and independent of
runtime client dependencies.

The library describes combinations of local conditions; it does not claim
proprietary backend parity for complex pattern primitives.
"""

from __future__ import annotations

import base64
from copy import deepcopy
from functools import lru_cache
import gzip
import json
from typing import Any, Mapping
from .base_presets import build_presets


SOURCE = {
    "format": "offline_preset_contract",
    "version": "v1.0.39",
    "note": "Preset structure and defaults are retained as a local, reproducible condition contract.",
}

# gzip+base64 keeps the vendored, JSON-compatible source record compact in the
# Python package. ``export_preset_library`` writes it back as readable JSON.
_ENCODED_LIBRARY = (
    "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"
)


@lru_cache(maxsize=1)
def _library() -> dict[str, Any]:
    decoded = gzip.decompress(base64.b64decode(_ENCODED_LIBRARY)).decode("utf-8")
    library = json.loads(decoded)
    presets = library.get("presets")
    if not isinstance(presets, list) or len(presets) != 45:
        raise ValueError("Invalid vendored screener preset library.")
    if library.get("schema_version") != 1:
        raise ValueError("Unsupported screener preset-library schema.")
    return library


def load_preset_library() -> dict[str, Any]:
    """Return a defensive copy of the complete, versioned preset library."""
    library=deepcopy(_library())
    library['nexus_base_version']='nexus-bases-1'
    library['presets'].extend(build_presets())
    return library


def list_presets() -> list[dict[str, Any]]:
    """Return display metadata without duplicating the full expression tree."""
    return [
        {
            "id": preset["id"], "name": preset["name"],
            "category": preset["category"], "horizon": preset["horizon"],
            "description": preset["description"], "rule_count": len(preset["rules"]),
        }
        for preset in load_preset_library()["presets"]
    ]


def get_preset(preset_id: str) -> dict[str, Any]:
    """Look up one preset by its stable ``lib-*`` identifier (or name)."""
    query = str(preset_id).strip().casefold()
    for preset in load_preset_library()["presets"]:
        if preset["id"].casefold() == query or preset["name"].casefold() == query:
            return deepcopy(preset)
    available = ", ".join(preset["id"] for preset in load_preset_library()["presets"])
    raise ValueError(f"Unknown screener preset {preset_id!r}. Available IDs: {available}")


def validate_preset_library(condition_registry: Mapping[str, Any]) -> None:
    """Fail fast if a vendored expression refers to an unsupported condition."""
    from .context import normalize_condition_spec

    def visit(node: Mapping[str, Any]) -> None:
        if node.get("type") == "group":
            for child in node.get("children", []):
                visit(child)
            return
        condition = normalize_condition_spec(dict(node)).get("condition")
        if condition not in condition_registry:
            raise ValueError(f"Preset uses unsupported condition: {condition!r}")

    ids = set()
    for preset in load_preset_library()["presets"]:
        if preset["id"] in ids:
            raise ValueError(f"Duplicate screener preset ID: {preset['id']}")
        ids.add(preset["id"])
        visit(preset["expression"])


def export_preset_library(path) -> None:
    """Write the human-readable source record for review or API publication."""
    from pathlib import Path

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(load_preset_library(), indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
