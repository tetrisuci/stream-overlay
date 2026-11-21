// Double-elimination bracket: generator, result evaluator and renderer.
//
//   const bracket = buildBracket(11);                           // structure only, any player count >= 2
//   const result  = evaluateBracket(bracket, names, results, 2); // who plays whom, given the scores so far
//   renderBracket(host, bracket, result);                        // draws it, returns { width, height }
//
// Match ids: W<round>-<n> winners bracket, L<round>-<n> losers bracket, GF1 grand final, GF2 bracket reset.
// Results are { "W1-1": [scoreA, scoreB], ... }; slot A is the higher seed in round 1.

// ---------------------------------------------------------------- generator

// Standard seeding order for a bracket of `size` slots: [1, size, ...] so seeds 1 and 2 can only meet in the final.
function seedOrder(size) {
  let order = [1, 2];
  while (order.length < size) {
    const next = order.length * 2;
    order = order.flatMap((seed) => [seed, next + 1 - seed]);
  }
  return order;
}

// Which winners-bracket match's loser drops into losers match `i` of drop-in round `drop` (1 = losers
// of winners round 2), when that round has `n` matches. Challonge cycles through four orders:
// reversed, each half reversed, halves swapped, unchanged, then repeats. Checked against Challonge's
// own 16, 32, 64 and 128 player brackets; brackets with byes use the same layout with bye matches hidden.
function dropOrder(drop, n, i) {
  const h = n / 2;
  switch ((drop - 1) % 4) {
    case 0: return n - 1 - i;
    case 1: return n < 2 ? i : Math.floor(i / h) * h + (h - 1 - (i % h));
    case 2: return n < 2 ? i : (i + h) % n;
    default: return i;
  }
}

function buildBracket(count) {
  const size = Math.max(2, 2 ** Math.ceil(Math.log2(Math.max(count, 2))));
  const k = Math.log2(size); // winners bracket rounds
  const matches = [];
  const byId = {};
  const add = (match) => { matches.push(match); byId[match.id] = match; };
  const seed = (n) => ({ type: "seed", seed: n });
  const winner = (id) => ({ type: "winner", match: id });
  const loser = (id) => ({ type: "loser", match: id });
  const id = (prefix, round, index) => `${prefix}${round}-${index + 1}`;
  const order = seedOrder(size);

  // Winners bracket.
  for (let r = 1; r <= k; r++) {
    for (let i = 0; i < size / 2 ** r; i++) {
      add({
        id: id("W", r, i), bracket: "W", round: r, index: i,
        a: r === 1 ? seed(order[2 * i]) : winner(id("W", r - 1, 2 * i)),
        b: r === 1 ? seed(order[2 * i + 1]) : winner(id("W", r - 1, 2 * i + 1)),
      });
    }
  }

  // Losers bracket: odd rounds pair up survivors, even rounds bring in the losers of winners round (t/2 + 1).
  // Dropping players are shuffled the same way Challonge does it, to keep rematches apart. See dropOrder.
  const lbRounds = k >= 2 ? 2 * (k - 1) : 0;
  for (let t = 1; t <= lbRounds; t++) {
    const j = Math.ceil(t / 2);
    for (let i = 0; i < size / 2 ** (j + 1); i++) {
      let a, b;
      if (t === 1) {
        a = loser(id("W", 1, 2 * i));
        b = loser(id("W", 1, 2 * i + 1));
      } else if (t % 2 === 0) {
        a = winner(id("L", t - 1, i));
        b = loser(id("W", j + 1, dropOrder(j, size / 2 ** (j + 1), i)));
      } else {
        a = winner(id("L", t - 1, 2 * i));
        b = winner(id("L", t - 1, 2 * i + 1));
      }
      add({ id: id("L", t, i), bracket: "L", round: t, index: i, a, b });
    }
  }

  // Grand final, plus a reset match that only exists if the losers-bracket player wins the first one.
  const lbFinal = lbRounds ? winner(id("L", lbRounds, 0)) : loser(id("W", k, 0));
  add({ id: "GF1", bracket: "G", round: 1, index: 0, a: winner(id("W", k, 0)), b: lbFinal });
  add({ id: "GF2", bracket: "G", round: 2, index: 0,
    a: { type: "same", match: "GF1", side: "a" }, b: { type: "same", match: "GF1", side: "b" } });

  // Depth = how many matches deep a match is; used to play matches in a sensible order when simulating.
  const depth = {};
  const depthOf = (m) => depth[m.id] ??= 1 + Math.max(0, ...[m.a, m.b].filter((s) => s.match).map((s) => depthOf(byId[s.match])));
  matches.forEach(depthOf);
  matches.forEach((m) => { m.depth = depth[m.id]; });

  return { size, k, lbRounds, matches, byId };
}

