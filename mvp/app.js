const NS = "http://www.w3.org/2000/svg";

function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
function txt(parent, x, y, str, cls = "", anchor = "middle") {
  const t = el("text", { x, y, class: cls, "text-anchor": anchor }, parent);
  t.textContent = str;
  return t;
}
function arrowDefs(svg, id, cls) {
  const m = el("marker", { id, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, el("defs", {}, svg));
  el("path", { d: "M0 0 L10 5 L0 10 z", class: cls }, m);
}
// Point where the ray from a box centre toward (tx, ty) leaves the box.
function edge(c, w, h, tx, ty) {
  const dx = tx - c.x, dy = ty - c.y;
  const s = Math.min(w / 2 / Math.abs(dx || 1e-6), h / 2 / Math.abs(dy || 1e-6));
  return { x: c.x + dx * s, y: c.y + dy * s };
}

// Shared geometry: conductor in the middle, five workers on an ellipse around it.
const C = { x: 320, y: 240 };
const CORE = { w: 200, h: 100 };
const BOX = { w: 192, h: 118 };
const SLOTS = 10;
const WORKERS = ["Q-02", "Q-03", "Q-04", "Q-05", "Q-06"];
const POS = [-90, -18, 54, 126, 198].map((a) => ({
  x: C.x + 222 * Math.cos((a * Math.PI) / 180),
  y: C.y + 172 * Math.sin((a * Math.PI) / 180),
}));
function spoke(svg, p, cls, marker) {
  const a = edge(C, CORE.w, CORE.h, p.x, p.y), b = edge(p, BOX.w, BOX.h, C.x, C.y);
  return el("path", { d: `M${a.x} ${a.y} L${b.x} ${b.y}`, class: cls, "marker-end": marker ? `url(#${marker})` : "" }, svg);
}
function box(g, p, size, cls = "box") {
  return el("rect", { x: p.x - size.w / 2, y: p.y - size.h / 2, width: size.w, height: size.h, rx: 6, class: cls }, g);
}

/* ---------- delegation (static) ---------- */
{
  const svg = document.getElementById("delegation");
  arrowDefs(svg, "a1", "arrow");
  const jobs = {
    "Q-02": [["SLACK", "T01"], ["NOTION", "T04"]],
    "Q-03": [["SUMMARIZE", "T01"], ["waiting on Q-02", ""]],
    "Q-04": [["SLACK", "T03"], ["GITHUB", "T02 ✓"]],
    "Q-05": [["TESTS", "T02"], ["JIRA", "T03"]],
    "Q-06": [["NOTION", "T01"], ["MODEL", "T05"]],
  };
  POS.forEach((p) => spoke(svg, p, "spoke hot", "a1"));
  // Q-02 → Q-03 data dependency, drawn edge to edge
  const a = POS[0], b = POS[1];
  const s = { x: a.x + BOX.w / 2, y: a.y }, e = { x: b.x, y: b.y - BOX.h / 2 };
  el("path", { d: `M${s.x} ${s.y} Q${e.x} ${s.y} ${e.x} ${e.y}`, class: "dep", "marker-end": "url(#a1)" }, svg);
  txt(svg, s.x + 14, s.y - 10, "Slack result → T01", "muted", "start");

  const core = el("g", {}, svg);
  box(core, C, CORE, "box core");
  txt(core, C.x, C.y - 16, "Q-01", "muted");
  txt(core, C.x, C.y + 4, "CONDUCTOR", "big");
  txt(core, C.x, C.y + 26, "splits goals", "muted");

  WORKERS.forEach((id, i) => {
    const p = POS[i], g = el("g", {}, svg);
    box(g, p, BOX, id === "Q-03" ? "box wait" : "box");
    txt(g, p.x - BOX.w / 2 + 14, p.y - 26, id, "big", "start");
    jobs[id].forEach(([k, t], j) => {
      txt(g, p.x - BOX.w / 2 + 14, p.y + 6 + j * 24, k, j === 1 && id === "Q-03" ? "muted" : "", "start");
      txt(g, p.x + BOX.w / 2 - 14, p.y + 6 + j * 24, t, "muted", "end");
    });
  });
}

/* ---------- failover (animated) ---------- */
const svg = document.getElementById("failover");
arrowDefs(svg, "a2", "arrow-dim");
const spokes = POS.map((p) => spoke(svg, p, "spoke", "a2"));
const packets = el("g", {}, svg);

function metrics(g, x, y, w) {
  const out = {};
  ["cpu", "mem"].forEach((k, j) => {
    const yy = y + j * 22;
    txt(g, x, yy + 9, k.toUpperCase(), "muted", "start");
    el("rect", { x: x + 40, y: yy, width: w - 96, height: 9, rx: 2, class: "bar-bg" }, g);
    out[k] = el("rect", { x: x + 40, y: yy, width: 0, height: 9, rx: 2, class: `bar-fg ${k}` }, g);
    out[k + "T"] = txt(g, x + w, yy + 9, "0%", "", "end");
    out[k + "W"] = w - 96;
  });
  return out;
}

const coreG = el("g", { class: "node" }, svg);
box(coreG, C, CORE, "box core");
txt(coreG, C.x - CORE.w / 2 + 14, C.y - 24, "Q-01 CONDUCTOR", "big", "start");
const queueT = txt(svg, C.x, C.y + CORE.h / 2 + 22, "queue 0", "muted");
const coreM = metrics(coreG, C.x - CORE.w / 2 + 14, C.y - 2, CORE.w - 28);

const nodes = WORKERS.map((id, i) => {
  const p = POS[i], g = el("g", { class: "node" }, svg);
  box(g, p, BOX);
  txt(g, p.x - BOX.w / 2 + 14, p.y - 34, id, "big", "start");
  const countT = txt(g, p.x + BOX.w / 2 - 14, p.y - 34, "8 tasks", "muted", "end");
  const m = metrics(g, p.x - BOX.w / 2 + 14, p.y - 16, BOX.w - 28);
  const pips = Array.from({ length: SLOTS }, (_, k) => el("rect", { x: p.x - BOX.w / 2 + 14 + k * 16.6, y: p.y + 30, width: 12, height: 12, rx: 2, class: "pip" }, g));
  return { id, p, g, countT, m, pips, tasks: 8, state: "ok", cpu: 0, mem: 0 };
});
const core = { m: coreM, cpu: 0, mem: 0, queue: 0 };

function drawMetrics(n, cpuT, memT) {
  n.cpu += (cpuT - n.cpu) * 0.06;
  n.mem += (memT - n.mem) * 0.04;
  n.m.cpu.setAttribute("width", (n.m.cpuW * n.cpu) / 100);
  n.m.mem.setAttribute("width", (n.m.memW * n.mem) / 100);
  n.m.cpuT.textContent = cpuT === 0 && n.cpu < 1 ? "—" : Math.round(n.cpu) + "%";
  n.m.memT.textContent = memT === 0 && n.mem < 1 ? "—" : Math.round(n.mem) + "%";
}

// Moving dots. Each tween interpolates a straight line; done() fires on arrival.
const tweens = [];
function send(from, to, dur, cls, done, delay = 0) {
  const c = el("circle", { r: cls === "beat" ? 2.5 : 5, class: cls, cx: from.x, cy: from.y, opacity: 0 }, packets);
  tweens.push({ c, from, to, dur, t0: performance.now() + delay, done });
}

const logEl = document.getElementById("log");
function log(msg, bad) {
  const li = document.createElement("li");
  if (bad) li.className = "bad";
  li.innerHTML = `<span>${clock.textContent.slice(2)}</span>${msg}`;
  logEl.prepend(li);
  while (logEl.children.length > 3) logEl.lastChild.remove();
}

const clock = document.getElementById("clock");
const cRun = document.getElementById("cRun");
const cQueue = document.getElementById("cQueue");
let t0 = performance.now(), victim, fired;

const range = (i) => `T${String(i * 8 + 1).padStart(2, "0")}–T${String(i * 8 + 8).padStart(2, "0")}`;

