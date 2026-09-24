"""Generador de datos sintéticos con el mismo formato que la API de Riot y CommunityDragon.

Sirve para probar el pipeline sin conexión y para la demo de la web. Los
campeones, rasgos y resultados son INVENTADOS: no reflejan el meta real.
"""

from __future__ import annotations

import json
import random
from pathlib import Path

SET = 99
PREFIX = f"TFT{SET}_"

TRAITS = {
    # apiName: (nombre, puntos de activación)
    "Llama": ("Llama", [2, 4, 6]),
    "Marea": ("Marea", [2, 4, 6]),
    "Bastion": ("Bastión", [2, 4, 6]),
    "Arcano": ("Arcano", [2, 4, 6]),
    "Tirador": ("Tirador", [2, 4]),
    "Duelista": ("Duelista", [2, 4, 6]),
    "Guardian": ("Guardián", [2, 4]),
    "Sombra": ("Sombra", [2, 3, 4]),
    "Coloso": ("Coloso", [2, 4]),
    "Eco": ("Eco", [3, 5, 7]),
    "Reliquia": ("Reliquia", [1]),
}

# apiName: (nombre, coste, rasgos)
CHAMPS = {
    "Brisa": ("Brisa", 1, ["Llama", "Tirador"]),
    "Corvo": ("Corvo", 1, ["Sombra", "Duelista"]),
    "Tundra": ("Tundra", 1, ["Bastion", "Coloso"]),
    "Nela": ("Nela", 1, ["Marea", "Arcano"]),
    "Ruko": ("Ruko", 1, ["Guardian", "Eco"]),
    "Pim": ("Pim", 1, ["Llama", "Guardian"]),
    "Sora": ("Sora", 1, ["Marea", "Tirador"]),
    "Garra": ("Garra", 1, ["Duelista", "Coloso"]),
    "Ivo": ("Ivo", 2, ["Arcano", "Eco"]),
    "Lumen": ("Lumen", 2, ["Llama", "Arcano"]),
    "Moss": ("Moss", 2, ["Bastion", "Guardian"]),
    "Kiri": ("Kiri", 2, ["Sombra", "Tirador"]),
    "Fenn": ("Fenn", 2, ["Duelista", "Eco"]),
    "Odra": ("Odra", 2, ["Marea", "Coloso"]),
    "Vesta": ("Vesta", 2, ["Llama", "Bastion"]),
    "Zale": ("Zale", 3, ["Duelista", "Sombra"]),
    "Mirra": ("Mirra", 3, ["Arcano", "Marea"]),
    "Toro": ("Toro", 3, ["Coloso", "Guardian"]),
    "Yuna": ("Yuna", 3, ["Tirador", "Eco"]),
    "Ascua": ("Ascua", 3, ["Llama", "Duelista"]),
    "Quill": ("Quill", 3, ["Sombra", "Eco"]),
    "Roca": ("Roca", 3, ["Bastion", "Coloso"]),
    "Selva": ("Selva", 4, ["Marea", "Guardian"]),
    "Hexa": ("Hexa", 4, ["Arcano", "Sombra"]),
    "Draco": ("Draco", 4, ["Llama", "Coloso"]),
    "Vela": ("Vela", 4, ["Tirador", "Marea"]),
    "Brask": ("Brask", 4, ["Bastion", "Duelista"]),
    "Nyx": ("Nyx", 4, ["Sombra", "Tirador"]),
    "Aurum": ("Aurum", 5, ["Reliquia", "Arcano"]),
    "Tempest": ("Tempest", 5, ["Reliquia", "Marea"]),
    "Kaldor": ("Kaldor", 5, ["Reliquia", "Bastion"]),
    "Selene": ("Selene", 5, ["Reliquia", "Tirador"]),
}

COMPONENTS = [
    ("TFT_Item_BFSword", "Espada larga"), ("TFT_Item_RecurveBow", "Arco curvo"),
    ("TFT_Item_NeedlesslyLargeRod", "Vara innecesariamente grande"), ("TFT_Item_TearOfTheGoddess", "Lágrima de la diosa"),
    ("TFT_Item_ChainVest", "Chaleco de cadenas"), ("TFT_Item_NegatronCloak", "Capa de negatrones"),
    ("TFT_Item_GiantsBelt", "Cinturón de gigante"), ("TFT_Item_SparringGloves", "Guantes de combate"),
    ("TFT_Item_Spatula", "Espátula"),
]

