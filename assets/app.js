/* Spatially resolved specklegrams: page behaviour.
   Everything is drawn from window.FSS (assets/data.js) and the two images in assets/media. */
(() => {
  "use strict";
  const D = window.FSS;
  const W = D.W, H = D.H, NS = D.nSprite;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const SVGNS = "http://www.w3.org/2000/svg";

  /* ---------- Colours ---------------------------------------------------- */
  // Ordered ramp for positions 1 (next to the laser) to 10 (next to the camera).
  const RAMP = ["#24467d", "#2f8f9d", "#e3a43b", "#cf3f2e"];
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  function rampAt(stops, t) {
    const s = stops.map(hex), k = Math.min(s.length - 2, Math.floor(t * (s.length - 1)));
    return mix(s[k], s[k + 1], t * (s.length - 1) - k);
  }
  const POS_RGB = Array.from({ length: 10 }, (_, i) => rampAt(RAMP, i / 9));
  const POS = POS_RGB.map((c) => `rgb(${c.join(",")})`);
  const posColor = (k) => POS[k - 1];

  // Speckle look-up table: black, deep red, laser red, amber, warm white.
  const SPECKLE_LUT = (() => {
    const stops = ["#000000", "#5a0a0a", "#d6452e", "#f7b267", "#fff4e0"];
    return Array.from({ length: 256 }, (_, i) => rampAt(stops, i / 255));
  })();
  const DIV_LUT = (() => {
    const lo = hex("#2a6fb0"), mid = hex("#f7f8fa"), hi = hex("#c8402c");
    return Array.from({ length: 256 }, (_, i) => {
      const t = i / 255 * 2 - 1;
      return t < 0 ? mix(mid, lo, -t) : mix(mid, hi, t);
    });
  })();

  /* ---------- Helpers ---------------------------------------------------- */
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, parent) => {
    const n = document.createElementNS(SVGNS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  };
  function b64(str, Type) {
    const bin = atob(str), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Type(bytes.buffer);
  }
  function fitCanvas(c, ratio) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = c.clientWidth, h = ratio ? w * ratio : c.clientHeight;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }
  function legendList(ul, items) {
    ul.innerHTML = "";
    items.forEach(([color, text]) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="swatch" style="background:${color}"></span>${text}`;
      ul.appendChild(li);
    });
  }

  /* ---------- Specklegram sprites --------------------------------------- */
  // assets/media/specklegrams.png: one row per position, NS hits of W x H each.
  let sheet = null;
  const sheetReady = new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const rgba = ctx.getImageData(0, 0, c.width, c.height).data;
      sheet = { w: c.width, data: new Uint8Array(c.width * c.height) };
      for (let i = 0; i < sheet.data.length; i++) sheet.data[i] = rgba[i * 4];
      resolve();
    };
    img.src = "assets/media/specklegrams.png";
  });
  const spriteCache = new Map();
  function spriteImage(pos, n) {
    const key = pos * 1000 + n;
    if (spriteCache.has(key)) return spriteCache.get(key);
    const px = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const row = ((pos - 1) * H + y) * sheet.w + n * W;
      px.set(sheet.data.subarray(row, row + W), y * W);
    }
    // Contrast: stretch to the 99.5th percentile of the image.
    const sorted = Array.from(px).sort((a, b) => a - b);
    const top = Math.max(1, sorted[Math.floor(sorted.length * 0.995)]);
    const out = new ImageData(W, H);
    for (let i = 0; i < px.length; i++) {
      const v = Math.min(255, Math.round(Math.pow(px[i] / top, 0.85) * 255));
      const c = SPECKLE_LUT[v];
      out.data[i * 4] = c[0]; out.data[i * 4 + 1] = c[1]; out.data[i * 4 + 2] = c[2]; out.data[i * 4 + 3] = 255;
    }
    spriteCache.set(key, out);
    return out;
  }
  const drawSprite = (canvas, pos, n) => canvas.getContext("2d").putImageData(spriteImage(pos, n), 0, 0);

  /* ---------- Hero: the rig --------------------------------------------- */
  function rig() {
    const canvas = $("rig"), cam = $("cam"), camLabel = $("cam-label"), toggle = $("rig-toggle");
    const LW = 1000, LH = 430;
    const x0 = 190, dx = 64, r = dx / 2, yTop = 62, yBot = 332, yHit = 197, yIn = 372;
    const xs = Array.from({ length: 10 }, (_, i) => x0 + i * dx);
    const laser = { x: 40, y: yIn - 20, w: 78, h: 40 }, camera = { x: 884, y: yIn - 22, w: 74, h: 44 };

    // Fibre path, sampled every ~2 units, from the laser to the camera.
    const pts = [], hitIdx = [];
    const line = (ax, ay, bx, by) => {
      const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / 2));
      for (let i = 1; i <= n; i++) pts.push([ax + (bx - ax) * i / n, ay + (by - ay) * i / n]);
    };
    const arc = (cx, cy, rad, a0, a1) => {
      const n = Math.max(4, Math.round(Math.abs(a1 - a0) * rad / 2));
      for (let i = 1; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; pts.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]); }
    };
    pts.push([laser.x + laser.w, yIn]);
    const q = yIn - yBot;
    line(laser.x + laser.w, yIn, xs[0] - q, yIn);
    arc(xs[0] - q, yBot, q, Math.PI / 2, 0);
    for (let i = 0; i < 10; i++) {
      const up = i % 2 === 0, yA = up ? yBot : yTop, yB = up ? yTop : yBot;
      const n = Math.round(Math.abs(yB - yA) / 2);
      for (let j = 1; j <= n; j++) {
        const y = yA + (yB - yA) * j / n;
        pts.push([xs[i], y]);
        if (Math.abs(y - yHit) < 1.01 && hitIdx.length === i) hitIdx.push(pts.length - 1);
      }
      if (i < 9) {
        const cx = (xs[i] + xs[i + 1]) / 2;
        if (up) arc(cx, yTop, r, Math.PI, 2 * Math.PI); else arc(cx, yBot, r, Math.PI, 0);
      }
    }
    arc(xs[9] + q, yBot, q, Math.PI, Math.PI / 2);
    line(xs[9] + q, yIn, camera.x, yIn);
    const end = pts.length - 1;

    const legend = $("rig-legend");
    legendList(legend, [[posColor(1), "Position 1, next to the laser"], [posColor(10), "Position 10, next to the camera"]]);
    const li = document.createElement("li");
    li.innerHTML = '<span class="swatch" style="background:#d6452e;opacity:.6"></span>Laser light, 638&nbsp;nm';
    legend.appendChild(li);

    let ctx, scale = 1;
    function resize() { const f = fitCanvas(canvas, LH / LW); ctx = f.ctx; scale = f.w / LW; draw(performance.now()); }

    // State machine: move -> strike -> travel -> show
    const S = { pos: 1, carX: xs[0], fromX: xs[0], phase: "show", t0: 0, dur: 600, order: [], queued: null, playing: !reduceMotion, last: null, shown: 0 };
    let ripples = [];
    function nextPos() {
      if (S.queued) { const k = S.queued; S.queued = null; return k; }
      if (!S.order.length) S.order = S.shown < 10 ? Array.from({ length: 10 }, (_, i) => i + 1) : shuffle();
      return S.order.shift();
    }
    function shuffle() { const a = Array.from({ length: 10 }, (_, i) => i + 1); for (let i = 9; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
    function start(phase, now) {
      S.phase = phase; S.t0 = now;
      if (phase === "move") { S.fromX = S.carX; S.dur = 260 + Math.abs(xs[S.pos - 1] - S.carX) * 1.1; }
      if (phase === "strike") { S.dur = 380; ripples.push({ k: S.pos, t0: now }); }
      if (phase === "travel") { S.dur = 300 + (end - hitIdx[S.pos - 1]) * 0.55; }
      if (phase === "show") {
        S.dur = 1500; S.shown++;
        const n = Math.floor(Math.random() * NS);
        if (sheet) drawSprite(cam, S.pos, n);
        camLabel.textContent = `position ${S.pos}`;
        S.last = S.pos;
      }
    }
    function advance(now) {
      const t = (now - S.t0) / S.dur;
      if (t < 1) return;
      if (S.phase === "move") start("strike", now);
      else if (S.phase === "strike") start("travel", now);
      else if (S.phase === "travel") start("show", now);
      else if (S.playing || S.queued) { S.pos = nextPos(); start("move", now); }
    }
    const ease = (t) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

    function draw(now) {
      if (!ctx) return;
      ctx.save(); ctx.scale(scale, scale);
      ctx.clearRect(0, 0, LW, LH);
      const t = Math.min(1, (now - S.t0) / S.dur);
      if (S.phase === "move") S.carX = S.fromX + (xs[S.pos - 1] - S.fromX) * ease(t);

      // Rail and motor
      ctx.fillStyle = "#e4e9ee"; ctx.strokeStyle = "#cfd7df"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(120, yHit - 15, 700, 30, 4); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#cfd7df"; ctx.fillRect(130, yHit - 2, 680, 4);
      ctx.fillStyle = "#4c5d6d"; ctx.beginPath(); ctx.roundRect(96, yHit - 20, 34, 40, 4); ctx.fill();

      // Carriage under the fibre
      ctx.fillStyle = "rgba(14,34,51,0.16)"; ctx.strokeStyle = "rgba(14,34,51,0.45)";
      ctx.beginPath(); ctx.roundRect(S.carX - 22, yHit - 24, 44, 48, 5); ctx.fill(); ctx.stroke();

      // Fibre
      ctx.lineJoin = "round"; ctx.lineCap = "round";
      ctx.beginPath(); pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
      ctx.strokeStyle = "#b9c5d0"; ctx.lineWidth = 5; ctx.stroke();
      ctx.strokeStyle = "rgba(214,69,46,0.55)"; ctx.lineWidth = 2;
      ctx.setLineDash([10, 14]); ctx.lineDashOffset = reduceMotion ? 0 : -(now / 25) % 24; ctx.stroke(); ctx.setLineDash([]);

      // Crossing badges
      xs.forEach((x, i) => {
        const k = i + 1, active = k === S.pos && S.phase !== "show";
        ctx.beginPath(); ctx.arc(x + 19, yHit + 32, active ? 11 : 9.5, 0, 2 * Math.PI);
        ctx.fillStyle = posColor(k); ctx.fill();
        ctx.fillStyle = "#fff"; ctx.font = "600 11px Archivo, Arial, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(String(k), x + 19, yHit + 32.5);
      });

      // Ripples at the hit
      ripples = ripples.filter((rp) => now - rp.t0 < 900);
      ripples.forEach((rp) => {
        const a = (now - rp.t0) / 900;
        ctx.beginPath(); ctx.arc(xs[rp.k - 1], yHit, 6 + a * 34, 0, 2 * Math.PI);
        ctx.strokeStyle = posColor(rp.k); ctx.globalAlpha = 1 - a; ctx.lineWidth = 2.5; ctx.stroke(); ctx.globalAlpha = 1;
      });

      // Hitter: a wedge on the carriage that presses on the fibre
      const press = S.phase === "strike" ? Math.sin(Math.PI * t) : 0;
      ctx.save(); ctx.translate(S.carX, yHit);
      ctx.fillStyle = "#0e2233";
      const s = 1 + 0.35 * press;
      ctx.beginPath(); ctx.moveTo(-9 * s, -13 * s); ctx.lineTo(9 * s, -13 * s); ctx.lineTo(0, 3); ctx.closePath(); ctx.fill();
      ctx.restore();

      // Perturbation travelling to the camera
      if (S.phase === "travel") {
        const i0 = hitIdx[S.pos - 1], head = Math.round(i0 + (end - i0) * t);
        const tail = Math.max(i0, head - 60);
        for (let i = tail; i < head; i++) {
          const a = (i - tail) / 60;
          ctx.beginPath(); ctx.moveTo(pts[i][0], pts[i][1]); ctx.lineTo(pts[i + 1][0], pts[i + 1][1]);
          ctx.strokeStyle = posColor(S.pos); ctx.globalAlpha = a; ctx.lineWidth = 5; ctx.stroke();
        }
        ctx.globalAlpha = 1;
        ctx.beginPath(); ctx.arc(pts[head][0], pts[head][1], 6, 0, 2 * Math.PI); ctx.fillStyle = posColor(S.pos); ctx.fill();
      }

      // Laser and camera
      ctx.fillStyle = "#d6452e"; ctx.beginPath(); ctx.roundRect(laser.x, laser.y, laser.w, laser.h, 5); ctx.fill();
      ctx.fillStyle = "#8f2416"; ctx.fillRect(laser.x + laser.w - 6, yIn - 6, 8, 12);
      const flash = S.phase === "show" ? Math.max(0, 1 - (now - S.t0) / 500) : 0;
      ctx.fillStyle = `rgb(${mix(hex("#a58d8f"), POS_RGB[S.pos - 1], flash).join(",")})`;
      ctx.beginPath(); ctx.roundRect(camera.x, camera.y, camera.w, camera.h, 5); ctx.fill();
      ctx.fillStyle = "#3b2a2c"; ctx.beginPath(); ctx.roundRect(camera.x - 4, yIn - 8, 12, 16, 3); ctx.fill();

      // Labels
      ctx.fillStyle = "#0e2233"; ctx.font = "600 14px Archivo, Arial, sans-serif"; ctx.textBaseline = "alphabetic";
      ctx.textAlign = "left"; ctx.fillText("Laser 638 nm", laser.x, laser.y + laser.h + 22);
      ctx.textAlign = "right"; ctx.fillText("CCD camera", camera.x + camera.w, camera.y + camera.h + 22);
      ctx.textAlign = "left"; ctx.font = "500 13px Archivo, Arial, sans-serif"; ctx.fillStyle = "#4c5d6d";
      ctx.fillText("Linear stepper motor", 96, yHit - 30);
      ctx.textAlign = "center"; ctx.fillText("1 m between points", (xs[0] + xs[1]) / 2, yTop - r - 14);
      ctx.restore();
    }

    function loop(now) { advance(now); draw(now); requestAnimationFrame(loop); }
    canvas.addEventListener("click", (e) => {
      const b = canvas.getBoundingClientRect();
      const x = (e.clientX - b.left) / scale, y = (e.clientY - b.top) / scale;
      let best = -1, bd = 40;
      xs.forEach((xx, i) => { const d = Math.abs(xx - x); if (d < bd && y > yTop - 40 && y < yBot + 40) { bd = d; best = i; } });
      if (best < 0) return;
      S.order = [];
      if (S.phase === "move" || S.phase === "show") { S.pos = best + 1; start("move", performance.now()); }
      else S.queued = best + 1;
    });
    toggle.addEventListener("click", () => { S.playing = !S.playing; toggle.textContent = S.playing ? "Pause" : "Play"; });
    toggle.textContent = S.playing ? "Pause" : "Play";
    window.addEventListener("resize", resize);
    resize();
    sheetReady.then(() => { if (!S.last) { drawSprite(cam, 1, 0); camLabel.textContent = "position 1"; } });
    S.pos = nextPos(); start("move", performance.now());
    requestAnimationFrame(loop);
  }

  /* ---------- Pipeline -------------------------------------------------- */
  function pipeline() {
    const SRC = "assets/media/fig2_frames.jpg";
    const setTile = (div, col, row) => {
      div.style.backgroundImage = `url(${SRC})`;
      div.style.backgroundSize = "900% 300%";
      div.style.backgroundPosition = `${col / 8 * 100}% ${row / 2 * 100}%`;
    };
    const raw = $("pipe-raw"), diff = $("pipe-diff"), sum = $("pipe-sum"), clock = $("pipe-clock"), toggle = $("pipe-toggle");
    const sRaw = $("strip-raw"), sDiff = $("strip-diff");
    const rawT = [], diffT = [];
    for (let i = 0; i < 9; i++) { const d = document.createElement("div"); d.className = "frame"; setTile(d, i, 0); sRaw.appendChild(d); rawT.push(d); }
    for (let i = 0; i < 8; i++) {
      const d = document.createElement("div"); d.className = "frame"; setTile(d, i, 1);
      d.style.gridColumn = String(i + 2); sDiff.appendChild(d); diffT.push(d);
    }
    setTile(sum, 0, 2);
    let step = 0, playing = !reduceMotion, timer = null;
    function render() {
      setTile(raw, step, 0);
      if (step > 0) { setTile(diff, step - 1, 1); diff.style.opacity = 1; } else diff.style.opacity = 0.15;
      sum.style.opacity = step === 0 ? 0.15 : 0.15 + 0.85 * step / 8;
      rawT.forEach((d, i) => { d.className = "frame" + (i === step ? " on" : i < step ? " done" : ""); });
      diffT.forEach((d, i) => { d.className = "frame" + (i === step - 1 ? " on" : i < step - 1 ? " done" : ""); });
      clock.textContent = `frame ${step + 1} of 9 · ${(step / 30 * 1000).toFixed(0)} ms`;
    }
    function tick() { step = (step + 1) % 9; render(); timer = setTimeout(tick, step === 8 ? 2200 : step === 0 ? 900 : 520); }
    rawT.forEach((d, i) => d.addEventListener("click", () => { step = i; render(); }));
    toggle.addEventListener("click", () => {
      playing = !playing; toggle.textContent = playing ? "Pause" : "Play";
      clearTimeout(timer); if (playing) timer = setTimeout(tick, 400);
    });
    toggle.textContent = playing ? "Pause" : "Play";
    render(); if (playing) timer = setTimeout(tick, 900);
  }

  /* ---------- Gallery and fingerprints --------------------------------- */
  function gallery() {
    const g = $("gallery"), fpBox = $("fingerprints"), toggle = $("gallery-toggle");
    const tiles = [];
    for (let k = 1; k <= 10; k++) {
      const t = document.createElement("div"); t.className = "tile";
      t.innerHTML = `<span class="pos"><span class="swatch" style="background:${posColor(k)}"></span>${k}</span>`;
      const c = document.createElement("canvas"); c.width = W; c.height = H;
      c.setAttribute("aria-label", `Recorded hit at position ${k}`);
      t.appendChild(c); g.appendChild(t); tiles.push(c);
    }
    const fp = b64(D.fingerprints, Int8Array);
    for (let k = 1; k <= 10; k++) {
      const t = document.createElement("div"); t.className = "tile";
      const c = document.createElement("canvas"); c.width = W; c.height = H;
      c.setAttribute("aria-label", `Average change at position ${k} relative to all positions`);
      const img = new ImageData(W, H), off = (k - 1) * W * H;
      for (let i = 0; i < W * H; i++) {
        const col = DIV_LUT[Math.max(0, Math.min(255, Math.round((fp[off + i] / 127 + 1) / 2 * 255)))];
        img.data[i * 4] = col[0]; img.data[i * 4 + 1] = col[1]; img.data[i * 4 + 2] = col[2]; img.data[i * 4 + 3] = 255;
      }
      c.getContext("2d").putImageData(img, 0, 0);
      t.appendChild(c); fpBox.appendChild(t);
    }
    let n = 0, playing = !reduceMotion, timer = null;
    const show = () => tiles.forEach((c, i) => drawSprite(c, i + 1, (n + i * 3) % NS));
    const tick = () => { n = (n + 1) % NS; show(); timer = setTimeout(tick, 420); };
    sheetReady.then(() => { show(); if (playing) timer = setTimeout(tick, 420); });
    toggle.addEventListener("click", () => {
      playing = !playing; toggle.textContent = playing ? "Pause" : "Play";
      clearTimeout(timer); if (playing) tick();
    });
    toggle.textContent = playing ? "Pause" : "Play";
  }

  /* ---------- Core-share chart ----------------------------------------- */
  function coreChart() {
    const box = $("core-chart");
    const vals = D.coreShare.map(([m, s]) => [m * 100, s * 100 / Math.sqrt(1000)]);
    const w = 560, h = 250, m = { l: 52, r: 14, t: 14, b: 42 };
    const lo = Math.floor(Math.min(...vals.map(([v, e]) => v - e)) * 2) / 2 - 0.5;
    const hi = Math.ceil(Math.max(...vals.map(([v, e]) => v + e)) * 2) / 2 + 0.5;
    const X = (k) => m.l + (k - 1) / 9 * (w - m.l - m.r), Y = (v) => h - m.b - (v - lo) / (hi - lo) * (h - m.t - m.b);
    const svg = el("svg", { viewBox: `0 0 ${w} ${h}`, role: "img", "aria-label": `Share of the change inside the central core, from ${vals[0][0].toFixed(1)} % at position 1 to ${vals[9][0].toFixed(1)} % at position 10.` }, box);
    for (let v = Math.ceil(lo); v <= hi; v += 1) {
      el("line", { x1: m.l, x2: w - m.r, y1: Y(v), y2: Y(v), stroke: "#cfd7df", "stroke-width": 1 }, svg);
      el("text", { x: m.l - 8, y: Y(v) + 4, "text-anchor": "end", class: "tick" }, svg).textContent = `${v} %`;
    }
    for (let k = 1; k <= 10; k++) el("text", { x: X(k), y: h - m.b + 18, "text-anchor": "middle", class: "tick" }, svg).textContent = k;
    el("text", { x: (m.l + w - m.r) / 2, y: h - 4, "text-anchor": "middle", class: "axis" }, svg).textContent = "Position (1 next to the laser, 10 next to the camera)";
    el("polyline", { points: vals.map(([v], i) => `${X(i + 1)},${Y(v)}`).join(" "), fill: "none", stroke: "#0e2233", "stroke-width": 1.5 }, svg);
    vals.forEach(([v, e], i) => {
      el("line", { x1: X(i + 1), x2: X(i + 1), y1: Y(v - e), y2: Y(v + e), stroke: "#0e2233", "stroke-width": 1.5 }, svg);
      const c = el("circle", { cx: X(i + 1), cy: Y(v), r: 5.5, fill: posColor(i + 1), stroke: "#fff", "stroke-width": 1.5 }, svg);
      el("title", {}, c).textContent = `Position ${i + 1}: ${v.toFixed(2)} % ± ${e.toFixed(2)}`;
    });
  }

  /* ---------- t-SNE map -------------------------------------------------- */
  function tsneMap() {
    const canvas = $("tsne"), tip = $("tsne-tip"), legend = $("tsne-legend");
    const E = b64(D.tsne, Int16Array), L = b64(D.tsneLabels, Uint8Array);
    const N = L.length;
    const spriteAt = new Map(); D.spriteOfPoint.forEach((idx, j) => spriteAt.set(idx, j));
    let ctx, w, h, sel = 0;
    const pad = 14;
    const px = (i) => pad + E[2 * i] / 10000 * (w - 2 * pad), py = (i) => pad + (1 - E[2 * i + 1] / 10000) * (h - 2 * pad);
    function draw() {
      ctx.clearRect(0, 0, w, h);
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < N; i++) {
          const on = !sel || L[i] === sel;
          if ((pass === 0) === on) continue;
          ctx.fillStyle = on ? posColor(L[i]) : "#cfd7df";
          ctx.globalAlpha = on ? 0.6 : 0.35;
          ctx.fillRect(px(i) - 1.2, py(i) - 1.2, 2.4, 2.4);
        }
      }
      ctx.globalAlpha = 1;
      spriteAt.forEach((j, i) => {
        if (sel && L[i] !== sel) return;
        ctx.beginPath(); ctx.arc(px(i), py(i), 3.4, 0, 2 * Math.PI);
        ctx.fillStyle = posColor(L[i]); ctx.fill(); ctx.strokeStyle = "#0e2233"; ctx.lineWidth = 1.2; ctx.stroke();
      });
    }
    function resize() { const f = fitCanvas(canvas, 0.86); ctx = f.ctx; w = f.w; h = f.h; draw(); }
    for (let k = 0; k <= 10; k++) {
      const li = document.createElement("li"), b = document.createElement("button");
      b.type = "button"; b.setAttribute("aria-pressed", String(k === 0));
      b.innerHTML = k ? `<span class="swatch" style="background:${posColor(k)}"></span>${k}` : "All";
      b.addEventListener("click", () => { sel = k; legend.querySelectorAll("button").forEach((x, i) => x.setAttribute("aria-pressed", String(i === k))); draw(); });
      li.appendChild(b); legend.appendChild(li);
    }
    const tipCanvas = document.createElement("canvas"); tipCanvas.width = W; tipCanvas.height = H;
    const tipText = document.createElement("strong");
    tip.appendChild(tipText); tip.appendChild(tipCanvas);
    canvas.addEventListener("pointermove", (e) => {
      if (!sheet) return;
      const b = canvas.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
      let best = -1, bd = 14 * 14;
      spriteAt.forEach((j, i) => {
        if (sel && L[i] !== sel) return;
        const d = (px(i) - x) ** 2 + (py(i) - y) ** 2; if (d < bd) { bd = d; best = i; }
      });
      if (best < 0) { tip.hidden = true; return; }
      const j = spriteAt.get(best), pos = Math.floor(j / NS) + 1;
      drawSprite(tipCanvas, pos, j % NS);
      tipText.textContent = `Position ${pos}`;
      tip.hidden = false;
      const left = Math.min(w - 140, Math.max(0, px(best) + 12)), top = py(best) + 12 > h - 120 ? py(best) - 130 : py(best) + 12;
      tip.style.left = `${left}px`; tip.style.top = `${top}px`;
    });
    canvas.addEventListener("pointerleave", () => { tip.hidden = true; });
    window.addEventListener("resize", resize);
    resize();
  }

  /* ---------- Confusion matrices --------------------------------------- */
  const inkScale = (v) => `rgb(${mix(hex("#f7f8fa"), hex("#0e2233"), Math.pow(v / 100, 0.8)).join(",")})`;
  const redScale = (v) => `rgb(${mix(hex("#f7f8fa"), hex("#c8402c"), Math.min(1, Math.pow(v / 60, 0.75))).join(",")})`;
  function matrix(parent, M, opts) {
    const n = M.length, cell = opts.cell, m = opts.margin;
    const w = m.l + n * cell + 4, h = m.t + n * cell + 4;
    const svg = el("svg", { viewBox: `0 0 ${w} ${h}`, role: "img", "aria-label": opts.label }, parent);
    for (let i = 0; i < n; i++) {
      el("text", { x: m.l - 6, y: m.t + i * cell + cell / 2 + 4, "text-anchor": "end", class: "tick" }, svg).textContent = i + 1;
      el("text", { x: m.l + i * cell + cell / 2, y: m.t - 6, "text-anchor": "middle", class: "tick" }, svg).textContent = i + 1;
      for (let j = 0; j < n; j++) {
        const v = M[i][j], g = el("g", { class: "cell" }, svg);
        el("rect", { x: m.l + j * cell, y: m.t + i * cell, width: cell - 1.5, height: cell - 1.5, rx: 2, fill: i === j ? inkScale(v) : (v > 0 ? redScale(v) : "#f7f8fa") }, g);
        el("title", {}, g).textContent = `True ${i + 1}, predicted ${j + 1}: ${v} %`;
        if (v >= opts.minLabel) {
          const t = el("text", { x: m.l + j * cell + cell / 2 - 0.75, y: m.t + i * cell + cell / 2 + 3.5, "text-anchor": "middle", fill: (i === j && v > 45) || (i !== j && v > 30) ? "#fff" : "#0e2233" }, g);
          t.textContent = opts.fmt(v);
          if (opts.fontSize) t.style.fontSize = opts.fontSize;
        }
      }
    }
    if (opts.axes) {
      el("text", { x: m.l + n * cell / 2, y: 13, "text-anchor": "middle", class: "axis" }, svg).textContent = "Predicted position";
      el("text", { transform: `translate(14 ${m.t + n * cell / 2}) rotate(-90)`, "text-anchor": "middle", class: "axis" }, svg).textContent = "True position";
    }
    return svg;
  }
  function cm3() {
    const box = $("cm3");
    [["50-ffn", "50 µm", "feedforward"], ["50-cnn", "50 µm", "convolutional"], ["240-ffn", "240 µm", "feedforward"], ["240-cnn", "240 µm", "convolutional"]].forEach(([key, fibre, net]) => {
      const f = document.createElement("figure"); f.className = "panel";
      const c = D.cm3[key];
      f.innerHTML = `<figcaption>${fibre}, ${net} <span>· ${c.overall} %</span></figcaption>`;
      const d = document.createElement("div"); d.className = "svgbox"; f.appendChild(d); box.appendChild(f);
      matrix(d, c.m, { cell: 50, margin: { l: 22, t: 20 }, minLabel: 0, fmt: (v) => `${v}`, fontSize: "12px", label: `Three-point confusion matrix, ${fibre}, ${net}: ${c.overall} % correct overall.` });
    });
  }
  function cm10() {
    const box = $("cm10"), diag = $("diag");
    const seg = document.querySelectorAll(".seg button");
    let net = "ffn";
    function render() {
      box.innerHTML = "";
      const c = D.cm10[net];
      matrix(box, c.m, { cell: 38, margin: { l: 42, t: 40 }, minLabel: 0.05, fmt: (v) => v >= 99.95 ? "100" : v.toFixed(1), axes: true, label: `Ten-point confusion matrix, ${net === "ffn" ? "feedforward" : "convolutional"} network, ${c.overall} % correct overall.` });
    }
    seg.forEach((b) => b.addEventListener("click", () => { net = b.dataset.net; seg.forEach((x) => x.setAttribute("aria-pressed", String(x === b))); render(); }));
    render();

    // Per-position accuracy for both networks
    const w = 420, h = 330, m = { l: 46, r: 12, t: 16, b: 44 };
    const X = (k) => m.l + (k - 1) / 9 * (w - m.l - m.r), Y = (v) => h - m.b - v / 100 * (h - m.t - m.b);
    const svg = el("svg", { viewBox: `0 0 ${w} ${h}`, role: "img", "aria-label": "Correct classifications by position for both networks; both rise towards position 10." }, diag);
    for (let v = 0; v <= 100; v += 20) {
      el("line", { x1: m.l, x2: w - m.r, y1: Y(v), y2: Y(v), stroke: "#cfd7df" }, svg);
      el("text", { x: m.l - 8, y: Y(v) + 4, "text-anchor": "end", class: "tick" }, svg).textContent = `${v} %`;
    }
    for (let k = 1; k <= 10; k++) el("text", { x: X(k), y: h - m.b + 18, "text-anchor": "middle", class: "tick" }, svg).textContent = k;
    el("text", { x: (m.l + w - m.r) / 2, y: h - 6, "text-anchor": "middle", class: "axis" }, svg).textContent = "True position";
    [["ffn", "#0e2233", "", "Feedforward"], ["cnn", "#4c5d6d", "5 4", "Convolutional"]].forEach(([key, col, dash, name], si) => {
      const v = D.cm10[key].m.map((row, i) => row[i]);
      el("polyline", { points: v.map((y, i) => `${X(i + 1)},${Y(y)}`).join(" "), fill: "none", stroke: col, "stroke-width": 2, "stroke-dasharray": dash }, svg);
      v.forEach((y, i) => {
        const c = el(si ? "rect" : "circle", si ? { x: X(i + 1) - 4, y: Y(y) - 4, width: 8, height: 8, fill: posColor(i + 1), stroke: "#fff" } : { cx: X(i + 1), cy: Y(y), r: 4.8, fill: posColor(i + 1), stroke: "#fff" }, svg);
        el("title", {}, c).textContent = `${name}, position ${i + 1}: ${y} %`;
      });
      const lx = m.l + 10, ly = m.t + 6 + si * 18;
      el("line", { x1: lx, x2: lx + 22, y1: ly, y2: ly, stroke: col, "stroke-width": 2, "stroke-dasharray": dash }, svg);
      el("text", { x: lx + 28, y: ly + 4, class: "tick" }, svg).textContent = name;
    });
  }

  /* ---------- BibTeX ---------------------------------------------------- */
  function bibtex() {
    const b = $("copy-bibtex");
    b.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText($("bibtex").innerText); b.textContent = "Copied"; }
      catch { b.textContent = "Select the text above to copy"; }
      setTimeout(() => { b.textContent = "Copy BibTeX"; }, 1800);
    });
  }

  rig(); pipeline(); gallery(); coreChart(); tsneMap(); cm3(); cm10(); bibtex();
})();