// ---------------------------------------------------------------- evaluator

const BYE = { kind: "bye" };

// Works out, for every match, who is in each slot and who won, from the scores entered so far.
// names: player names in seed order. results: { matchId: [scoreA, scoreB] }.
// firstTo: score that wins a match (e.g. 2 for best of 3); null means the higher score wins once scores differ.
function evaluateBracket(bracket, names, results = {}, firstTo = null) {
  const state = {};

  function slotValue(slot) {
    if (slot.type === "seed") {
      return slot.seed <= names.length ? { kind: "player", name: names[slot.seed - 1], seed: slot.seed } : BYE;
    }
    const source = visit(slot.match);
    if (slot.type === "same") return source[slot.side];
    return slot.type === "winner" ? source.winner : source.loser;
  }

  function visit(id) {
    if (state[id]) return state[id];
    const match = bracket.byId[id];
    const s = (state[id] = { id, a: null, b: null, winner: null, loser: null, scores: null, bye: false, inactive: false });
    s.a = slotValue(match.a);
    s.b = slotValue(match.b);
    const tbd = (label) => ({ kind: "tbd", label });

    if (s.a.kind === "bye" || s.b.kind === "bye") {
      // A bye: the other player advances without playing, and nobody drops to the losers bracket.
      s.bye = true;
      s.winner = s.a.kind === "bye" ? s.b : s.a;
      s.loser = BYE;
    } else if (s.a.kind === "player" && s.b.kind === "player") {
      const entered = results[id];
      s.winner = tbd(`Winner of ${id}`);
      s.loser = tbd(`Loser of ${id}`);
      if (Array.isArray(entered) && entered.every((n) => Number.isFinite(n))) {
        s.scores = entered;
        const [x, y] = entered;
        const aWins = firstTo ? x >= firstTo && x > y : x > y;
        const bWins = firstTo ? y >= firstTo && y > x : y > x;
        if (aWins || bWins) {
          s.winner = aWins ? s.a : s.b;
          s.loser = aWins ? s.b : s.a;
        }
      }
    } else {
      s.winner = tbd(`Winner of ${id}`);
      s.loser = tbd(`Loser of ${id}`);
    }
    return s;
  }

  bracket.matches.forEach((m) => visit(m.id));

  // The reset match is only on the board once the losers-bracket player has won the grand final.
  const gf1 = state.GF1;
  const resetNeeded = gf1.winner.kind === "player" && gf1.winner === gf1.b;
  state.GF2.inactive = !resetNeeded && !results.GF2;

  let champion = null;
  if (gf1.winner.kind === "player") {
    if (gf1.winner === gf1.a) champion = gf1.winner;
    else if (state.GF2.winner.kind === "player") champion = state.GF2.winner;
  }
  return { state, champion };
}

