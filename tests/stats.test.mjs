// Pruebas de assets/js/stats.js — ejecutar con: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  summarize, posterior, normalCdf, wilson, expectedLP, probBetterThan,
  rollChain, probWithGold, goldForProb, tierFor, compStats,
} from '../assets/js/stats.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} ≉ ${b} (±${tol})`);

test('summarize calcula media, top 4 y victorias', () => {
  const s = summarize([10, 10, 10, 10, 10, 10, 10, 10]);
  assert.equal(s.n, 80);
  close(s.mean, 4.5, 1e-9);
  assert.equal(s.top4, 40);
  assert.equal(s.win, 10);
});

test('normalCdf coincide con valores de tabla', () => {
  close(normalCdf(0), 0.5, 1e-6);
  close(normalCdf(1.96), 0.975, 1e-3);
  close(normalCdf(-1), 0.1587, 1e-3);
});

test('wilson: intervalo conocido (8 de 10)', () => {
  const [lo, hi] = wilson(8, 10);
  close(lo, 0.4902, 1e-3);
  close(hi, 0.9433, 1e-3);
});

test('posterior encoge hacia 4,5 con pocas partidas y no con muchas', () => {
  const few = posterior([3, 0, 0, 0, 0, 0, 0, 0], 25); // 3 victorias
  assert.ok(few.mean > 4.0, 'con 3 partidas no puede ser S');
  const many = posterior([300, 0, 0, 0, 0, 0, 0, 0], 25);
  assert.ok(many.mean < 1.5);
  assert.ok(many.sd < few.sd);
});

test('probBetterThan: una comp claramente buena tiene probabilidad alta', () => {
  const good = [60, 55, 50, 45, 30, 25, 20, 15];
  const bad = [15, 20, 25, 30, 45, 50, 55, 60];
  assert.ok(probBetterThan(good) > 0.99);
  assert.ok(probBetterThan(bad) < 0.01);
});

test('LP esperados: una comp media ronda 0', () => {
  close(expectedLP([10, 10, 10, 10, 10, 10, 10, 10], [40, 30, 20, 10, -10, -20, -30, -40]), 0, 1e-9);
});

test('tierFor y compStats', () => {
  const tiers = [{ tier: 'S', maxAvg: 4.1 }, { tier: 'A', maxAvg: 4.3 }, { tier: 'D', maxAvg: 99 }];
  assert.equal(tierFor(3.9, tiers), 'S');
  assert.equal(tierFor(4.2, tiers), 'A');
  assert.equal(tierFor(6, tiers), 'D');
  const st = compStats(
    { placements: [60, 55, 50, 45, 30, 25, 20, 15], contested: { n: 100, ps: 450, free_n: 200, free_ps: 780 } },
    { k: 25, lpTable: [40, 30, 20, 10, -10, -20, -30, -40], tiers, totalBoards: 3000 },
  );
  assert.equal(st.n, 300);
  close(st.pickRate, 0.1, 1e-9);
  close(st.contestedRate, 1 / 3, 1e-9);
  assert.ok(st.contestedAvg > st.freeAvg);
});

// Simulación directa de tiendas para validar la cadena de Markov.
function simulate({ odds, copies, champions, owned, othersTaken, sameCostTaken, need, cost }, shops, runs, seed = 1) {
  let x = seed;
  const rand = () => ((x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296);
  let hits = 0;
  for (let r = 0; r < runs; r++) {
    let target = copies - owned - othersTaken;
    let tier = copies * champions - owned - othersTaken - sameCostTaken;
    let got = 0;
    for (let s = 0; s < shops && got < need; s++) {
      for (let slot = 0; slot < 5 && got < need; slot++) {
        let u = rand() * 100, c = 0;
        while (c < 4 && u >= odds[c]) { u -= odds[c]; c++; }
        if (c !== cost - 1) continue;
        if (rand() < target / tier) { got++; target--; tier--; }
      }
    }
    if (got >= need) hits++;
  }
  return hits / runs;
}

test('rollChain coincide con una simulación Monte Carlo', () => {
  const odds = [19, 30, 40, 10, 1]; // nivel 7
  const params = { copies: 18, champions: 13, owned: 3, othersTaken: 2, sameCostTaken: 20, need: 6, cost: 3 };
  const chain = rollChain({ costOdds: odds[2], ...params });
  for (const shops of [5, 15, 30]) {
    const sim = simulate({ odds, ...params }, shops, 40000);
    close(chain.cdf[shops], sim, 0.015, `tras ${shops} tiendas`);
  }
});

test('rollChain: imposible si no quedan copias suficientes', () => {
  const chain = rollChain({ costOdds: 22, copies: 10, champions: 12, owned: 2, othersTaken: 7, need: 3 });
  assert.equal(chain.possible, false);
  assert.equal(probWithGold(chain, 500, 4, 3), 0);
});

test('probWithGold y goldForProb son coherentes', () => {
  const chain = rollChain({ costOdds: 22, copies: 10, champions: 12, owned: 1, need: 2 });
  const g50 = goldForProb(chain, 0.5, 4, 2);
  assert.ok(g50 > 8);
  assert.ok(probWithGold(chain, g50, 4, 2) >= 0.5);
  assert.ok(probWithGold(chain, g50 - 2, 4, 2) < 0.5);
  assert.equal(probWithGold(chain, 7, 4, 2), 0, 'ni siquiera da para comprar las copias');
});