ITEMS = {
    # apiName: (nombre, composición)
    "TFT_Item_InfinityEdge": ("Filo infinito", ["TFT_Item_BFSword", "TFT_Item_SparringGloves"]),
    "TFT_Item_GuinsoosRageblade": ("Filo de Guinsoo", ["TFT_Item_RecurveBow", "TFT_Item_NeedlesslyLargeRod"]),
    "TFT_Item_Deathblade": ("Hoja de la muerte", ["TFT_Item_BFSword", "TFT_Item_BFSword"]),
    "TFT_Item_JeweledGauntlet": ("Guantelete enjoyado", ["TFT_Item_NeedlesslyLargeRod", "TFT_Item_SparringGloves"]),
    "TFT_Item_RabadonsDeathcap": ("Sombrero de Rabadon", ["TFT_Item_NeedlesslyLargeRod", "TFT_Item_NeedlesslyLargeRod"]),
    "TFT_Item_BlueBuff": ("Aumento azul", ["TFT_Item_TearOfTheGoddess", "TFT_Item_TearOfTheGoddess"]),
    "TFT_Item_GiantSlayer": ("Matagigantes", ["TFT_Item_BFSword", "TFT_Item_RecurveBow"]),
    "TFT_Item_LastWhisper": ("Último susurro", ["TFT_Item_RecurveBow", "TFT_Item_SparringGloves"]),
    "TFT_Item_Shojin": ("Lanza de Shojin", ["TFT_Item_BFSword", "TFT_Item_TearOfTheGoddess"]),
    "TFT_Item_WarmogsArmor": ("Armadura de Warmog", ["TFT_Item_GiantsBelt", "TFT_Item_GiantsBelt"]),
    "TFT_Item_GargoyleStoneplate": ("Placa de gárgola", ["TFT_Item_ChainVest", "TFT_Item_NegatronCloak"]),
    "TFT_Item_DragonsClaw": ("Garra de dragón", ["TFT_Item_NegatronCloak", "TFT_Item_NegatronCloak"]),
    "TFT_Item_BrambleVest": ("Chaleco de zarzas", ["TFT_Item_ChainVest", "TFT_Item_ChainVest"]),
    "TFT_Item_Redemption": ("Redención", ["TFT_Item_TearOfTheGoddess", "TFT_Item_GiantsBelt"]),
    "TFT_Item_SunfireCape": ("Capa de fuego solar", ["TFT_Item_ChainVest", "TFT_Item_GiantsBelt"]),
}
EMBLEMS = {f"TFT{SET}_Item_{t}EmblemItem": (f"Emblema de {n}", ["TFT_Item_Spatula", "TFT_Item_Spatula"]) for t, (n, _) in TRAITS.items()}

CARRY_ITEMS_AD = ["TFT_Item_InfinityEdge", "TFT_Item_GiantSlayer", "TFT_Item_LastWhisper", "TFT_Item_Deathblade", "TFT_Item_GuinsoosRageblade"]
CARRY_ITEMS_AP = ["TFT_Item_JeweledGauntlet", "TFT_Item_RabadonsDeathcap", "TFT_Item_BlueBuff", "TFT_Item_Shojin", "TFT_Item_GuinsoosRageblade"]
TANK_ITEMS = ["TFT_Item_WarmogsArmor", "TFT_Item_GargoyleStoneplate", "TFT_Item_DragonsClaw", "TFT_Item_BrambleVest", "TFT_Item_SunfireCape", "TFT_Item_Redemption"]

