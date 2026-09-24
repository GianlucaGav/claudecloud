"""Pruebas del pipeline de datos: python3 -m unittest discover -s tests -v"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "tests" / "fixtures"))

import synth  # noqa: E402
from tft import analyze as an  # noqa: E402
from tft import riot  # noqa: E402
from tft import static as st  # noqa: E402

SCRIPT = ROOT / "scripts" / "update_meta.py"


def run_update(args, env_extra=None):
    env = {k: v for k, v in os.environ.items() if not k.startswith(("TFT_", "RIOT_"))}
    env.update(env_extra or {})
    return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, env=env, timeout=300)


class AnalysisTest(unittest.TestCase):
    """Con datos sintéticos se conocen los arquetipos reales: el análisis debe recuperarlos."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        tmp = Path(cls.tmp.name)
        mdir, static = synth.write(tmp / "synth", n_matches=900, seed=11)
        cls.out = tmp / "meta.json"
        res = run_update(["--matches-dir", str(mdir), "--static", str(static), "--no-fetch",
                          "--cache", str(tmp / "cache.json.gz"), "--out", str(cls.out)])
        if res.returncode != 0:
            raise AssertionError(res.stdout + res.stderr)
        cls.meta = json.loads(cls.out.read_text(encoding="utf-8"))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_estructura(self):
        m = self.meta
        self.assertEqual(m["schema"], 1)
        self.assertEqual(m["set"]["number"], synth.SET)
        self.assertEqual(m["sample"]["matches"], 900)
        self.assertEqual(m["sample"]["boards"], 7200)
        self.assertEqual(m["pool"]["championsPerCost"], {"1": 8, "2": 7, "3": 7, "4": 6, "5": 4})
        self.assertNotIn(f"TFT{synth.SET}_Totem", m["static"]["champions"], "los no jugables no entran")
        for c in m["comps"]:
            self.assertEqual(sum(c["placements"]), c["games"])
            self.assertIn(c["style"], {"reroll", "fast8", "fast9", "standard"})
            self.assertTrue(c["name"])
            self.assertLessEqual(len(c["board"]), 10)
            n = c["contested"]["n"] + c["contested"]["free_n"]
            self.assertEqual(n, c["games"])

    def test_recupera_los_arquetipos(self):
        carries = {c["carry"] for c in self.meta["comps"]}
        expected = {synth.PREFIX + a["carry"] for a in synth.ARCHETYPES}
        self.assertEqual(carries, expected)
        self.assertGreater(self.meta["sample"]["assigned"] / self.meta["sample"]["boards"], 0.9)

    def test_orden_por_fuerza(self):
        avg = {}
        for c in self.meta["comps"]:
            avg[c["carry"]] = sum((i + 1) * k for i, k in enumerate(c["placements"])) / c["games"]
        best = min(avg, key=avg.get)
        worst = max(avg, key=avg.get)
        self.assertEqual(best, synth.PREFIX + "Draco")  # fuerza 0,9
        self.assertEqual(worst, synth.PREFIX + "Roca")  # fuerza -0,8

    def test_estilos_y_objetos(self):
        by_carry = {c["carry"]: c for c in self.meta["comps"]}
        self.assertEqual(by_carry[synth.PREFIX + "Corvo"]["style"], "reroll")
        self.assertEqual(by_carry[synth.PREFIX + "Aurum"]["style"], "fast9")
        draco = by_carry[synth.PREFIX + "Draco"]
        self.assertEqual(draco["tank"], synth.PREFIX + "Roca")
        carry_items = {i["id"] for i in draco["items"][draco["carry"]]["items"]}
        self.assertTrue(carry_items <= set(synth.CARRY_ITEMS_AD), "el carry lleva objetos ofensivos")

    def test_carry_disputado_empeora(self):
        # En el generador, compartir carry penaliza: la media disputada debe ser peor.
        worse = 0
        for c in self.meta["comps"]:
            ct = c["contested"]
            if ct["n"] > 30 and ct["free_n"] > 30:
                worse += (ct["ps"] / ct["n"]) > (ct["free_ps"] / ct["free_n"])
        self.assertGreaterEqual(worse, 4)


