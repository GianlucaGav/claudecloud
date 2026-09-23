"""Agrupa los tableros finales en composiciones y agrega sus estadísticas.

Método (determinista):
1. Cada tablero se describe por su conjunto de campeones, su carry (la unidad
   con más objetos ofensivos) y su rasgo principal.
2. Semillas: tableros agrupados por (carry, rasgo principal).
3. Se fusionan semillas del mismo carry con perfiles de unidades muy parecidos.
4. k-modes: cada tablero se reasigna al perfil más parecido (Jaccard ponderado
   entre su conjunto de unidades y la frecuencia de cada unidad en el grupo),
   varias iteraciones. Los tableros que no se parecen a nada quedan fuera.
5. Se descartan grupos con pocas partidas y se agregan las estadísticas en
   bruto (histograma de posiciones, objetos, unidades...). Las métricas
   derivadas (medias bayesianas, intervalos) se calculan en la web.
"""

from __future__ import annotations

import math
import re
from collections import Counter, defaultdict

from .static import ItemWeights, pretty_name

RANKED_QUEUES = {1100}


def version_key(v: str) -> tuple:
    return tuple(int(x) for x in re.findall(r"\d+", v or "")[:2]) or (0,)


def compact_match(m: dict, platform: str | None = None) -> dict | None:
    """Reduce una partida de la API de Riot a lo imprescindible (sin PUUIDs)."""
    try:
        info = m["info"]
        match_id = m["metadata"]["match_id"]
    except (KeyError, TypeError):
        return None
    ver = re.search(r"(\d+)\.(\d+)", info.get("game_version", ""))
    boards = []
    for p in info.get("participants", []):
        boards.append({
            "p": p.get("placement"),
            "l": p.get("level"),
            "u": [[u.get("character_id"), u.get("tier", 1), u.get("itemNames") or []] for u in p.get("units", [])],
            "tr": [
                [t.get("name"), t.get("num_units", 0), t.get("style", 0), t.get("tier_current", 0), t.get("tier_total", 0)]
                for t in p.get("traits", [])
                if t.get("tier_current", 0) > 0
            ],
            "a": p.get("augments") or [],
        })
    return {
        "id": match_id,
        "pf": platform or match_id.split("_")[0].lower(),
        "t": info.get("game_datetime"),
        "v": f"{ver.group(1)}.{ver.group(2)}" if ver else "?",
        "q": info.get("queue_id", info.get("queueId")),
        "s": info.get("tft_set_number"),
        "sn": info.get("tft_set_core_name"),
        "b": boards,
    }


# --- Selección del conjunto de datos -------------------------------------------

def select_matches(matches: list[dict], min_boards: int, queues=RANKED_QUEUES) -> tuple[list[dict], list[str]]:
    """Partidas clasificatorias del set más reciente y del parche más reciente
    (añadiendo parches anteriores solo si no hay muestra suficiente)."""
    ranked = [m for m in matches if m.get("q") in queues and m.get("b")]
    if not ranked:
        return [], []
    latest_set = max((m.get("s") or 0) for m in ranked)
    ranked = [m for m in ranked if (m.get("s") or 0) == latest_set]
    versions = sorted({m["v"] for m in ranked}, key=version_key, reverse=True)
    chosen, used = [], []
    for v in versions:
        chosen += [m for m in ranked if m["v"] == v]
        used.append(v)
        if sum(len(m["b"]) for m in chosen) >= min_boards:
            break
    return chosen, used


# --- Rasgos de cada tablero ------------------------------------------------------

class Canon:
    """Unifica los identificadores de la API de Riot con los de CommunityDragon
    (a veces difieren en mayúsculas) y descarta lo que no es un campeón jugable."""

    def __init__(self, static: dict):
        champs = static.get("champions", {})
        self.units = {k.lower(): k for k, v in champs.items() if v.get("playable")}
        self.traits = {k.lower(): k for k in static.get("traits", {})}
        self.items = {k.lower(): k for k in static.get("items", {})}

    def unit(self, cid):
        if not self.units:
            return cid
        return self.units.get((cid or "").lower())

    def trait(self, tid):
        return self.traits.get((tid or "").lower(), tid)

    def item(self, iid):
        return self.items.get((iid or "").lower(), iid)