# Arquetipos: núcleo, carry, tipo de objetos, tanque, nivel típico, fuerza (más = mejor) y popularidad.
ARCHETYPES = [
    {"core": ["Ascua", "Draco", "Lumen", "Vesta", "Brisa", "Pim", "Roca", "Aurum"], "carry": "Draco", "dmg": "ad", "tank": "Roca", "level": 8, "strength": 0.9, "pop": 1.0},
    {"core": ["Mirra", "Selva", "Vela", "Odra", "Nela", "Sora", "Tempest", "Toro"], "carry": "Vela", "dmg": "ad", "tank": "Selva", "level": 8, "strength": 0.4, "pop": 1.4},
    {"core": ["Zale", "Corvo", "Kiri", "Quill", "Garra", "Fenn", "Brask", "Toro"], "carry": "Corvo", "dmg": "ad", "tank": "Toro", "level": 6, "strength": 0.6, "pop": 0.8, "reroll": True},
    {"core": ["Hexa", "Aurum", "Mirra", "Lumen", "Ivo", "Nela", "Kaldor", "Selva", "Tempest"], "carry": "Aurum", "dmg": "ap", "tank": "Kaldor", "level": 9, "strength": 0.2, "pop": 0.9},
    {"core": ["Yuna", "Ruko", "Ivo", "Fenn", "Quill", "Toro", "Moss", "Selene"], "carry": "Yuna", "dmg": "ad", "tank": "Moss", "level": 7, "strength": -0.2, "pop": 0.7, "reroll": True},
    {"core": ["Selene", "Nyx", "Vela", "Kiri", "Brask", "Kaldor", "Selva", "Hexa", "Tempest"], "carry": "Selene", "dmg": "ad", "tank": "Kaldor", "level": 9, "strength": 0.0, "pop": 0.6},
    {"core": ["Tundra", "Moss", "Toro", "Roca", "Vesta", "Kaldor", "Odra", "Garra"], "carry": "Roca", "dmg": "ap", "tank": "Tundra", "level": 7, "strength": -0.8, "pop": 0.5},
]

ALL = list(CHAMPS)


def cdragon_json() -> dict:
    traits = []
    for api, (name, bps) in TRAITS.items():
        effects = []
        for i, bp in enumerate(bps):
            nxt = bps[i + 1] - 1 if i + 1 < len(bps) else 25000
            effects.append({"minUnits": bp, "maxUnits": nxt, "style": [1, 3, 5][min(i, 2)] if len(bps) > 1 else 3, "variables": {}})
        traits.append({"apiName": PREFIX + api, "name": name, "icon": None, "effects": effects})
    champs = [
        {"apiName": PREFIX + api, "characterName": PREFIX + api, "name": name, "cost": cost,
         "traits": [TRAITS[t][0] for t in tr], "squareIcon": None, "tileIcon": None}
        for api, (name, cost, tr) in CHAMPS.items()
    ]
    # Un "campeón" no jugable como los que trae CommunityDragon (invocaciones, etc.).
    champs.append({"apiName": PREFIX + "Totem", "name": "Tótem", "cost": 8, "traits": []})
    items = [{"apiName": a, "name": n, "composition": [], "icon": None} for a, n in COMPONENTS]
    items += [{"apiName": a, "name": n, "composition": c, "icon": None} for a, (n, c) in {**ITEMS, **EMBLEMS}.items()]
    set_entry = {"mutator": f"TFTSet{SET}", "name": "Set de demostración", "number": SET, "champions": champs, "traits": traits}
    return {"items": items, "setData": [set_entry], "sets": {str(SET): set_entry}}


def _traits_for(units: list[str]) -> list[dict]:
    counts = {}
    for u in set(units):
        for t in CHAMPS[u][2]:
            counts[t] = counts.get(t, 0) + 1
    out = []
    for t, n in counts.items():
        bps = TRAITS[t][1]
        tier = sum(1 for bp in bps if n >= bp)
        style = 0 if tier == 0 else (min(tier, 3) if len(bps) > 1 else 3)
        out.append({"name": PREFIX + t, "num_units": n, "style": style, "tier_current": tier, "tier_total": len(bps)})
    return out


