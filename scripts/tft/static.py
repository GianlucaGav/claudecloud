"""Datos estáticos del set (nombres, costes, rasgos, objetos, iconos) desde CommunityDragon."""

from __future__ import annotations

import json
import re
from urllib.request import Request, urlopen

CDRAGON_JSON = "https://raw.communitydragon.org/latest/cdragon/tft/{lang}.json"
CDRAGON_GAME = "https://raw.communitydragon.org/latest/game/"

# Componentes básicos y cuánto aporta cada uno a "ofensivo" / "defensivo".
# Sirve para distinguir al carry (objetos de daño) del tanque (objetos defensivos).
COMPONENTS = {
    "TFT_Item_BFSword": (1.0, 0.0),
    "TFT_Item_RecurveBow": (1.0, 0.0),
    "TFT_Item_NeedlesslyLargeRod": (1.0, 0.0),
    "TFT_Item_SparringGloves": (0.75, 0.25),
    "TFT_Item_TearOfTheGoddess": (0.6, 0.2),
    "TFT_Item_ChainVest": (0.0, 1.0),
    "TFT_Item_NegatronCloak": (0.0, 1.0),
    "TFT_Item_GiantsBelt": (0.0, 1.0),
    "TFT_Item_Spatula": (0.0, 0.0),
    "TFT_Item_FryingPan": (0.0, 0.0),
}


def asset_url(path: str | None) -> str | None:
    if not path:
        return None
    p = path.lower()
    p = re.sub(r"\.(tex|dds)$", ".png", p)
    return CDRAGON_GAME + p


def pretty_name(api_name: str) -> str:
    """'TFT18_KhaZix' -> 'Kha Zix', 'TFT_Item_InfinityEdge' -> 'Infinity Edge'."""
    name = re.sub(r"^TFT\d*_(Item_)?", "", api_name)
    name = re.sub(r"^(Augment_|Item_)", "", name)
    name = name.replace("_", " ")
    return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", name).strip() or api_name


def download(lang: str = "es_es", timeout: int = 60) -> dict:
    req = Request(CDRAGON_JSON.format(lang=lang), headers={"User-Agent": "tft-meta-personal/1.0"})
    with urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _pick_set(raw: dict, set_number: int | None, mutator: str | None) -> dict:
    set_data = raw.get("setData") or []
    if mutator:
        for s in set_data:
            if s.get("mutator") == mutator:
                return s
    if set_number is not None:
        sets = raw.get("sets") or {}
        if str(set_number) in sets:
            return sets[str(set_number)]
        candidates = [s for s in set_data if s.get("number") == set_number]
        if candidates:
            # El set "principal" suele ser el que tiene más campeones.
            return max(candidates, key=lambda s: len(s.get("champions", [])))
    return {}


def build_static(raw: dict | None, set_number: int | None, mutator: str | None) -> dict:
    """Normaliza el JSON de CommunityDragon al formato compacto que usa la web."""
    raw = raw or {}
    s = _pick_set(raw, set_number, mutator)
    champions, traits, items = {}, {}, {}

    trait_by_name = {}
    for t in s.get("traits", []):
        api = t.get("apiName")
        if not api:
            continue
        breakpoints = [
            {"min": e.get("minUnits"), "max": e.get("maxUnits"), "style": e.get("style")}
            for e in t.get("effects", [])
        ]
        traits[api] = {"name": t.get("name") or pretty_name(api), "icon": asset_url(t.get("icon")), "breakpoints": breakpoints}
        trait_by_name[t.get("name")] = api

    for c in s.get("champions", []):
        api = c.get("apiName") or c.get("characterName")
        cost = c.get("cost")
        if not api or not isinstance(cost, int):
            continue
        champions[api] = {
            "name": c.get("name") or pretty_name(api),
            "cost": cost,
            "icon": asset_url(c.get("tileIcon") or c.get("squareIcon") or c.get("icon")),
            # En CommunityDragon los rasgos de un campeón vienen por nombre visible.
            "traits": [trait_by_name.get(t, t) for t in c.get("traits", [])],
            "playable": 1 <= cost <= 5 and bool(c.get("traits")),
        }

    for it in raw.get("items", []):
        api = it.get("apiName")
        if not api:
            continue
        items[api] = {
            "name": it.get("name") or pretty_name(api),
            "icon": asset_url(it.get("icon")),
            "composition": it.get("composition") or [],
        }

    return {
        "set_name": s.get("name"),
        "champions": champions,
        "traits": traits,
        "items": items,
    }


class ItemWeights:
    """Peso ofensivo/defensivo de cada objeto, deducido de sus componentes."""

    def __init__(self, items: dict):
        self.items = items
        self._cache: dict[str, tuple[float, float]] = {}

    def __call__(self, api: str) -> tuple[float, float]:
        if api in self._cache:
            return self._cache[api]
        w = self._compute(api)
        self._cache[api] = w
        return w

    def _compute(self, api: str) -> tuple[float, float]:
        if "Emblem" in api:
            return (0.0, 0.0)
        if api in COMPONENTS:
            off, dfn = COMPONENTS[api]
            return (off * 0.5, dfn * 0.5)
        base = api
        if api.endswith("Radiant"):
            base = re.sub(r"^TFT\d*_Item_", "TFT_Item_", api[: -len("Radiant")])
        comp = (self.items.get(base) or self.items.get(api) or {}).get("composition") or []
        parts = [COMPONENTS[c] for c in comp if c in COMPONENTS]
        if len(parts) == 2:
            return (parts[0][0] + parts[1][0]) / 2, (parts[0][1] + parts[1][1]) / 2
        # Artefactos, objetos de Ornn, etc.: casi siempre van al carry.
        return (0.75, 0.25)


def champions_per_cost(static: dict) -> dict[str, int]:
    counts: dict[str, int] = {}
    for c in static.get("champions", {}).values():
        if c.get("playable"):
            counts[str(c["cost"])] = counts.get(str(c["cost"]), 0) + 1
    return counts
