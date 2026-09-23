"""Cliente mínimo de la API oficial de Riot para TFT (solo librería estándar).

Respeta los rate limits de la aplicación (cabeceras X-App-Rate-Limit), reintenta
ante 429/5xx y separa los límites por host, que es como Riot los aplica
(cada plataforma y cada enrutado regional tiene su propio contador).
"""

from __future__ import annotations

import json
import os
import threading
import time
from collections import deque
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

# Plataforma -> enrutado regional usado por match-v1.
PLATFORM_REGION = {
    "na1": "americas", "br1": "americas", "la1": "americas", "la2": "americas",
    "euw1": "europe", "eun1": "europe", "tr1": "europe", "ru": "europe", "me1": "europe",
    "kr": "asia", "jp1": "asia",
    "oc1": "sea", "ph2": "sea", "sg2": "sea", "th2": "sea", "tw2": "sea", "vn2": "sea",
}

TIER_ORDER = {"challenger": 0, "grandmaster": 1, "master": 2}

# Límites de una clave personal/de desarrollo; se sustituyen por los que
# devuelva la API en la primera respuesta.
DEFAULT_LIMITS = [(20, 1.0), (100, 120.0)]


class RiotAuthError(RuntimeError):
    pass


class RateLimiter:
    def __init__(self, limits):
        self.limits = list(limits)
        self.history: deque[float] = deque()
        self.lock = threading.Lock()

    def set_limits(self, limits):
        with self.lock:
            self.limits = list(limits)

    def acquire(self):
        while True:
            with self.lock:
                now = time.monotonic()
                longest = max(w for _, w in self.limits)
                while self.history and now - self.history[0] > longest:
                    self.history.popleft()
                wait = 0.0
                for count, window in self.limits:
                    recent = [t for t in self.history if now - t < window]
                    if len(recent) >= count:
                        wait = max(wait, window - (now - recent[-count]) + 0.05)
                if wait <= 0:
                    self.history.append(now)
                    return
            time.sleep(wait)


def parse_limits(header: str | None, margin: float = 0.9):
    """'20:1,100:120' -> [(18, 1.0), (90, 120.0)] (con margen de seguridad)."""
    if not header:
        return None
    limits = []
    for part in header.split(","):
        try:
            count, window = part.split(":")
            limits.append((max(1, int(int(count) * margin)), float(window)))
        except ValueError:
            continue
    return limits or None


class RiotClient:
    def __init__(self, api_key: str, base: str | None = None, log=print):
        self.api_key = api_key
        # Permite apuntar a un servidor simulado en los tests.
        self.base = base or os.environ.get("RIOT_API_BASE", "https://{host}.api.riotgames.com")
        self.log = log
        self._limiters: dict[str, RateLimiter] = {}
        self._lock = threading.Lock()
        self.requests = 0

    def _limiter(self, host: str) -> RateLimiter:
        with self._lock:
            if host not in self._limiters:
                self._limiters[host] = RateLimiter(DEFAULT_LIMITS)
            return self._limiters[host]

    def get(self, host: str, path: str, params: dict | None = None):
        url = self.base.format(host=host) + path
        if params:
            url += "?" + urlencode(params)
        limiter = self._limiter(host)
        for attempt in range(6):
            limiter.acquire()
            req = Request(url, headers={"X-Riot-Token": self.api_key, "User-Agent": "tft-meta-personal/1.0"})
            try:
                with urlopen(req, timeout=30) as resp:
                    self.requests += 1
                    limits = parse_limits(resp.headers.get("X-App-Rate-Limit"))
                    if limits and limits != limiter.limits:
                        limiter.set_limits(limits)
                    return json.loads(resp.read().decode("utf-8"))
            except HTTPError as err:
                self.requests += 1
                if err.code == 404:
                    return None
                if err.code in (401, 403):
                    raise RiotAuthError(
                        f"La API de Riot respondió {err.code}: la clave RIOT_API_KEY no es válida o ha caducado "
                        "(las claves de desarrollo caducan cada 24 h)."
                    ) from err
                if err.code == 429:
                    retry = float(err.headers.get("Retry-After") or 0) or 5.0 * (attempt + 1)
                    self.log(f"  429 en {host}; esperando {retry:.0f}s")
                    time.sleep(retry)
                    continue
                if 500 <= err.code < 600:
                    time.sleep(2 ** attempt)
                    continue
                raise
            except (URLError, TimeoutError, ConnectionError) as err:
                self.log(f"  error de red en {host}: {err}; reintentando")
                time.sleep(2 ** attempt)
        raise RuntimeError(f"No se pudo obtener {url} tras varios intentos")

    # --- Endpoints -----------------------------------------------------------

    def league(self, platform: str, tier: str):
        data = self.get(platform, f"/tft/league/v1/{tier}", {"queue": "RANKED_TFT"}) or {}
        return data.get("entries", [])

    def puuid_for_summoner(self, platform: str, summoner_id: str):
        data = self.get(platform, f"/tft/summoner/v1/summoners/{summoner_id}") or {}
        return data.get("puuid")

    def match_ids(self, region: str, puuid: str, count: int, start_time: int | None):
        params = {"start": 0, "count": count}
        if start_time:
            params["startTime"] = start_time
        return self.get(region, f"/tft/match/v1/matches/by-puuid/{puuid}/ids", params) or []

    def match(self, region: str, match_id: str):
        return self.get(region, f"/tft/match/v1/matches/{match_id}")


def top_players(client: RiotClient, platform: str, tiers: list[str], limit: int, log=print) -> list[str]:
    """PUUIDs de los mejores jugadores de la plataforma, ordenados por liga y LP."""
    entries = []
    for tier in tiers:
        for e in client.league(platform, tier):
            e["_tier"] = TIER_ORDER.get(tier, 9)
            entries.append(e)
        # Si con las ligas superiores ya hay suficientes jugadores no hace falta bajar más.
        if len(entries) >= limit:
            break
    entries.sort(key=lambda e: (e["_tier"], -e.get("leaguePoints", 0)))
    puuids = []
    for e in entries[:limit]:
        puuid = e.get("puuid")
        if not puuid and e.get("summonerId"):
            puuid = client.puuid_for_summoner(platform, e["summonerId"])
        if puuid:
            puuids.append(puuid)
    log(f"  {platform}: {len(puuids)} jugadores de {', '.join(tiers)}")
    return puuids


def collect_platform(client: RiotClient, platform: str, cfg: dict, known: set[str], log=print):
    """Descarga partidas nuevas de los mejores jugadores de una plataforma."""
    region = PLATFORM_REGION[platform]
    puuids = top_players(client, platform, cfg["tiers"], cfg["players"], log)
    start_time = int(time.time() - cfg["lookback_days"] * 86400)
    per_player = []
    for puuid in puuids:
        per_player.append(client.match_ids(region, puuid, cfg["matches_per_player"], start_time))
    # Intercalamos jugadores para que el límite de partidas nuevas no se lo
    # lleve entero quien más juega.
    new_ids, seen = [], set(known)
    depth = max((len(ids) for ids in per_player), default=0)
    for i in range(depth):
        for ids in per_player:
            if i < len(ids) and ids[i] not in seen:
                seen.add(ids[i])
                new_ids.append(ids[i])
    new_ids = new_ids[: cfg["max_new_matches"]]
    log(f"  {platform}: {len(new_ids)} partidas nuevas por descargar")
    matches = []
    for n, match_id in enumerate(new_ids, 1):
        m = client.match(region, match_id)
        if m:
            matches.append(m)
        if n % 50 == 0:
            log(f"  {platform}: {n}/{len(new_ids)}")
    return matches