// Plays out the bracket with the better seed usually winning, and returns results for the first
// `fraction` (0-1) of the matches played. Handy for previewing a bracket at different stages.
function simulateResults(bracket, names, fraction = 1, firstTo = 2, rngSeed = 7) {
  let rng = rngSeed;
  const random = () => {
    rng = (rng + 0x6d2b79f5) | 0;
    let t = Math.imul(rng ^ (rng >>> 15), 1 | rng);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const order = [...bracket.matches].sort((x, y) => x.depth - y.depth);
  const results = {};
  const played = [];
  for (;;) {
    const { state } = evaluateBracket(bracket, names, results, firstTo);
    const next = order.find((m) => {
      const s = state[m.id];
      return !s.bye && !s.inactive && !results[m.id] && s.a.kind === "player" && s.b.kind === "player";
    });
    if (!next) break;
    const s = state[next.id];
    const aFavored = s.a.seed < s.b.seed;
    const aWins = random() < (aFavored ? 0.75 : 0.25);
    const loserScore = Math.floor(random() * firstTo);
    results[next.id] = aWins ? [firstTo, loserScore] : [loserScore, firstTo];
    played.push(next.id);
  }
  const keep = new Set(played.slice(0, Math.round(played.length * fraction)));
  return Object.fromEntries(Object.entries(results).filter(([id]) => keep.has(id)));
}

// ---------------------------------------------------------------- layout + renderer

const BRACKET_DIMS = (() => {
  const d = { rowH: 30, border: 3, divider: 2, scoreW: 40, boxW: 232, gapX: 48, gapY: 10, labelH: 26, sectionGap: 34 };
  d.matchH = d.rowH * 2 + d.border * 2 + d.divider;
  d.pitch = d.matchH + d.gapY;
  d.colW = d.boxW + d.gapX;
  d.slotMid = [d.border + d.rowH / 2, d.border + d.rowH + d.divider + d.rowH / 2]; // y of each row's centre in a box
  return d;
})();

// Where every match goes: winners bracket on top, losers bracket below, grand final on the right.
// Losers rounds made up entirely of byes are skipped so their column doesn't sit empty.
function layoutBracket(bracket, state) {
  const D = BRACKET_DIMS;
  const { size, k, lbRounds } = bracket;
  const pos = {};
  const labels = [];

  const yW = {};
  for (let r = 1; r <= k; r++) {
    yW[r] = [];
    for (let i = 0; i < size / 2 ** r; i++) {
      yW[r][i] = r === 1 ? D.labelH + i * D.pitch : (yW[r - 1][2 * i] + yW[r - 1][2 * i + 1]) / 2;
      pos[`W${r}-${i + 1}`] = { x: (r - 1) * D.colW, y: yW[r][i] };
    }
    labels.push({ x: (r - 1) * D.colW, y: 0, text: r === k ? "Winners Final" : `Winners Round ${r}`, ids: matchIds("W", r, size / 2 ** r) });
  }

  const wbBottom = D.labelH + (size / 2) * D.pitch - D.gapY;
  const lbTop = wbBottom + D.sectionGap + D.labelH;
  const yL = {};
  let lbColumns = 0;
  for (let t = 1; t <= lbRounds; t++) {
    const n = size / 2 ** (Math.ceil(t / 2) + 1);
    const ids = matchIds("L", t, n);
    const col = ids.some((id) => !state[id].bye) ? lbColumns++ : 0;
    yL[t] = [];
    for (let i = 0; i < n; i++) {
      yL[t][i] = t === 1 ? lbTop + i * D.pitch : t % 2 === 0 ? yL[t - 1][i] : (yL[t - 1][2 * i] + yL[t - 1][2 * i + 1]) / 2;
      pos[`L${t}-${i + 1}`] = { x: col * D.colW, y: yL[t][i] };
    }
    labels.push({ x: col * D.colW, y: lbTop - D.labelH, text: t === lbRounds ? "Losers Final" : `Losers Round ${col + 1}`, ids });
  }

  const gfCol = Math.max(k, lbColumns);
  const wbMid = yW[k][0] + D.matchH / 2;
  const gfMid = lbRounds ? (wbMid + yL[lbRounds][0] + D.matchH / 2) / 2 : wbMid;
  const gfY = gfMid - D.matchH / 2;
  pos.GF1 = { x: gfCol * D.colW, y: gfY };
  pos.GF2 = { x: (gfCol + 1) * D.colW, y: gfY };
  labels.push({ x: gfCol * D.colW, y: gfY - D.labelH, text: "Grand Final", ids: ["GF1"] });
  labels.push({ x: (gfCol + 1) * D.colW, y: gfY - D.labelH, text: "Bracket Reset", ids: ["GF2"] });
  const champion = { x: gfCol * D.colW, y: gfY + D.matchH + 26 };

  const bottom = Math.max(lbRounds ? lbTop + (size / 4) * D.pitch - D.gapY : wbBottom, champion.y + D.matchH);
  return { pos, labels, champion, width: (gfCol + 2) * D.colW - D.gapX, height: bottom };

  function matchIds(prefix, round, count) {
    return Array.from({ length: count }, (_, i) => `${prefix}${round}-${i + 1}`);
  }
}

// Draws the bracket into `host` at its natural size and returns { width, height } so the caller can scale it.
function renderBracket(host, bracket, evaluation) {
  const D = BRACKET_DIMS;
  const { state, champion } = evaluation;
  const layout = layoutBracket(bracket, state);
  const shown = (id) => !state[id].bye && !state[id].inactive;
  host.replaceChildren();
  host.style.width = `${layout.width}px`;
  host.style.height = `${layout.height}px`;

  // Connector lines go in an SVG underneath the match boxes: a dark halo, then the white line.
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("class", "bracket-lines");
  svg.setAttribute("width", layout.width);
  svg.setAttribute("height", layout.height);
  const halo = document.createElementNS(svgNS, "path");
  const line = document.createElementNS(svgNS, "path");
  halo.setAttribute("class", "bracket-line-halo");
  line.setAttribute("class", "bracket-line");
  const segments = [];
  for (const match of bracket.matches) {
    if (!shown(match.id)) continue;
    [["a", 0], ["b", 1]].forEach(([side, row]) => {
      const slot = match[side];
      if (!slot.match || slot.type === "loser" || !shown(slot.match)) return;
      const from = layout.pos[slot.match];
      const to = layout.pos[match.id];
      const x1 = from.x + D.boxW;
      const y1 = from.y + D.matchH / 2;
      const x2 = to.x;
      const y2 = to.y + (slot.type === "same" ? D.matchH / 2 : D.slotMid[row]);
      segments.push(`M ${x1} ${y1} H ${x2 - D.gapX / 2} V ${y2} H ${x2}`);
    });
  }
  halo.setAttribute("d", segments.join(" "));
  line.setAttribute("d", segments.join(" "));
  svg.append(halo, line);
  host.append(svg);

  for (const label of layout.labels) {
    if (!label.ids.some(shown)) continue;
    const el = document.createElement("div");
    el.className = "round-label";
    el.style.left = `${label.x}px`;
    el.style.top = `${label.y}px`;
    el.style.width = `${D.boxW}px`;
    el.textContent = label.text;
    host.append(el);
  }

  for (const match of bracket.matches) {
    if (!shown(match.id)) continue;
    const s = state[match.id];
    const box = document.createElement("div");
    box.className = "match";
    box.dataset.match = match.id;
    box.style.left = `${layout.pos[match.id].x}px`;
    box.style.top = `${layout.pos[match.id].y}px`;
    [[s.a, 0], [s.b, 1]].forEach(([player, row]) => {
      const slot = document.createElement("div");
      slot.className = "slot";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = player.kind === "player" ? player.name : player.label;
      const score = document.createElement("span");
      score.className = "score";
      score.textContent = s.scores ? s.scores[row] : "";
      if (player.kind === "tbd") slot.classList.add("is-tbd");
      if (s.winner === player) slot.classList.add("is-winner");
      else if (s.loser === player) slot.classList.add("is-loser");
      slot.append(name, score);
      box.append(slot);
    });
    host.append(box);
  }

  if (champion) {
    const box = document.createElement("div");
    box.className = "champion";
    box.style.left = `${layout.champion.x}px`;
    box.style.top = `${layout.champion.y}px`;
    const title = document.createElement("span");
    title.className = "champion-title";
    title.textContent = "Champion";
    const name = document.createElement("span");
    name.className = "champion-name";
    name.textContent = champion.name;
    box.append(title, name);
    host.append(box);
  }

  return { width: layout.width, height: layout.height };
}