class Board:
    __slots__ = ("mid", "idx", "place", "level", "units", "uset", "carry", "carry2", "tank",
                 "carry_unit", "ptrait", "traits", "augments", "cluster")

    def __init__(self, mid, idx, raw, canon, weights):
        self.mid, self.idx = mid, idx
        self.place = raw["p"]
        self.level = raw.get("l") or 0
        self.units = []
        for cid, star, items in raw["u"]:
            cid = canon.unit(cid)
            if cid:
                self.units.append((cid, star or 1, [canon.item(i) for i in items]))
        self.uset = frozenset(u[0] for u in self.units)
        self.traits = [(canon.trait(t[0]), *t[1:]) for t in raw.get("tr") or []]
        self.augments = raw.get("a") or []
        self.cluster = None

        # Carry = más peso ofensivo en objetos; desempate por estrellas y nº de objetos.
        scored = []
        for u in self.units:
            off = sum(weights(i)[0] for i in u[2])
            dfn = sum(weights(i)[1] for i in u[2])
            scored.append((off, dfn, u))
        by_off = sorted(scored, key=lambda s: (s[0], s[2][1], len(s[2][2])), reverse=True)
        self.carry = by_off[0][2][0] if by_off and by_off[0][0] >= 1.0 else None
        self.carry_unit = by_off[0][2] if self.carry else None
        self.carry2 = None
        for off, _, u in by_off[1:]:
            if off >= 1.4 and u[0] != self.carry:
                self.carry2 = u[0]
                break
        by_def = sorted(scored, key=lambda s: (s[1], s[2][1]), reverse=True)
        self.tank = by_def[0][2][0] if by_def and by_def[0][1] >= 1.4 else None
        if self.carry is None and self.units:
            # Sin objetos ofensivos claros: la unidad con más objetos y estrellas.
            best = max(self.units, key=lambda u: (len(u[2]), u[1]))
            self.carry, self.carry_unit = best[0], best

        # Rasgo principal: el que más unidades activa (sin rasgos únicos).
        cands = [t for t in self.traits if (t[4] or 0) > 1]
        cands.sort(key=lambda t: (t[1], t[3] / max(t[4], 1), t[2]), reverse=True)
        self.ptrait = cands[0][0] if cands else None


def wjaccard(uset: frozenset, freq: dict, fsum: float) -> float:
    inter = sum(freq.get(u, 0.0) for u in uset)
    denom = len(uset) + fsum - inter
    return inter / denom if denom > 0 else 0.0


def profile(boards: list[Board]) -> tuple[dict, float, Counter]:
    counts = Counter()
    carries = Counter()
    for b in boards:
        counts.update(b.uset)
        carries[b.carry] += 1
    n = max(len(boards), 1)
    freq = {u: c / n for u, c in counts.items() if c / n >= 0.08}
    return freq, sum(freq.values()), carries


def cosine(a: dict, b: dict) -> float:
    dot = sum(v * b.get(k, 0.0) for k, v in a.items())
    na = math.sqrt(sum(v * v for v in a.values()))
    nb = math.sqrt(sum(v * v for v in b.values()))
    return dot / (na * nb) if na and nb else 0.0


