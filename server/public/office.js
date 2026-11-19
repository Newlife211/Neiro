// Карта офиса «Нейросферы»: 2D-план и 3D-модель с вращением камеры. Без библиотек: свой
// маленький 3D-движок на canvas (перспектива, освещение граней, сортировка по глубине, «кукольный
// домик» — стены, обращённые к камере, опускаются, чтобы было видно, кто что делает).
// Подключение: NeiroOffice.create(canvas, { onAgent(agent), onDept(room), onMeeting(), onModeChange(mode) })
// → { load(data), setMode('2d'|'3d'), preset('iso'|'top'|'front'), fit(), zoom(k), destroy() }
(function () {
  const DCOL = { admin: '#d4a72c', analytics: '#4f7cff', rnd: '#a855f7', marketing: '#ec4899', sales: '#22c55e', clients: '#14b8a6', quality: '#f97316', security: '#64748b', it: '#3b82f6', support: '#06b6d4', accounting: '#eab308', legal: '#94a3b8', hr: '#f43f5e', crypto_desk: '#f7931a', crypto_quant: '#8b5cf6', crypto_research: '#10b981', crypto_risk: '#ef4444', crypto_treasury: '#facc15', crypto_compliance: '#60a5fa', ai_product: '#e879f9', tech_radar: '#22d3ee' };
  const SKIN = ['#f1c7a5', '#e0ac85', '#c98e66', '#f5d3b8', '#d9a07a'], HAIR = ['#2b2018', '#5a3a22', '#1c1c1c', '#8a5a2b', '#c9a227', '#3b2a20'];
  const STATE_ICON = { work: '⌨', queue: '⏳', pause: '⏸', idle: '☕', meeting: '📣' };
  const hash = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
  const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
  const mix = (hex, k, add = 0) => { const [r, g, b] = rgb(hex); const f = (v) => Math.max(0, Math.min(255, v * k + add)) | 0; return `rgb(${f(r)},${f(g)},${f(b)})`; };
  const V = { sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; } };
  const LIGHT = V.norm([-0.45, 1, 0.6]);
  const short = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

  // ---------------- раскладка офиса (общая для 2D и 3D) ----------------
  function layout(d, aspect) {
    const special = [{ key: '_director', name: 'Кабинет директора', col: '#d4a72c', n: 0 }, { key: '_meeting', name: 'Переговорная', col: '#8d98aa', n: 0 }, { key: '_kitchen', name: 'Кухня и лаунж', col: '#3ddc97', n: 0 }];
    const depts = d.depts.map((x) => ({ key: x.key, name: x.name, col: DCOL[x.key] || '#5aa9ff', n: d.agents.filter((a) => a.dept === x.key).length }));
    const ai = depts.findIndex((x) => x.key === 'admin');
    const list = [...special, ...(ai >= 0 ? depts.splice(ai, 1) : []), ...depts];
    const cols = Math.max(2, Math.min(7, Math.round(Math.sqrt(list.length * Math.max(0.45, Math.min(2.4, aspect)) * 0.95))));
    const GAP = 1.8, rooms = [];
    let z = 0;
    for (let r0 = 0; r0 < list.length; r0 += cols) {
      const row = list.slice(r0, r0 + cols).map((r) => ({ ...r, w: r.key === '_meeting' ? 9 : 7.4, d: r.key === '_kitchen' || r.key === '_meeting' || r.key === '_director' ? 6.4 : Math.min(8.6, Math.max(5.6, 2.8 + Math.ceil(r.n / 3) * 2.3)) }));
      const depth = Math.max(...row.map((r) => r.d));
      let x = 0;
      for (const r of row) { rooms.push({ ...r, x, z, d: depth }); x += r.w + GAP; }
      z += depth + GAP;
    }
    const W = Math.max(...rooms.map((r) => r.x + r.w)), D = z - GAP;
    for (const r of rooms) { r.x -= W / 2; r.z -= D / 2; }
    // места
    const byKey = Object.fromEntries(rooms.map((r) => [r.key, r]));
    const parts = d.meeting ? d.meeting.participants || [] : [];
    const kitchen = byKey._kitchen, meeting = byKey._meeting;
    const desks = [];
    for (const r of rooms) {
      const staff = d.agents.filter((a) => a.dept === r.key);
      staff.forEach((a, i) => {
        const dx = r.x + 1.5 + (i % 3) * 2.2, dz = r.z + 1.5 + Math.floor(i / 3) * 2.3;
        a._desk = { x: dx, z: dz }; desks.push({ x: dx, z: dz, col: r.col, agent: a });
      });
    }
    d.agents.forEach((a) => {
      const h = hash(a.id);
      a._kitchen = { x: kitchen.x + 1.2 + ((h % 97) / 97) * (kitchen.w - 2.4), z: kitchen.z + 2.2 + (((h >> 7) % 89) / 89) * (kitchen.d - 3.2) };
      const k = parts.indexOf(a.id);
      const inMeeting = d.meeting && d.meeting.status === 'collecting' && k >= 0 && a.state !== 'work';
      a._where = inMeeting ? 'meeting' : a.state === 'idle' ? 'kitchen' : 'desk';
      a._target = inMeeting ? { x: meeting.x + 1.5 + (k % 6) * 1.2, z: meeting.z + (k < 6 ? 2.1 : 4.4) } : a.state === 'idle' ? a._kitchen : { x: a._desk.x, z: a._desk.z + 0.72 };
      a._seated = !inMeeting && a.state !== 'idle';
    });
    return { rooms, desks, W, D, byKey };
  }

  function create(canvas, opts = {}) {
    const S = { data: null, L: null, people: new Map(), mode: 'auto', raf: 0, t: 0, sel: null, dirty: true, hits: [], roomPolys: [], lastAspect: 0 };
    try { S.mode = localStorage.getItem('ns_office_mode') || '3d'; } catch { S.mode = '3d'; }
    const cam = { tx: 0, tz: 0, yaw: -0.65, pitch: 0.82, dist: 40, fov: 0.9, p2: { x: 0, y: 0, s: 14 } };
    const ctx = canvas.getContext('2d');
    let W = 0, H = 0, dpr = 1;

    // ---------- 3D: камера и примитивы ----------
    let eye, fwd, right, up, F;
    function setupCamera() {
      const cp = Math.cos(cam.pitch);
      eye = [cam.tx + cam.dist * cp * Math.sin(cam.yaw), cam.dist * Math.sin(cam.pitch), cam.tz + cam.dist * cp * Math.cos(cam.yaw)];
      fwd = V.norm(V.sub([cam.tx, 0, cam.tz], eye));
      right = V.norm(V.cross(fwd, [0, 1, 0])); up = V.cross(right, fwd);
      F = (H / 2) / Math.tan(cam.fov / 2);
    }
    function toCam(p) { const v = V.sub(p, eye); return [V.dot(v, right), V.dot(v, up), V.dot(v, fwd)]; }
    function proj(c) { return [W / 2 + (c[0] * F) / c[2], H / 2 - (c[1] * F) / c[2]]; }
    let Q = [], G = []; // Q — объекты для сортировки, G — пол (рисуется первым)
    function face(pts, color, n, opt = {}) {
      if (n && !opt.both) { const c = pts.reduce((s, p) => [s[0] + p[0] / pts.length, s[1] + p[1] / pts.length, s[2] + p[2] / pts.length], [0, 0, 0]); if (V.dot(n, V.sub(eye, c)) <= 0) return; }
      const cs = pts.map(toCam); if (cs.some((c) => c[2] < 0.4)) return;
      const k = n ? 0.58 + 0.42 * Math.max(0, V.dot(n, LIGHT)) : 1;
      const fill = opt.glow ? color : mix(color, k);
      const item = { depth: opt.depth ?? cs.reduce((s, c) => s + c[2], 0) / cs.length, pts: cs.map(proj), fill, stroke: opt.stroke, alpha: opt.alpha };
      (opt.ground ? G : Q).push(item);
    }
    function box(x, y, z, w, h, d, col, opt = {}) {
      const X = x + w, Y = y + h, Z = z + d;
      face([[x, Y, z], [X, Y, z], [X, Y, Z], [x, Y, Z]], opt.top || col, [0, 1, 0], opt);
      face([[x, y, Z], [X, y, Z], [X, Y, Z], [x, Y, Z]], opt.front || col, [0, 0, 1], opt);
      face([[X, y, z], [x, y, z], [x, Y, z], [X, Y, z]], col, [0, 0, -1], opt);
      face([[X, y, Z], [X, y, z], [X, Y, z], [X, Y, Z]], col, [1, 0, 0], opt);
      face([[x, y, z], [x, y, Z], [x, Y, Z], [x, Y, z]], col, [-1, 0, 0], opt);
    }
    function sprite(p, draw) { const c = toCam(p); if (c[2] < 0.4) return; const [sx, sy] = proj(c); Q.push({ depth: c[2] - 0.05, sprite: true, draw: () => draw(sx, sy, F / c[2]) }); }

    // ---------- 3D: сцена ----------
    function wall(x0, z0, x1, z1, nx, nz, col, center) {
      const facing = V.dot([nx, 0, nz], V.sub(eye, [center[0], 0.6, center[1]])) > 0 && cam.pitch < 1.35;
      const h = facing ? 0.18 : 1.25, len = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.ceil(len / 1.6));
      for (let i = 0; i < n; i++) {
        const a = i / n, b = (i + 1) / n, ax = x0 + (x1 - x0) * a, az = z0 + (z1 - z0) * a, bx = x0 + (x1 - x0) * b, bz = z0 + (z1 - z0) * b;
        const t = 0.12, minx = Math.min(ax, bx) - (nz ? 0 : t / 2), minz = Math.min(az, bz) - (nx ? 0 : t / 2);
        box(minx, 0, minz, Math.abs(bx - ax) || t, h, Math.abs(bz - az) || t, '#2a3344', { top: col });
      }
    }
    function room3d(r) {
      face([[r.x, 0, r.z], [r.x + r.w, 0, r.z], [r.x + r.w, 0, r.z + r.d], [r.x, 0, r.z + r.d]], mix(r.col, 0.28, 18), [0, 1, 0], { ground: true, glow: true });
      for (let i = 1; i < r.w; i += 1.5) face([[r.x + i, 0.002, r.z], [r.x + i + 0.02, 0.002, r.z], [r.x + i + 0.02, 0.002, r.z + r.d], [r.x + i, 0.002, r.z + r.d]], mix(r.col, 0.36, 22), null, { ground: true, glow: true });
      const c = [r.x + r.w / 2, r.z + r.d / 2], gap = 1.3, mid = r.x + r.w / 2;
      wall(r.x, r.z, r.x + r.w, r.z, 0, -1, r.col, c);
      wall(r.x, r.z, r.x, r.z + r.d, -1, 0, r.col, c);
      wall(r.x + r.w, r.z, r.x + r.w, r.z + r.d, 1, 0, r.col, c);
      wall(r.x, r.z + r.d, mid - gap / 2, r.z + r.d, 0, 1, r.col, c);
      wall(mid + gap / 2, r.z + r.d, r.x + r.w, r.z + r.d, 0, 1, r.col, c);
      // растение в углу и шкаф у задней стены
      box(r.x + r.w - 0.75, 0, r.z + 0.25, 0.45, 0.4, 0.45, '#7a5537');
      sprite([r.x + r.w - 0.52, 0.85, r.z + 0.47], (sx, sy, k) => { ctx.fillStyle = '#2f8f5b'; for (const [dx, dy, rr] of [[0, 0, 0.32], [-0.18, 0.12, 0.22], [0.2, 0.1, 0.22], [0, -0.22, 0.2]]) { ctx.beginPath(); ctx.arc(sx + dx * k, sy + dy * k, rr * k, 0, 7); ctx.fill(); } });
      if (!r.key.startsWith('_')) box(r.x + 0.2, 0, r.z + 0.2, 1.1, 1.0, 0.4, '#4a3a2c', { top: '#5c4836' });
      // табличка
      sprite([r.x + r.w / 2, 1.9, r.z + 0.05], (sx, sy, k) => {
        const fs = Math.max(9, Math.min(16, k * 0.42)); ctx.font = `700 ${fs}px -apple-system,system-ui,sans-serif`; ctx.textAlign = 'center';
        const t = short(r.name, 26), w = ctx.measureText(t).width + 12;
        ctx.fillStyle = 'rgba(12,16,22,.78)'; ctx.beginPath(); ctx.roundRect(sx - w / 2, sy - fs, w, fs + 7, 6); ctx.fill();
        ctx.fillStyle = r.col; ctx.fillText(t, sx, sy);
      });
      if (r.key === '_director') {
        box(r.x + 2.4, 0.74, r.z + 2, 2.6, 0.08, 1.1, '#6e4a2e', { top: '#7d5534' }); box(r.x + 2.5, 0, r.z + 2.1, 2.4, 0.74, 0.9, '#4c3322');
        box(r.x + 3.4, 0.82, r.z + 2.15, 0.8, 0.5, 0.05, '#11161e'); face([[r.x + 3.45, 0.86, r.z + 2.21], [r.x + 4.15, 0.86, r.z + 2.21], [r.x + 4.15, 1.28, r.z + 2.21], [r.x + 3.45, 1.28, r.z + 2.21]], '#d4a72c', [0, 0, 1], { glow: true });
        chair(r.x + 3.8, r.z + 3.6, '#2b2f3a', 1); box(r.x + 0.5, 0, r.z + 4.2, 2.2, 0.45, 0.9, '#5b3a2a', { top: '#6b4632' }); box(r.x + 0.5, 0.45, r.z + 4.9, 2.2, 0.45, 0.2, '#5b3a2a');
        sprite([r.x + 3.8, 2.4, r.z + 3.6], (sx, sy, k) => { ctx.font = `700 ${Math.max(10, Math.min(15, k * 0.4))}px -apple-system,system-ui,sans-serif`; ctx.textAlign = 'center'; ctx.fillStyle = '#ffd166'; ctx.fillText('👑 Вы', sx, sy); });
      }
      if (r.key === '_meeting') {
        box(r.x + 1, 0.74, r.z + 2.6, 7, 0.08, 1.3, '#4a3a2a', { top: '#5a4632' }); box(r.x + 1.2, 0, r.z + 2.8, 6.6, 0.74, 0.9, '#2f2318');
        for (let i = 0; i < 6; i++) { chair(r.x + 1.5 + i * 1.2, r.z + 2.1, '#3b4250', 0); chair(r.x + 1.5 + i * 1.2, r.z + 4.4, '#3b4250', 1); }
        box(r.x + 2.5, 0.9, r.z + 0.14, 4, 1.6, 0.06, '#0d1118'); face([[r.x + 2.6, 1.0, r.z + 0.21], [r.x + 6.4, 1.0, r.z + 0.21], [r.x + 6.4, 2.4, r.z + 0.21], [r.x + 2.6, 2.4, r.z + 0.21]], S.data?.meeting ? '#2c4a6e' : '#1a2230', [0, 0, 1], { glow: true });
        const m = S.data?.meeting;
        if (m) sprite([r.x + 4.5, 2.9, r.z + 1], (sx, sy, k) => bubble(sx, sy, '📣 ' + short(m.agenda, 34), '#ffd166', 'rgba(58,50,32,.95)', Math.max(9, Math.min(14, k * 0.36))));
      }
      if (r.key === '_kitchen') {
        box(r.x + 0.3, 0, r.z + 0.25, 3.6, 0.9, 0.65, '#3b4250', { top: '#c9d2de' }); box(r.x + 4.2, 0, r.z + 0.25, 0.8, 1.9, 0.7, '#d7dde6', { top: '#e8edf3' });
        box(r.x + 1.0, 0.9, r.z + 0.32, 0.35, 0.45, 0.32, '#1c1f26');
        box(r.x + 2.4, 0.72, r.z + 2.6, 1.6, 0.06, 1.6, '#6e4a2e'); box(r.x + 3.1, 0, r.z + 3.3, 0.2, 0.72, 0.2, '#3b2a1d');
        box(r.x + 0.5, 0, r.z + 4.1, 2.4, 0.45, 0.9, '#2f6f5f', { top: '#38806e' }); box(r.x + 0.5, 0.45, r.z + 4.8, 2.4, 0.45, 0.2, '#2f6f5f');
      }
    }
    function chair(x, z, col, facing) {
      box(x - 0.24, 0.42, z - 0.22, 0.48, 0.07, 0.44, col); box(x - 0.04, 0, z - 0.04, 0.08, 0.42, 0.08, '#20242c');
      if (facing) box(x - 0.24, 0.49, z + 0.18, 0.48, 0.3, 0.07, col); else box(x - 0.24, 0.49, z - 0.25, 0.48, 0.3, 0.07, col);
    }
    function desk3d(dk) {
      const { x, z, col, agent } = dk, on = agent.state === 'work';
      box(x - 0.75, 0.72, z - 0.4, 1.5, 0.06, 0.8, '#6e4a2e', { top: '#80583a' });
      box(x - 0.7, 0, z - 0.35, 0.08, 0.72, 0.7, '#3b2a1d'); box(x + 0.62, 0, z - 0.35, 0.08, 0.72, 0.7, '#3b2a1d');
      box(x - 0.3, 0.78, z - 0.3, 0.6, 0.42, 0.04, '#11161e'); box(x - 0.04, 0.78, z - 0.22, 0.08, 0.06, 0.1, '#11161e');
      face([[x - 0.26, 0.82, z - 0.255], [x + 0.26, 0.82, z - 0.255], [x + 0.26, 1.16, z - 0.255], [x - 0.26, 1.16, z - 0.255]], on ? mix(col, 1.15, 30) : agent.state === 'queue' ? '#3a3a24' : '#1b2330', [0, 0, 1], { glow: true });
      box(x - 0.22, 0.78, z + 0.02, 0.44, 0.02, 0.14, '#2a2f38');
      if (hash(agent.id) % 3 === 0) box(x + 0.42, 0.78, z + 0.02, 0.09, 0.11, 0.09, '#e8e2d0');
      chair(x, z + 0.78, '#2b2f3a', 1);
    }
    function person3d(p, t) {
      const a = p.a, col = DCOL[a.dept] || '#5aa9ff', h = hash(a.id);
      const moving = Math.hypot(p.tx - p.x, p.tz - p.z) > 0.05;
      const seated = a._seated && !moving;
      const bob = moving ? Math.abs(Math.sin(t * 9 + p.phase)) * 0.06 : a.state === 'work' ? Math.sin(t * 12 + p.phase) * 0.012 : 0;
      const y0 = seated ? 0.45 : 0;
      if (!seated) { box(p.x - 0.14, 0, p.z - 0.07, 0.12, 0.55 + bob, 0.14, '#2a313d'); box(p.x + 0.02, 0, p.z - 0.07, 0.12, 0.55 - bob, 0.14, '#2a313d'); }
      else box(p.x - 0.15, 0.45, p.z - 0.3, 0.3, 0.12, 0.34, '#2a313d');
      const by = (seated ? 0.52 : 0.55) + bob;
      box(p.x - 0.2, by, p.z - 0.12, 0.4, 0.55, 0.24, col);
      const head = [p.x, by + 0.78, p.z];
      sprite(head, (sx, sy, k) => {
        const r = 0.17 * k;
        ctx.fillStyle = SKIN[h % SKIN.length]; ctx.beginPath(); ctx.arc(sx, sy, r, 0, 7); ctx.fill();
        ctx.fillStyle = HAIR[(h >> 3) % HAIR.length]; ctx.beginPath(); ctx.arc(sx, sy - r * 0.2, r * 1.02, Math.PI, 0); ctx.fill();
        if (a.head) { ctx.fillStyle = '#ffd166'; ctx.beginPath(); ctx.arc(sx + r * 0.9, sy - r * 1.1, r * 0.32, 0, 7); ctx.fill(); }
        if (S.sel === a.id) { ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(sx, sy + r * 2.2, r * 2.3, 0, 7); ctx.stroke(); }
        S.hits.push({ x: sx, y: sy + r * 2, r: Math.max(16, r * 3), a });
        const where = a._where === 'meeting' ? 'meeting' : a.state;
        const close = k > 26 || S.sel === a.id;
        const txt = close ? (where === 'meeting' ? 'на совещании' : a.state === 'work' ? short(a.current, 28) : a.state === 'queue' ? `в очереди: ${a.queued}` : a.state === 'pause' ? 'пауза' : '') : '';
        const fs = Math.max(9, Math.min(13, k * 0.3));
        bubble(sx, sy - r * 1.8, STATE_ICON[where] + (txt ? ' ' + txt : ''), a.state === 'work' ? '#9df0c5' : where === 'meeting' ? '#ffd166' : '#c9d2de', a.state === 'work' ? 'rgba(20,50,31,.92)' : 'rgba(21,27,36,.88)', fs);
        if (k > 18 || S.sel === a.id) { ctx.font = `600 ${fs}px -apple-system,system-ui,sans-serif`; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(236,240,246,.95)'; ctx.fillText(a.name.split(' ')[0], sx, sy + r * 3.6 + fs * 0.4); }
      });
    }
    function bubble(x, y, text, fg, bg, fs) {
      ctx.font = `600 ${fs}px -apple-system,system-ui,sans-serif`; ctx.textAlign = 'center';
      const w = ctx.measureText(text).width + 12; ctx.fillStyle = bg; ctx.beginPath(); ctx.roundRect(x - w / 2, y - fs - 2, w, fs + 8, 7); ctx.fill();
      ctx.fillStyle = fg; ctx.fillText(text, x, y + 1);
    }
    function render3d(t) {
      setupCamera(); Q = []; G = []; S.hits = []; S.roomPolys = [];
      const L = S.L;
      face([[-L.W / 2 - 3, -0.01, -L.D / 2 - 3], [L.W / 2 + 3, -0.01, -L.D / 2 - 3], [L.W / 2 + 3, -0.01, L.D / 2 + 3], [-L.W / 2 - 3, -0.01, L.D / 2 + 3]], '#141a24', [0, 1, 0], { ground: true, glow: true });
      for (const r of L.rooms) {
        room3d(r);
        const cs = [[r.x, 0, r.z], [r.x + r.w, 0, r.z], [r.x + r.w, 0, r.z + r.d], [r.x, 0, r.z + r.d]].map(toCam);
        if (cs.every((c) => c[2] > 0.4)) S.roomPolys.push({ r, pts: cs.map(proj) });
      }
      for (const dk of L.desks) desk3d(dk);
      for (const p of S.people.values()) person3d(p, t);
      for (const g of G) drawPoly(g);
      Q.sort((a, b) => b.depth - a.depth);
      for (const q of Q) q.sprite ? q.draw() : drawPoly(q);
    }
    function drawPoly(q) {
      ctx.beginPath(); q.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
      if (q.alpha) ctx.globalAlpha = q.alpha; ctx.fillStyle = q.fill; ctx.fill(); ctx.strokeStyle = q.fill; ctx.lineWidth = 0.6; ctx.stroke(); ctx.globalAlpha = 1;
    }

    // ---------- 2D: план сверху ----------
    const P2 = (x, z) => [W / 2 + (x + cam.p2.x) * cam.p2.s, H / 2 + (z + cam.p2.y) * cam.p2.s];
    function render2d(t) {
      const L = S.L, s = cam.p2.s; S.hits = []; S.roomPolys = [];
      for (const r of L.rooms) {
        const [x0, y0] = P2(r.x, r.z), w = r.w * s, h = r.d * s;
        ctx.fillStyle = mix(r.col, 0.24, 16); ctx.fillRect(x0, y0, w, h);
        ctx.strokeStyle = mix(r.col, 0.75); ctx.lineWidth = Math.max(2, s * 0.14);
        const gap = 1.3 * s, mid = x0 + w / 2;
        ctx.beginPath(); ctx.moveTo(mid - gap / 2, y0 + h); ctx.lineTo(x0, y0 + h); ctx.lineTo(x0, y0); ctx.lineTo(x0 + w, y0); ctx.lineTo(x0 + w, y0 + h); ctx.lineTo(mid + gap / 2, y0 + h); ctx.stroke();
        S.roomPolys.push({ r, pts: [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]] });
        const fs = Math.max(9, Math.min(15, s * 0.6)); ctx.font = `700 ${fs}px -apple-system,system-ui,sans-serif`; ctx.textAlign = 'left'; ctx.fillStyle = r.col;
        ctx.fillText(short(r.name, Math.max(8, Math.floor(w / (fs * 0.55)))), x0 + 6, y0 + fs + 3);
        if (r.key === '_meeting') { const [tx, ty] = P2(r.x + 1, r.z + 2.6); ctx.fillStyle = '#5a4632'; ctx.fillRect(tx, ty, 7 * s, 1.3 * s); for (let i = 0; i < 6; i++) for (const zz of [2.1, 4.4]) { const [cx, cy] = P2(r.x + 1.5 + i * 1.2, r.z + zz); ctx.fillStyle = '#3b4250'; ctx.beginPath(); ctx.arc(cx, cy, 0.22 * s, 0, 7); ctx.fill(); } if (S.data.meeting) { ctx.fillStyle = '#ffd166'; ctx.font = `600 ${fs}px -apple-system,system-ui,sans-serif`; ctx.fillText('📣 ' + short(S.data.meeting.agenda, 30), x0 + 6, y0 + h - 8); } }
        if (r.key === '_kitchen') { const k = (x, z, w2, d2, c) => { const [a, b] = P2(r.x + x, r.z + z); ctx.fillStyle = c; ctx.fillRect(a, b, w2 * s, d2 * s); }; k(0.3, 0.25, 3.6, 0.65, '#8d96a3'); k(4.2, 0.25, 0.8, 0.7, '#d7dde6'); k(2.4, 2.6, 1.6, 1.6, '#80583a'); k(0.5, 4.1, 2.4, 0.9, '#38806e'); }
        if (r.key === '_director') { const [a, b] = P2(r.x + 2.4, r.z + 2); ctx.fillStyle = '#80583a'; ctx.fillRect(a, b, 2.6 * s, 1.1 * s); const [c, d] = P2(r.x + 3.8, r.z + 3.6); ctx.fillStyle = '#ffd166'; ctx.font = `700 ${fs}px -apple-system,system-ui,sans-serif`; ctx.textAlign = 'center'; ctx.fillText('👑 Вы', c, d + fs / 2); }
      }
      for (const dk of L.desks) {
        const [a, b] = P2(dk.x - 0.75, dk.z - 0.4); ctx.fillStyle = '#80583a'; ctx.fillRect(a, b, 1.5 * s, 0.8 * s);
        const [m1, m2] = P2(dk.x - 0.3, dk.z - 0.32); ctx.fillStyle = dk.agent.state === 'work' ? mix(dk.col, 1.2, 30) : '#1b2330'; ctx.fillRect(m1, m2, 0.6 * s, 0.12 * s);
        const [c1, c2] = P2(dk.x, dk.z + 0.78); ctx.fillStyle = '#2b2f3a'; ctx.beginPath(); ctx.arc(c1, c2, 0.24 * s, 0, 7); ctx.fill();
      }
      for (const p of S.people.values()) {
        const a = p.a, [x, y] = P2(p.x, p.z), r = Math.max(6, 0.32 * s), col = DCOL[a.dept] || '#5aa9ff';
        const where = a._where === 'meeting' ? 'meeting' : a.state;
        ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.arc(x + 1.5, y + 2, r, 0, 7); ctx.fill();
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
        ctx.lineWidth = Math.max(2, r * 0.28); ctx.strokeStyle = a.state === 'work' ? '#3ddc97' : where === 'meeting' ? '#ffd166' : a.state === 'queue' ? '#e0b341' : '#5b6575'; ctx.stroke();
        ctx.fillStyle = '#0c1016'; ctx.font = `700 ${Math.max(8, r * 0.9)}px -apple-system,system-ui,sans-serif`; ctx.textAlign = 'center';
        ctx.fillText(a.name.split(' ').map((w) => w[0]).join('').slice(0, 2), x, y + r * 0.33);
        if (a.head) { ctx.fillStyle = '#ffd166'; ctx.beginPath(); ctx.arc(x + r * 0.8, y - r * 0.8, r * 0.3, 0, 7); ctx.fill(); }
        if (S.sel === a.id) { ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, r * 1.6, 0, 7); ctx.stroke(); }
        const fs = Math.max(9, Math.min(13, s * 0.5));
        if (s >= 16 || S.sel === a.id) {
          ctx.font = `600 ${fs}px -apple-system,system-ui,sans-serif`; ctx.fillStyle = 'rgba(236,240,246,.95)'; ctx.fillText(a.name.split(' ')[0], x, y + r + fs + 1);
          const txt = where === 'meeting' ? 'на совещании' : a.state === 'work' ? short(a.current, 24) : a.state === 'queue' ? `очередь ${a.queued}` : '';
          bubble(x, y - r - 6, STATE_ICON[where] + (txt && s >= 22 ? ' ' + txt : ''), a.state === 'work' ? '#9df0c5' : where === 'meeting' ? '#ffd166' : '#c9d2de', a.state === 'work' ? 'rgba(20,50,31,.92)' : 'rgba(21,27,36,.88)', fs);
        }
        S.hits.push({ x, y, r: Math.max(16, r * 1.6), a });
      }
    }

    // ---------- цикл ----------
    function step(dt, t) {
      for (const p of S.people.values()) {
        const a = p.a, dx = p.tx - p.x, dz = p.tz - p.z, dist = Math.hypot(dx, dz), sp = 1.8 * dt;
        if (dist > 0.02) { p.x += (dx / dist) * Math.min(sp, dist); p.z += (dz / dist) * Math.min(sp, dist); }
        else if (a._where === 'kitchen' && Math.random() < dt * 0.2) { const k = S.L.byKey._kitchen; p.tx = k.x + 1 + Math.random() * (k.w - 2); p.tz = k.z + 2.2 + Math.random() * (k.d - 3.2); }
      }
    }
    function frame(ts) {
      if (!canvas.isConnected) { S.raf = 0; return; }
      const t = ts / 1000, dt = Math.min(0.05, t - (S.t || t)); S.t = t;
      dpr = window.devicePixelRatio || 1; W = canvas.clientWidth; H = canvas.clientHeight;
      if (!W || !H) { S.raf = requestAnimationFrame(frame); return; }
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
      const asp = W / H; if (S.data && Math.abs(asp - S.lastAspect) > 0.35) { S.lastAspect = asp; relayout(true); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      if (S.data && S.L) { step(dt, t); S.mode === '2d' ? render2d(t) : render3d(t); }
      S.raf = requestAnimationFrame(frame);
    }

    function relayout(refit) {
      S.L = layout(S.data, S.lastAspect || (canvas.clientWidth / Math.max(1, canvas.clientHeight)) || 1);
      for (const a of S.data.agents) {
        const p = S.people.get(a.id) || { x: a._target.x, z: a._target.z, phase: Math.random() * 6 };
        p.a = a; p.tx = a._target.x; p.tz = a._target.z; S.people.set(a.id, p);
      }
      for (const id of [...S.people.keys()]) if (!S.data.agents.some((a) => a.id === id)) S.people.delete(id);
      if (refit) fit();
    }
    function fit() {
      if (!S.L) return;
      const w = canvas.clientWidth || 360, h = canvas.clientHeight || 640;
      cam.tx = 0; cam.tz = 0;
      const pad = opts.padTop || 0;
      cam.p2 = { x: 0, y: 0, s: Math.max(4, Math.min(60, Math.min((w - 16) / S.L.W, (h - 16 - pad) / S.L.D))) };
      cam.p2.y = pad / 2 / cam.p2.s;
      // 3D: подбираем расстояние так, чтобы весь офис занял ~90% экрана
      const pw = W, ph = H; W = w; H = h;
      const C = [];
      for (const x of [-S.L.W / 2, S.L.W / 2]) for (const z of [-S.L.D / 2, S.L.D / 2]) for (const y of [0, 1.9]) C.push([x, y, z]);
      cam.dist = Math.max(S.L.W, S.L.D) * 1.2;
      for (let i = 0; i < 6; i++) {
        setupCamera();
        const P = C.map((p) => { const c = toCam(p); return c[2] > 0.4 ? proj(c) : null; }).filter(Boolean);
        if (P.length < C.length) { cam.dist *= 1.4; continue; }
        const bw = Math.max(...P.map((p) => p[0])) - Math.min(...P.map((p) => p[0])), bh = Math.max(...P.map((p) => p[1])) - Math.min(...P.map((p) => p[1]));
        cam.dist = Math.max(6, Math.min(180, cam.dist * Math.max(bw / (w * 0.94), bh / (h * 0.9 - pad))));
      }
      W = pw || w; H = ph || h;
    }

    // ---------- управление ----------
    const pts = new Map(); let g = null;
    const onDown = (e) => { canvas.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]);
      g = { x: e.clientX, y: e.clientY, moved: false, yaw: cam.yaw, pitch: cam.pitch, tx: cam.tx, tz: cam.tz, p2: { ...cam.p2 }, pan: e.button === 2 || e.shiftKey };
      if (pts.size === 2) { const [a, b] = [...pts.values()]; g.pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2, dist: cam.dist, p2: { ...cam.p2 }, tx: cam.tx, tz: cam.tz }; } };
    const onMove = (e) => { if (!pts.has(e.pointerId) || !g) return; pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (pts.size === 2 && g.pinch) {
        const [a, b] = [...pts.values()]; const k = Math.hypot(a[0] - b[0], a[1] - b[1]) / g.pinch.d; const mx = (a[0] + b[0]) / 2 - g.pinch.mx, my = (a[1] + b[1]) / 2 - g.pinch.my;
        if (S.mode === '2d') { cam.p2.s = Math.max(4, Math.min(80, g.pinch.p2.s * k)); cam.p2.x = g.pinch.p2.x + mx / cam.p2.s; cam.p2.y = g.pinch.p2.y + my / cam.p2.s; }
        else { cam.dist = Math.max(6, Math.min(180, g.pinch.dist / k)); panBy(mx, my, g.pinch); }
        g.moved = true; return;
      }
      const dx = e.clientX - g.x, dy = e.clientY - g.y; if (Math.hypot(dx, dy) > 6) g.moved = true;
      if (S.mode === '2d') { cam.p2.x = g.p2.x + dx / cam.p2.s; cam.p2.y = g.p2.y + dy / cam.p2.s; }
      else if (g.pan) panBy(dx, dy, g);
      else { cam.yaw = g.yaw - dx * 0.008; cam.pitch = Math.max(0.22, Math.min(1.53, g.pitch + dy * 0.006)); } };
    function panBy(dx, dy, base) {
      const k = cam.dist / F; const sy = Math.sin(cam.yaw), cy = Math.cos(cam.yaw);
      cam.tx = base.tx - (dx * cy + dy * sy / Math.max(0.35, Math.sin(cam.pitch))) * k;
      cam.tz = base.tz - (-dx * sy + dy * cy / Math.max(0.35, Math.sin(cam.pitch))) * k;
    }
    const onUp = (e) => { if (!pts.has(e.pointerId)) return; pts.delete(e.pointerId);
      if (g && !g.moved && pts.size === 0) tap(e); if (pts.size === 0) g = null; else { const [p] = [...pts.values()]; g = { x: p[0], y: p[1], moved: true, yaw: cam.yaw, pitch: cam.pitch, tx: cam.tx, tz: cam.tz, p2: { ...cam.p2 } }; } };
    const onWheel = (e) => { e.preventDefault(); const k = e.deltaY < 0 ? 1.12 : 0.89;
      if (S.mode === '2d') { const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left - W / 2, my = e.clientY - r.top - H / 2; const ns = Math.max(4, Math.min(80, cam.p2.s * k)); cam.p2.x += mx / ns - mx / cam.p2.s; cam.p2.y += my / ns - my / cam.p2.s; cam.p2.s = ns; }
      else cam.dist = Math.max(6, Math.min(180, cam.dist / k)); };
    function tap(e) {
      const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      let best = null, bd = 1e9;
      for (const h of S.hits) { const d = Math.hypot(h.x - x, h.y - y); if (d < h.r && d < bd) { bd = d; best = h; } }
      if (best) { S.sel = best.a.id; opts.onAgent?.(best.a); return; }
      for (const rp of S.roomPolys) if (inPoly(rp.pts, x, y)) { if (rp.r.key === '_meeting') return opts.onMeeting?.(); if (!rp.r.key.startsWith('_')) return opts.onDept?.(rp.r, S.data.agents.filter((a) => a.dept === rp.r.key)); }
    }
    function inPoly(P, x, y) { let ins = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, yi] = P[i], [xj, yj] = P[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins; } return ins; }
    canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp); canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false }); canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.style.touchAction = 'none';
    S.raf = requestAnimationFrame(frame);

    return {
      load(data) { const first = !S.data; S.data = data; relayout(first); },
      setMode(m) { S.mode = m === '2d' ? '2d' : '3d'; try { localStorage.setItem('ns_office_mode', S.mode); } catch {} opts.onModeChange?.(S.mode); },
      get mode() { return S.mode; },
      preset(name) { if (S.mode === '2d') this.setMode('3d'); if (name === 'top') { cam.pitch = 1.5; cam.yaw = 0; } else if (name === 'front') { cam.pitch = 0.42; cam.yaw = 0; } else { cam.pitch = 0.82; cam.yaw = -0.65; } fit(); },
      fit, zoom(k) { if (S.mode === '2d') cam.p2.s = Math.max(4, Math.min(80, cam.p2.s * k)); else cam.dist = Math.max(6, Math.min(180, cam.dist / k)); },
      select(id) { S.sel = id; }, destroy() { cancelAnimationFrame(S.raf); S.raf = 0; },
    };
  }
  window.NeiroOffice = { create, DCOL };
})();
