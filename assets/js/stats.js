// Estadística y probabilidad para el meta de TFT. Funciones puras (sin DOM),
// para poder probarlas con Node: `node --test tests/*.test.mjs`.

export const PRIOR_MEAN = 4.5; // posición media de una composición cualquiera
export const PLACEMENT_VAR = 5.25; // varianza de una posición uniforme 1..8

/** Resumen de un histograma de posiciones [n1º, n2º, …, n8º]. */
export function summarize(placements) {
  let n = 0, sum = 0, sq = 0;
  placements.forEach((c, i) => { n += c; sum += c * (i + 1); sq += c * (i + 1) ** 2; });
  const mean = n ? sum / n : NaN;
  const variance = n > 1 ? (sq - n * mean * mean) / (n - 1) : PLACEMENT_VAR;
  const top4 = placements.slice(0, 4).reduce((a, b) => a + b, 0);
  return { n, sum, mean, variance, top4, win: placements[0] || 0 };
}

/**
 * Media bayesiana (modelo normal-normal): la media observada se "encoge" hacia
 * 4,5 con la fuerza de `k` partidas imaginarias. Con pocas partidas manda el
 * prior; con muchas, los datos.
 */
export function posterior(placements, k = 25) {
  const s = summarize(placements);
  const n = s.n;
  const variance = Number.isFinite(s.variance) && s.variance > 0 ? s.variance : PLACEMENT_VAR;
  const mean = (s.sum + k * PRIOR_MEAN) / (n + k);
  const sd = Math.sqrt(variance / (n + k));
  return { mean, sd, lo: mean - 1.96 * sd, hi: mean + 1.96 * sd, raw: s.mean, n };
}

/** Media bayesiana a partir de suma y n (unidades, objetos...). */
export function shrunkMean(sum, n, k = 25, prior = PRIOR_MEAN) {
  return (sum + k * prior) / (n + k);
}

/** Función de distribución de la normal estándar (Abramowitz-Stegun 7.1.26). */
export function normalCdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Probabilidad (a posteriori) de que la media real sea mejor (menor) que `threshold`. */
export function probBetterThan(placements, k = 25, threshold = PRIOR_MEAN) {
  const p = posterior(placements, k);
  return normalCdf((threshold - p.mean) / p.sd);
}

/** Intervalo de Wilson al 95% para una proporción. */
export function wilson(successes, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/**
 * LP esperados por partida. Posterior de Dirichlet sobre las 8 posiciones con
 * prior uniforme de fuerza k: p_i = (c_i + k/8) / (n + k).
 */
export function expectedLP(placements, lpTable, k = 25) {
  const n = placements.reduce((a, b) => a + b, 0);
  return placements.reduce((acc, c, i) => acc + ((c + k / 8) / (n + k)) * lpTable[i], 0);
}

export function tierFor(adjMean, tiers) {
  for (const t of tiers) if (adjMean <= t.maxAvg) return t.tier;
  return tiers[tiers.length - 1].tier;
}

/** Todas las métricas de una composición. */
export function compStats(comp, { k = 25, lpTable, tiers, totalBoards }) {
  const s = summarize(comp.placements);
  const post = posterior(comp.placements, k);
  const top4CI = wilson(s.top4, s.n);
  const winCI = wilson(s.win, s.n);
  const c = comp.contested || {};
  return {
    n: s.n,
    mean: s.mean,
    adj: post.mean,
    adjLo: post.lo,
    adjHi: post.hi,
    top4: s.top4 / s.n,
    top4CI,
    top4Adj: (s.top4 + k * 0.5) / (s.n + k),
    win: s.win / s.n,
    winCI,
    winAdj: (s.win + k * 0.125) / (s.n + k),
    pickRate: totalBoards ? s.n / totalBoards : 0,
    pBetter: probBetterThan(comp.placements, k),
    lp: expectedLP(comp.placements, lpTable, k),
    tier: tierFor(post.mean, tiers),
    contestedRate: c.n + c.free_n ? c.n / (c.n + c.free_n) : null,
    contestedAvg: c.n ? shrunkMean(c.ps, c.n, k) : null,
    freeAvg: c.free_n ? shrunkMean(c.free_ps, c.free_n, k) : null,
  };
}

// --- Probabilidades de tienda --------------------------------------------------

/**
 * Cadena de Markov sobre las copias conseguidas durante un roll down.
 *
 * Cada casilla de la tienda (5 por tienda) elige primero un coste según las
 * probabilidades del nivel y después una copia al azar del pool de ese coste.
 * Cada copia comprada sale del pool (el objetivo y el total del coste bajan).
 *
 * @returns {{cdf:number[], expectedShops:number, possible:boolean}}
 *   cdf[s] = probabilidad de tener ya `need` copias tras s tiendas.
 */
export function rollChain({ costOdds, copies, champions, owned = 0, othersTaken = 0, sameCostTaken = 0, need, maxShops = 400, slots = 5 }) {
  const q = costOdds / 100;
  const target = copies - owned - othersTaken;
  const tier = copies * champions - owned - othersTaken - sameCostTaken;
  const cdf = new Array(maxShops + 1).fill(0);
  if (need <= 0) return { cdf: cdf.fill(1), expectedShops: 0, possible: true };
  if (target < need || q <= 0 || tier <= 0) return { cdf, expectedShops: Infinity, possible: false };

  const hit = [];
  for (let k = 0; k < need; k++) hit.push(q * Math.max(0, target - k) / Math.max(1, tier - k));

  let state = new Array(need + 1).fill(0);
  state[0] = 1;
  let expectedShops = 0;
  for (let s = 1; s <= maxShops; s++) {
    expectedShops += 1 - state[need];
    for (let slot = 0; slot < slots; slot++) {
      const next = new Array(need + 1).fill(0);
      next[need] = state[need];
      for (let k = 0; k < need; k++) {
        next[k] += state[k] * (1 - hit[k]);
        next[k + 1] += state[k] * hit[k];
      }
      state = next;
    }
    cdf[s] = state[need];
  }
  return { cdf, expectedShops, possible: true };
}

/** Probabilidad de conseguirlo gastando como mucho `gold` (tiradas + compras). */
export function probWithGold(chain, gold, cost, need, rerollCost = 2) {
  if (!chain.possible) return 0;
  if (need <= 0) return 1;
  const shops = Math.floor((gold - cost * need) / rerollCost);
  if (shops < 0) return 0;
  return chain.cdf[Math.min(shops, chain.cdf.length - 1)];
}

/** Oro mínimo para alcanzar una probabilidad dada (null si no se alcanza). */
export function goldForProb(chain, p, cost, need, rerollCost = 2) {
  if (!chain.possible) return null;
  if (need <= 0) return 0;
  const s = chain.cdf.findIndex((v) => v >= p);
  return s < 0 ? null : s * rerollCost + cost * need;
}