def cluster_boards(boards: list[Board], min_seed: int, min_games: int, iterations: int = 4,
                   assign_threshold: float = 0.38, carry_bonus: float = 0.12, log=print) -> list[list[Board]]:
    seeds = defaultdict(list)
    for b in boards:
        if b.uset:
            seeds[(b.carry, b.ptrait)].append(b)
    groups = [g for g in seeds.values() if len(g) >= min_seed]
    groups.sort(key=len, reverse=True)
    log(f"  semillas: {len(seeds)} (válidas: {len(groups)})")

    # Fusión de semillas del mismo carry con perfiles casi iguales.
    profiles = [profile(g) for g in groups]
    parent = list(range(len(groups)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(groups)):
        for j in range(i + 1, len(groups)):
            ci = profiles[i][2].most_common(1)[0][0]
            cj = profiles[j][2].most_common(1)[0][0]
            sim = cosine(profiles[i][0], profiles[j][0])
            if (ci == cj and sim >= 0.85) or sim >= 0.94:
                parent[find(j)] = find(i)
    merged = defaultdict(list)
    for i, g in enumerate(groups):
        merged[find(i)].extend(g)
    clusters = list(merged.values())

    # k-modes: reasignación iterativa al perfil más parecido.
    def reassign(clusters):
        profs = []
        for g in clusters:
            freq, fsum, carries = profile(g)
            profs.append((freq, fsum, carries.most_common(1)[0][0] if carries else None))
        new = [[] for _ in clusters]
        for b in boards:
            if not b.uset:
                continue
            best, best_score = None, assign_threshold
            for k, (freq, fsum, carry) in enumerate(profs):
                score = wjaccard(b.uset, freq, fsum) + (carry_bonus if b.carry == carry else 0.0)
                if score > best_score:
                    best, best_score = k, score
            if best is not None:
                new[best].append(b)
        return new

    for _ in range(iterations):
        clusters = [g for g in reassign(clusters) if len(g) >= min_seed]
    # Los tableros de grupos descartados por pequeños se recolocan en los que quedan.
    clusters = [g for g in clusters if len(g) >= min_games]
    clusters = [g for g in reassign(clusters) if len(g) >= min_games]
    clusters.sort(key=len, reverse=True)

    for k, g in enumerate(clusters):
        for b in g:
            b.cluster = k
    return clusters


# --- Agregación --------------------------------------------------------------------

def _mode(counter: Counter, default=None):
    return counter.most_common(1)[0][0] if counter else default


def _instance(b: Board, unit_id: str):
    """La copia de la unidad con más objetos (puede haber varias en el tablero)."""
    best = None
    for u in b.units:
        if u[0] == unit_id and (best is None or len(u[2]) > len(best[2])):
            best = u
    return best


def summarize_cluster(g: list[Board], by_match: dict, static: dict) -> dict:
    n = len(g)
    placements = [0] * 8
    levels = Counter()
    carries, carries2, tanks, ptraits = Counter(), Counter(), Counter(), Counter()
    for b in g:
        if 1 <= b.place <= 8:
            placements[b.place - 1] += 1
        levels[b.level] += 1
        carries[b.carry] += 1
        if b.carry2:
            carries2[b.carry2] += 1
        if b.tank:
            tanks[b.tank] += 1
        if b.ptrait:
            ptraits[b.ptrait] += 1
    carry = _mode(carries)
    carry2 = None
    for c, k in carries2.most_common():
        if c != carry and k / n >= 0.35:
            carry2 = c
            break
    tank = None
    for c, k in tanks.most_common():
        if c not in (carry, carry2) and k / n >= 0.3:
            tank = c
            break

    # Unidades
    ucount, uplace, ustars = Counter(), Counter(), defaultdict(lambda: [0, 0, 0, 0])
    for b in g:
        for uid in b.uset:
            ucount[uid] += 1
            uplace[uid] += b.place
            inst = _instance(b, uid)
            stars = min(max(inst[1], 1), 4)
            ustars[uid][stars - 1] += 1
    units = [
        {"id": u, "n": c, "ps": uplace[u], "stars": ustars[u]}
        for u, c in ucount.most_common() if c / n >= 0.15
    ][:16]
    sizes = sorted(len(b.uset) for b in g)
    board_size = min(10, max(1, sizes[len(sizes) // 2]))
    board = [u["id"] for u in units[:board_size]]

    # Rasgos
    tcount, tunits, tstyle = Counter(), defaultdict(Counter), defaultdict(Counter)
    for b in g:
        for name, num, style, _cur, _tot in b.traits:
            tcount[name] += 1
            tunits[name][num] += 1
            tstyle[name][style] += 1
    traits = [
        {"id": t, "n": c, "units": _mode(tunits[t]), "style": _mode(tstyle[t])}
        for t, c in tcount.most_common() if c / n >= 0.3
    ]
    traits.sort(key=lambda t: (-(t["style"] or 0), -t["n"]))

    # Objetos de carry, segundo carry y tanque
    items = {}
    for role, uid in (("carry", carry), ("carry2", carry2), ("tank", tank)):
        if not uid or uid in items:
            continue
        with_unit, ps_unit = 0, 0
        icount, iplace = Counter(), Counter()
        bcount, bplace = Counter(), Counter()
        for b in g:
            inst = _instance(b, uid)
            if not inst:
                continue
            with_unit += 1
            ps_unit += b.place
            for it in set(inst[2]):
                icount[it] += 1
                iplace[it] += b.place
            if len(inst[2]) == 3:
                key = tuple(sorted(inst[2]))
                bcount[key] += 1
                bplace[key] += b.place
        items[uid] = {
            "role": role,
            "n": with_unit,
            "ps": ps_unit,
            "items": [{"id": i, "n": c, "ps": iplace[i]} for i, c in icount.most_common(12)],
            "builds": [{"items": list(k), "n": c, "ps": bplace[k]} for k, c in bcount.most_common(6) if c >= 2],
        }

    # Aumentos (solo si la API los incluye)
    acount, aplace = Counter(), Counter()
    for b in g:
        for a in set(b.augments):
            acount[a] += 1
            aplace[a] += b.place
    augments = [{"id": a, "n": c, "ps": aplace[a]} for a, c in acount.most_common(15)]

    # ¿Carry disputado? Otro jugador de la misma partida con el carry a 2★ o más.
    contested = [0, 0]  # partidas, suma de posiciones
    uncontested = [0, 0]
    for b in g:
        others = by_match.get(b.mid, [])
        hit = any(
            o.idx != b.idx and any(u[0] == carry and u[1] >= 2 for u in o.units)
            for o in others
        )
        bucket = contested if hit else uncontested
        bucket[0] += 1
        bucket[1] += b.place

    carry_stars = ustars.get(carry, [0, 0, 0, 0])
    carry_n = max(ucount.get(carry, 0), 1)
    carry_cost = static["champions"].get(carry, {}).get("cost")
    p9 = sum(c for lvl, c in levels.items() if lvl >= 9) / n
    p8 = sum(c for lvl, c in levels.items() if lvl >= 8) / n
    three_star = carry_stars[2] / carry_n + carry_stars[3] / carry_n
    if carry_cost and carry_cost <= 3 and three_star >= 0.35:
        style = "reroll"
    elif p9 >= 0.5:
        style = "fast9"
    elif p8 >= 0.6:
        style = "fast8"
    else:
        style = "standard"

    return {
        "carry": carry,
        "carry2": carry2,
        "tank": tank,
        "ptrait": _mode(ptraits),
        "style": style,
        "games": n,
        "placements": placements,
        "levels": {str(k): v for k, v in sorted(levels.items())},
        "units": units,
        "board": board,
        "traits": traits,
        "items": items,
        "augments": augments,
        "contested": {"n": contested[0], "ps": contested[1], "free_n": uncontested[0], "free_ps": uncontested[1]},
    }


def name_comps(comps: list[dict], static: dict):
    champs, traits = static["champions"], static["traits"]

    def cname(c):
        return champs.get(c, {}).get("name") or pretty_name(c or "?")

    def tname(t):
        return traits.get(t, {}).get("name") or pretty_name(t or "")

    for c in comps:
        parts = []
        if c["ptrait"]:
            parts.append(tname(c["ptrait"]))
        parts.append(cname(c["carry"]))
        name = " ".join(parts)
        if c["carry2"]:
            name += f" y {cname(c['carry2'])}"
        c["name"] = name
    # Nombres repetidos: se distinguen por un rasgo que no tenga la versión más jugada.
    seen = Counter(c["name"] for c in comps)
    for name, k in seen.items():
        if k < 2:
            continue
        dupes = [c for c in comps if c["name"] == name]
        base_traits = {t["id"] for t in dupes[0]["traits"]}
        for i, c in enumerate(dupes[1:], 2):
            extra = next((t["id"] for t in c["traits"] if t["id"] not in base_traits), None)
            c["name"] = f"{name} · {tname(extra)}" if extra else f"{name} ({i})"


def analyze(matches: list[dict], static: dict, weights: ItemWeights | None = None,
            min_boards: int = 4000, log=print) -> dict:
    chosen, versions = select_matches(matches, min_boards)
    weights = weights or ItemWeights(static.get("items", {}))
    canon = Canon(static)

    boards, by_match = [], defaultdict(list)
    for m in chosen:
        for i, raw in enumerate(m["b"]):
            b = Board(m["id"], i, raw, canon, weights)
            boards.append(b)
            by_match[m["id"]].append(b)
    total = len(boards)
    log(f"  tableros analizados: {total} de {len(chosen)} partidas (versiones {', '.join(versions) or '-'})")
    if not boards:
        return {"comps": [], "versions": versions, "matches": 0, "boards": 0, "assigned": 0}

    min_seed = max(6, int(total * 0.0015))
    min_games = max(15, int(total * 0.003))
    clusters = cluster_boards(boards, min_seed=min_seed, min_games=min_games, log=log)
    comps = [summarize_cluster(g, by_match, static) for g in clusters]
    name_comps(comps, static)
    for k, c in enumerate(comps):
        c["id"] = f"c{k + 1}"
    assigned = sum(c["games"] for c in comps)
    log(f"  composiciones: {len(comps)} (cubren {assigned / total:.0%} de los tableros)")

    times = [m["t"] for m in chosen if m.get("t")]
    platforms = Counter(m.get("pf") for m in chosen)
    return {
        "comps": comps,
        "versions": versions,
        "matches": len(chosen),
        "boards": total,
        "assigned": assigned,
        "from": min(times) if times else None,
        "to": max(times) if times else None,
        "platforms": dict(platforms),
        "set_number": chosen[0].get("s") if chosen else None,
        "set_mutator": chosen[0].get("sn") if chosen else None,
    }