def _board(rng: random.Random, arch: dict) -> dict:
    units = list(arch["core"])
    # Ruido: cambia 0-2 unidades que no sean carry ni tanque.
    for _ in range(rng.choice([0, 0, 1, 1, 2])):
        swappable = [u for u in units if u not in (arch["carry"], arch["tank"])]
        if swappable:
            units[units.index(rng.choice(swappable))] = rng.choice([c for c in ALL if c not in units])
    level = max(5, min(10, arch["level"] + rng.choice([-1, 0, 0, 0, 1])))
    units = units[: max(level, 6)]
    if arch["carry"] not in units:
        units[0] = arch["carry"]
    pool = CARRY_ITEMS_AD if arch["dmg"] == "ad" else CARRY_ITEMS_AP
    out = []
    for u in units:
        cost = CHAMPS[u][1]
        if u == arch["carry"]:
            items = rng.sample(pool[:4], 3) if rng.random() < 0.85 else rng.sample(pool, 2)
            star = 3 if arch.get("reroll") and rng.random() < 0.7 else 2
        elif u == arch["tank"]:
            items = rng.sample(TANK_ITEMS, 3 if rng.random() < 0.7 else 2)
            star = 2
        else:
            items = [rng.choice(list(EMBLEMS))] if rng.random() < 0.05 else []
            star = 2 if cost <= 3 and rng.random() < 0.7 else (1 if cost >= 4 else rng.choice([1, 2]))
        out.append({"character_id": PREFIX + u, "itemNames": items, "name": "", "rarity": cost - 1, "tier": star})
    return {"level": level, "units": out, "traits": _traits_for(units)}


def generate(n_matches: int = 700, seed: int = 7, version: str = "16.19", start_ms: int | None = None) -> list[dict]:
    rng = random.Random(seed)
    start_ms = start_ms or 1_790_000_000_000
    weights = [a["pop"] for a in ARCHETYPES]
    matches = []
    for m in range(n_matches):
        picks = rng.choices(range(len(ARCHETYPES)), weights=weights, k=8)
        # Carry disputado: penaliza a quienes comparten carry en la misma partida.
        carry_counts = {}
        for p in picks:
            carry_counts[ARCHETYPES[p]["carry"]] = carry_counts.get(ARCHETYPES[p]["carry"], 0) + 1
        scores = []
        for i, p in enumerate(picks):
            a = ARCHETYPES[p]
            penalty = 0.6 * (carry_counts[a["carry"]] - 1)
            scores.append((a["strength"] - penalty + rng.gauss(0, 1.3), i))
        order = sorted(scores, reverse=True)
        placement = {i: rank + 1 for rank, (_, i) in enumerate(order)}
        participants = []
        for i, p in enumerate(picks):
            b = _board(rng, ARCHETYPES[p])
            participants.append({
                "puuid": f"puuid-{m}-{i}", "placement": placement[i], "level": b["level"],
                "traits": b["traits"], "units": b["units"], "gold_left": 0, "last_round": 30,
                "augments": [], "win": placement[i] <= 4,
            })
        match_id = f"EUW1_{9_000_000 + m}"
        matches.append({
            "metadata": {"data_version": "6", "match_id": match_id, "participants": [p["puuid"] for p in participants]},
            "info": {
                "game_datetime": start_ms + m * 60_000,
                "game_version": f"Linux Version {version}.712.4321 (Sep 18 2026/11:15:04) [PUBLIC] <Releasewatch>",
                "queue_id": 1100, "tft_game_type": "standard", "tft_set_core_name": f"TFTSet{SET}", "tft_set_number": SET,
                "participants": participants,
            },
        })
    return matches


def write(out_dir: Path, n_matches: int = 700, seed: int = 7, start_ms: int | None = None) -> tuple[Path, Path]:
    out_dir = Path(out_dir)
    mdir = out_dir / "matches"
    mdir.mkdir(parents=True, exist_ok=True)
    for m in generate(n_matches, seed, start_ms=start_ms):
        (mdir / f"{m['metadata']['match_id']}.json").write_text(json.dumps(m), encoding="utf-8")
    static = out_dir / "cdragon.json"
    static.write_text(json.dumps(cdragon_json(), ensure_ascii=False), encoding="utf-8")
    return mdir, static


if __name__ == "__main__":
    import sys

    target = Path(sys.argv[1] if len(sys.argv) > 1 else "synthetic")
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 700
    print(write(target, n))