class UnitTest(unittest.TestCase):
    def test_compact_match_sin_puuids(self):
        m = synth.generate(1, seed=1)[0]
        cm = an.compact_match(m, "euw1")
        self.assertEqual(cm["v"], "16.19")
        self.assertEqual(len(cm["b"]), 8)
        self.assertNotIn("puuid", json.dumps(cm))

    def test_select_matches_mezcla_parches_si_falta_muestra(self):
        old = [an.compact_match(m) for m in synth.generate(20, seed=2, version="16.18")]
        new = [an.compact_match(m) for m in synth.generate(10, seed=3, version="16.19")]
        for i, m in enumerate(new):
            m["id"] = f"N{i}"
        chosen, versions = an.select_matches(old + new, min_boards=80)
        self.assertEqual(versions, ["16.19"])
        chosen, versions = an.select_matches(old + new, min_boards=120)
        self.assertEqual(versions, ["16.19", "16.18"])
        self.assertEqual(len(chosen), 30)

    def test_ids_con_mayusculas_distintas(self):
        static = st.build_static(synth.cdragon_json(), synth.SET, None)
        m = an.compact_match(synth.generate(1, seed=4)[0])
        raw = m["b"][0]
        for u in raw["u"]:
            u[0] = u[0].upper()
        b = an.Board(m["id"], 0, raw, an.Canon(static), st.ItemWeights(static["items"]))
        self.assertTrue(b.units)
        self.assertTrue(all(u[0] in static["champions"] for u in b.units))

    def test_pesos_de_objetos(self):
        w = st.ItemWeights(st.build_static(synth.cdragon_json(), synth.SET, None)["items"])
        self.assertGreater(w("TFT_Item_InfinityEdge")[0], 0.8)
        self.assertEqual(w("TFT_Item_WarmogsArmor"), (0.0, 1.0))
        self.assertEqual(w(f"TFT{synth.SET}_Item_LlamaEmblemItem"), (0.0, 0.0))
        self.assertGreater(w("TFT5_Item_InfinityEdgeRadiant")[0], 0.8)

    def test_asset_url(self):
        self.assertEqual(
            st.asset_url("ASSETS/Characters/TFT18_Ahri/HUD/TFT18_Ahri_Square.TFT_Set18.tex"),
            "https://raw.communitydragon.org/latest/game/assets/characters/tft18_ahri/hud/tft18_ahri_square.tft_set18.png",
        )

    def test_parse_limits(self):
        self.assertEqual(riot.parse_limits("20:1,100:120"), [(18, 1.0), (90, 120.0)])
        self.assertIsNone(riot.parse_limits(None))


# --- Servidor que imita la API de Riot -------------------------------------------

class FakeRiot:
    def __init__(self, matches):
        self.matches = {m["metadata"]["match_id"]: m for m in matches}
        ids = list(self.matches)
        # 6 jugadores; sus historiales se solapan (misma partida en varios jugadores).
        self.history = {f"p{i}": ids[i * 3: i * 3 + 8] for i in range(6)}
        self.hits = []
        self.throttled = set()
        self.lock = threading.Lock()

    def handler(self):
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def send(self, code, body, headers=None):
                data = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("X-App-Rate-Limit", "200:1,5000:10")
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                path = self.path.split("?")[0]
                with fake.lock:
                    fake.hits.append(path)
                if self.headers.get("X-Riot-Token") != "RGAPI-test":
                    return self.send(403, {"status": {"message": "Forbidden"}})
                parts = path.strip("/").split("/")
                host, rest = parts[0], "/" + "/".join(parts[1:])
                if rest == "/tft/league/v1/challenger" and host == "euw1":
                    entries = [{"puuid": f"p{i}", "leaguePoints": 1000 - i} for i in range(4)]
                    return self.send(200, {"entries": entries})
                if rest == "/tft/league/v1/grandmaster" and host == "euw1":
                    # Formato antiguo: sin puuid, solo summonerId.
                    return self.send(200, {"entries": [{"summonerId": f"s{i}", "leaguePoints": 500 - i} for i in (4, 5)]})
                if rest.startswith("/tft/league/v1/"):
                    return self.send(200, {"entries": []})
                if rest.startswith("/tft/summoner/v1/summoners/"):
                    return self.send(200, {"puuid": "p" + rest.rsplit("/", 1)[1][1:]})
                if rest.startswith("/tft/match/v1/matches/by-puuid/") and host == "europe":
                    puuid = rest.split("/")[6]
                    return self.send(200, fake.history.get(puuid, []))
                if rest.startswith("/tft/match/v1/matches/") and host == "europe":
                    mid = rest.rsplit("/", 1)[1]
                    with fake.lock:
                        first = mid not in fake.throttled
                        fake.throttled.add(mid)
                    if first and mid.endswith("3"):
                        return self.send(429, {"status": {"message": "Rate limit exceeded"}}, {"Retry-After": "0.05"})
                    if mid in fake.matches:
                        return self.send(200, fake.matches[mid])
                return self.send(404, {"status": {"message": "Not found"}})

        return H


class RiotClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        now_ms = int(time.time() * 1000) - 3600_000
        cls.fake = FakeRiot(synth.generate(40, seed=5, start_ms=now_ms))
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), cls.fake.handler())
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}/{{host}}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        # El servidor se comparte entre tests: cada uno empieza con contadores limpios.
        with self.fake.lock:
            self.fake.hits.clear()
            self.fake.throttled.clear()

    def env(self, key="RGAPI-test"):
        return {
            "RIOT_API_KEY": key, "RIOT_API_BASE": self.base, "TFT_PLATFORMS": "euw1",
            "TFT_TIERS": "challenger,grandmaster,master", "TFT_PLAYERS_PER_PLATFORM": "10",
            "TFT_MAX_NEW_MATCHES": "100", "TFT_MIN_BOARDS": "10",
        }

    def test_descarga_completa(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            static = tmp / "cdragon.json"
            static.write_text(json.dumps(synth.cdragon_json()), encoding="utf-8")
            args = ["--static", str(static), "--cache", str(tmp / "c.json.gz"), "--out", str(tmp / "meta.json")]
            res = run_update(args, self.env())
            self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
            meta = json.loads((tmp / "meta.json").read_text(encoding="utf-8"))
            unique = {m for ids in self.fake.history.values() for m in ids}
            self.assertEqual(meta["sample"]["matches"], len(unique))
            self.assertEqual(meta["sample"]["platforms"], {"euw1": len(unique)})
            self.assertIn("429", res.stdout, "debe haber reintentado tras un 429")
            self.assertTrue(any("/summoners/s4" in h for h in self.fake.hits), "resuelve summonerId → puuid")
            # Segunda ejecución: todo está en caché, no se vuelve a pedir ninguna partida.
            before = sum(1 for h in self.fake.hits if "/matches/EUW1_" in h)
            res = run_update(args, self.env())
            self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
            after = sum(1 for h in self.fake.hits if "/matches/EUW1_" in h)
            self.assertEqual(before, after)

    def test_clave_pegada_con_comillas_y_espacios(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            static = tmp / "cdragon.json"
            static.write_text(json.dumps(synth.cdragon_json()), encoding="utf-8")
            res = run_update(["--static", str(static), "--cache", str(tmp / "c.json.gz"), "--out", str(tmp / "m.json")],
                             self.env(key=' "RGAPI-test"\n'))
            self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
            self.assertIn("formato habitual", res.stdout)

    def test_mensajes_de_error_de_clave(self):
        self.assertIn("no reconoce", riot.auth_error_message(401, "Unknown apikey"))
        self.assertIn("Unknown apikey", riot.auth_error_message(401, "Unknown apikey"))
        self.assertIn("caducado", riot.auth_error_message(403))
        self.assertIsNone(riot.key_format_warning("RGAPI-0a1b2c3d-1234-5678-9abc-def012345678"))
        self.assertIn("NO empieza", riot.key_format_warning("0a1b2c3d"))

    def test_clave_invalida(self):
        with tempfile.TemporaryDirectory() as tmp:
            res = run_update(["--cache", str(Path(tmp) / "c.json.gz"), "--out", str(Path(tmp) / "m.json")],
                             self.env(key="RGAPI-caducada"))
            self.assertNotEqual(res.returncode, 0)
            self.assertIn("RIOT_API_KEY", res.stdout)


if __name__ == "__main__":
    unittest.main()
