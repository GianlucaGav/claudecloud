#!/usr/bin/env python3
"""Actualiza data/meta.json con las composiciones del meta actual de TFT.

Uso típico (lo ejecuta el GitHub Action cada pocas horas):

    RIOT_API_KEY=RGAPI-... python3 scripts/update_meta.py

Variables de entorno (todas opcionales salvo la clave):
    RIOT_API_KEY              clave de https://developer.riotgames.com
    TFT_PLATFORMS             plataformas a consultar (por defecto "euw1,kr,na1")
    TFT_TIERS                 ligas (por defecto "challenger,grandmaster,master")
    TFT_PLAYERS_PER_PLATFORM  jugadores por plataforma (por defecto 120)
    TFT_MATCHES_PER_PLAYER    partidas recientes por jugador (por defecto 10)
    TFT_MAX_NEW_MATCHES       partidas nuevas por plataforma y ejecución (por defecto 400)
    TFT_LOOKBACK_DAYS         antigüedad máxima de las partidas (por defecto 4)
    TFT_CACHE_DAYS            días que se conservan en caché (por defecto 7)
    TFT_MIN_BOARDS            muestra mínima antes de mezclar parches (por defecto 4000)
    TFT_LANG                  idioma de nombres de CommunityDragon (por defecto "es_es")
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from tft import analyze as an  # noqa: E402
from tft import riot  # noqa: E402
from tft import static as st  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def log(msg: str):
    print(msg, flush=True)


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def env_list(name: str, default: str) -> list[str]:
    return [x.strip().lower() for x in os.environ.get(name, default).split(",") if x.strip()]


def load_cache(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        with gzip.open(path, "rt", encoding="utf-8") as f:
            return json.load(f).get("matches", {})
    except (OSError, ValueError) as err:
        log(f"Caché ilegible ({err}); se empieza de cero")
        return {}


def save_cache(path: Path, matches: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as f:
        json.dump({"matches": matches}, f, separators=(",", ":"))


def prune(matches: dict, days: int) -> dict:
    cutoff = (time.time() - days * 86400) * 1000
    ranked_sets = [m.get("s") or 0 for m in matches.values() if m.get("q") in an.RANKED_QUEUES]
    latest = max(ranked_sets, default=None)
    return {
        k: m for k, m in matches.items()
        if (m.get("t") or 0) >= cutoff and (latest is None or (m.get("s") or 0) == latest)
    }


def fetch(matches: dict, cfg: dict) -> str | None:
    """Descarga partidas nuevas. Devuelve un mensaje de error o None."""
    key = riot.clean_key(os.environ["RIOT_API_KEY"])
    warning = riot.key_format_warning(key)
    if warning:
        log(warning)
    client = riot.RiotClient(key, log=log)
    platforms = [p for p in cfg["platforms"] if p in riot.PLATFORM_REGION]
    unknown = set(cfg["platforms"]) - set(platforms)
    if unknown:
        log(f"Plataformas desconocidas ignoradas: {', '.join(sorted(unknown))}")
    known = set(matches)
    error = None
    with ThreadPoolExecutor(max_workers=max(1, len(platforms))) as ex:
        futures = {p: ex.submit(riot.collect_platform, client, p, cfg, known, log) for p in platforms}
        for p, fut in futures.items():
            try:
                for raw in fut.result():
                    cm = an.compact_match(raw, p)
                    if cm:
                        matches[cm["id"]] = cm
            except riot.RiotAuthError as err:
                error = str(err)
                log(f"ERROR ({p}): {err}")
            except Exception as err:  # noqa: BLE001 — una región caída no debe tumbar las demás
                error = error or f"{p}: {err}"
                log(f"ERROR ({p}): {err}")
    log(f"Peticiones a la API de Riot: {client.requests}")
    return error


def trim_static(static: dict, comps: list[dict]) -> dict:
    """Solo los datos estáticos que usa la web, para que meta.json pese poco."""
    champs = {k: v for k, v in static["champions"].items() if v.get("playable")}
    used_items, used_champs, used_traits = set(), set(), set()
    for c in comps:
        for u in c["units"]:
            used_champs.add(u["id"])
        for t in c["traits"]:
            used_traits.add(t["id"])
        if c.get("ptrait"):
            used_traits.add(c["ptrait"])
        for info in c["items"].values():
            used_items.update(i["id"] for i in info["items"])
            for b in info["builds"]:
                used_items.update(b["items"])
        used_items.update(a["id"] for a in c.get("augments", []))
    for cid in used_champs:
        if cid in static["champions"]:
            champs[cid] = static["champions"][cid]
    for v in champs.values():
        used_traits.update(v.get("traits", []))

    def champ(v):
        return {"name": v["name"], "cost": v["cost"], "icon": v.get("icon"), "traits": v.get("traits", [])}

    return {
        "champions": {k: champ(v) for k, v in champs.items()},
        "traits": {k: static["traits"][k] for k in sorted(used_traits) if k in static["traits"]},
        "items": {k: {"name": static["items"][k]["name"], "icon": static["items"][k]["icon"]}
                  for k in sorted(used_items) if k in static["items"]},
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(ROOT / "data" / "meta.json"))
    ap.add_argument("--cache", default=str(ROOT / ".cache" / "tft" / "matches.json.gz"))
    ap.add_argument("--matches-dir", help="carpeta con partidas en formato de la API de Riot (sin descargar)")
    ap.add_argument("--static", help="JSON de CommunityDragon local (sin descargar)")
    ap.add_argument("--no-fetch", action="store_true", help="no llamar a la API de Riot")
    ap.add_argument("--source", default=None, help="etiqueta de origen para meta.json")
    args = ap.parse_args()

    cfg = {
        "platforms": env_list("TFT_PLATFORMS", "euw1,kr,na1"),
        "tiers": env_list("TFT_TIERS", "challenger,grandmaster,master"),
        "players": env_int("TFT_PLAYERS_PER_PLATFORM", 120),
        "matches_per_player": env_int("TFT_MATCHES_PER_PLAYER", 10),
        "max_new_matches": env_int("TFT_MAX_NEW_MATCHES", 400),
        "lookback_days": env_int("TFT_LOOKBACK_DAYS", 4),
    }
    cache_days = env_int("TFT_CACHE_DAYS", 7)
    lang = os.environ.get("TFT_LANG", "es_es")

    cache_path = Path(args.cache)
    matches = load_cache(cache_path)
    log(f"Partidas en caché: {len(matches)}")

    if args.matches_dir:
        for f in sorted(Path(args.matches_dir).glob("*.json")):
            cm = an.compact_match(json.loads(f.read_text(encoding="utf-8")))
            if cm:
                matches[cm["id"]] = cm
        log(f"Partidas tras cargar {args.matches_dir}: {len(matches)}")

    error = None
    if os.environ.get("RIOT_API_KEY") and not args.no_fetch:
        log(f"Descargando de {', '.join(cfg['platforms'])} ({', '.join(cfg['tiers'])})...")
        error = fetch(matches, cfg)
    elif not args.no_fetch and not args.matches_dir:
        log("Falta RIOT_API_KEY: solo se reanaliza lo que haya en caché.")

    if not args.matches_dir:
        matches = prune(matches, cache_days)
    save_cache(cache_path, matches)
    log(f"Partidas en caché tras podar: {len(matches)}")

    compacts = list(matches.values())
    chosen, _ = an.select_matches(compacts, 1)
    set_number = chosen[0].get("s") if chosen else None
    mutator = chosen[0].get("sn") if chosen else None

    raw_static = None
    if args.static:
        raw_static = json.loads(Path(args.static).read_text(encoding="utf-8"))
    elif compacts:
        try:
            raw_static = st.download(lang)
        except Exception as err:  # noqa: BLE001
            log(f"Aviso: no se pudo descargar CommunityDragon ({err}); se usarán nombres internos")
    static = st.build_static(raw_static, set_number, mutator)

    result = an.analyze(compacts, static, min_boards=env_int("TFT_MIN_BOARDS", 4000), log=log)
    if not result["comps"]:
        log("No hay datos suficientes para detectar composiciones.")
        if error:
            log(error)
        return 1

    meta = {
        "schema": 1,
        "source": args.source or ("riot-api" if not args.matches_dir else "local"),
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "set": {"number": result["set_number"], "mutator": result["set_mutator"], "name": static.get("set_name")},
        "sample": {
            "matches": result["matches"],
            "boards": result["boards"],
            "assigned": result["assigned"],
            "versions": result["versions"],
            "platforms": result["platforms"],
            "tiers": cfg["tiers"],
            "from": result["from"],
            "to": result["to"],
        },
        "pool": {"championsPerCost": st.champions_per_cost(static)},
        "static": trim_static(static, result["comps"]),
        "comps": result["comps"],
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log(f"Escrito {out} ({out.stat().st_size / 1024:.0f} KB, {len(result['comps'])} composiciones)")
    if error:
        log(f"Terminado con errores: {error}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
