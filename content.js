(() => {
  const vars = window.fluentCheckinVars;
  if (!vars || !vars.rest || document.getElementById('att-insights-host')) return;

  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // period: 'YYYY-MM' (calendar month) | 'YYYY' (calendar year) | 'all'
  const state = { tab: 'attendance', period: null, leaveYear: null, data: null, status: '' };

  // ---------- data (fetched on every open; a handful of requests) ----------
  async function fetchAll(path, key) {
    const rows = [];
    for (let page = 1, last = 1; page <= last; page++) {
      const res = await fetch(`${vars.rest.url}/${path}?per_page=200&page=${page}`, {
        headers: { 'X-WP-Nonce': vars.rest.nonce },
        credentials: 'same-origin'
      });
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      const body = (await res.json())[key];
      rows.push(...body.data);
      last = body.last_page;
    }
    return rows;
  }

  const toMin = (dt) => (dt ? +dt.slice(11, 13) * 60 + +dt.slice(14, 16) : null);
  const dayMs = 86400000;
  const parseDate = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
  const fmtDate = (ms) => new Date(ms).toISOString().slice(0, 10);
  const todayStr = () => {
    const n = new Date();
    return fmtDate(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
  };
  const shiftMonth = (ym, by) => fmtDate(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + by, 1)).slice(0, 7);

  // One entry per calendar day; several check-ins on the same day are summed.
  function groupDays(attendances) {
    const days = new Map();
    for (const a of attendances) {
      const date = a.enter_date_time.slice(0, 10);
      const d = days.get(date) || { date, first: 1440, last: null, minutes: 0, open: false, notes: [] };
      d.first = Math.min(d.first, toMin(a.enter_date_time));
      if (a.exit_date_time) {
        // a checkout after midnight counts past 24:00 of the check-in day
        const overflow = (parseDate(a.exit_date_time) - parseDate(date)) / dayMs * 1440;
        d.last = Math.max(d.last ?? 0, toMin(a.exit_date_time) + overflow);
        d.minutes += +a.duration_minutes || 0;
      } else {
        d.open = true;
      }
      if (a.work_description && a.work_description.trim().length > 1) d.notes.push(a.work_description.trim());
      days.set(date, d);
    }
    return days;
  }

  function leaveDates(leaves) {
    const set = new Map();
    for (const l of leaves) {
      if (l.leave_status !== 'approved') continue;
      for (let t = parseDate(l.from_date), end = parseDate(l.to_date); t <= end; t += dayMs) set.set(fmtDate(t), l);
    }
    return set;
  }

  // ---------- formatting ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hm = (min) => (min == null || isNaN(min) ? 'n/a' : `${Math.floor(min / 60)}h ${Math.round(min % 60)}m`);
  const clock = (min) => {
    if (min == null || isNaN(min)) return 'n/a';
    const h = Math.floor(min / 60) % 24, m = Math.floor(min % 60);
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
  };
  const shortDate = (d) => `${+d.slice(8, 10)} ${MONTHS[+d.slice(5, 7) - 1]}`;
  const longDate = (d) => `${shortDate(d)} ${d.slice(0, 4)}`;
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN);
  const leaveLabel = (t) => ((vars.leave_types || {})[t] || {}).label || (t ? t : 'Other');

  // Calendar period → [from, to] dates; never runs past today.
  function periodBounds(firstDate) {
    const today = todayStr(), p = state.period;
    if (p === 'all') return { from: firstDate, to: today, label: 'All time' };
    const y = +p.slice(0, 4), isMonth = p.length === 7, m = isMonth ? +p.slice(5, 7) : 1;
    const from = fmtDate(Date.UTC(y, m - 1, 1));
    const end = fmtDate(Date.UTC(isMonth ? y : y + 1, isMonth ? m : 0, 0));
    return { from, to: end < today ? end : today, label: isMonth ? `${MONTHS[m - 1]} ${y}` : `${y}` };
  }

  // ---------- charts (plain SVG) ----------
  const H = 220, PL = 56, PR = 8, PT = 10, PB = 24;

  function frame(W, yTicks, yOf, yFmt, xLabels) {
    let s = '';
    for (const t of yTicks) {
      s += `<line class="grid" x1="${PL}" x2="${W - PR}" y1="${yOf(t)}" y2="${yOf(t)}"/>`;
      s += `<text class="ax" x="${PL - 6}" y="${yOf(t) + 4}" text-anchor="end">${yFmt(t)}</text>`;
    }
    for (const [x, label] of xLabels) s += `<text class="ax" x="${x}" y="${H - 6}" text-anchor="middle">${esc(label)}</text>`;
    return s;
  }

  // items: [{label, value, title, cls}] ; ref: optional dashed reference line
  function barChart(items, { yFmt = (v) => v, ref = null, maxLabels = 10, W = 900 } = {}) {
    if (!items.length) return '<p class="empty">No data in this period.</p>';
    const max = Math.max(1, ref || 0, ...items.map((i) => i.value || 0));
    const step = max > 8 ? Math.ceil(max / 5) : max > 4 ? 2 : 1;
    const top = Math.ceil(max / step) * step;
    const yOf = (v) => PT + (H - PT - PB) * (1 - v / top);
    const slot = (W - PL - PR) / items.length;
    const bw = Math.max(1, Math.min(48, slot * 0.72));
    const every = Math.ceil(items.length / maxLabels);
    const ticks = [];
    for (let t = 0; t <= top; t += step) ticks.push(t);
    const xLabels = items.map((it, i) => [PL + slot * (i + 0.5), it.label]).filter((_, i) => i % every === 0);
    let s = frame(W, ticks, yOf, yFmt, xLabels);
    items.forEach((it, i) => {
      const x = PL + slot * (i + 0.5) - bw / 2;
      if (it.cls === 'leave') {
        s += `<rect class="leave" x="${x}" y="${yOf(0) - 5}" width="${bw}" height="5"><title>${esc(it.title)}</title></rect>`;
      } else if (it.value > 0) {
        s += `<rect class="bar" x="${x}" y="${yOf(it.value)}" width="${bw}" height="${yOf(0) - yOf(it.value)}" rx="${Math.min(2, bw / 2)}"><title>${esc(it.title)}</title></rect>`;
      }
    });
    if (ref) s += `<line class="ref" x1="${PL}" x2="${W - PR}" y1="${yOf(ref)}" y2="${yOf(ref)}"/>`;
    return `<svg viewBox="0 0 ${W} ${H}" role="img">${s}</svg>`;
  }

  // points: [{label, a, b, title}] — check-in (a) and check-out (b) minutes per day
  function timeChart(points) {
    const W = 900;
    const vals = points.flatMap((p) => [p.a, p.b]).filter((v) => v != null);
    if (!vals.length) return '<p class="empty">No data in this period.</p>';
    const lo = Math.floor(Math.min(...vals) / 60) * 60, hi = Math.ceil(Math.max(...vals) / 60) * 60 || 60;
    const yOf = (v) => PT + (H - PT - PB) * (1 - (v - lo) / Math.max(60, hi - lo));
    const slot = (W - PL - PR) / points.length;
    const every = Math.ceil(points.length / 10);
    const step = hi - lo > 8 * 60 ? 120 : 60;
    const ticks = [];
    for (let t = lo; t <= hi; t += step) ticks.push(t);
    const xLabels = points.map((p, i) => [PL + slot * (i + 0.5), p.label]).filter((_, i) => i % every === 0);
    let s = frame(W, ticks, yOf, clock, xLabels);
    const r = Math.max(1.5, Math.min(3.5, slot * 0.4));
    points.forEach((p, i) => {
      const x = PL + slot * (i + 0.5);
      if (p.a != null && p.b != null) s += `<line class="span" x1="${x}" x2="${x}" y1="${yOf(p.a)}" y2="${yOf(p.b)}"/>`;
      if (p.a != null) s += `<circle class="in" cx="${x}" cy="${yOf(p.a)}" r="${r}"><title>${esc(p.title)}</title></circle>`;
      if (p.b != null) s += `<circle class="out" cx="${x}" cy="${yOf(p.b)}" r="${r}"><title>${esc(p.title)}</title></circle>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" role="img">${s}</svg>`;
  }

  const tile = (label, value, sub = '') => `<div class="tile"><div class="tv">${esc(value)}</div><div class="tl">${esc(label)}</div>${sub ? `<div class="ts">${esc(sub)}</div>` : ''}</div>`;
  const card = (title, body, note = '') => `<section class="card"><h3>${esc(title)}${note ? `<span>${note}</span>` : ''}</h3>${body}</section>`;

  // ---------- views ----------
  function periodBar(firstMonth) {
    const thisMonth = todayStr().slice(0, 7), p = state.period;
    const btn = (value, label) => `<button data-period="${value}" class="${p === value ? 'on' : ''}">${label}</button>`;
    const month = p.length === 7 ? p : thisMonth;
    // a <select>, because Firefox has no <input type="month">
    let options = p.length === 7 ? '' : '<option selected disabled>Pick month…</option>';
    for (let m = thisMonth; m >= firstMonth; m = shiftMonth(m, -1)) options += `<option value="${m}" ${m === p ? 'selected' : ''}>${MONTHS[+m.slice(5) - 1]} ${m.slice(0, 4)}</option>`;
    return `<div class="seg">
      ${btn(thisMonth, 'This month')}${btn(shiftMonth(thisMonth, -1), 'Last month')}
      <span class="pick"><button data-period="${shiftMonth(month, -1)}" title="Previous month" ${month <= firstMonth ? 'disabled' : ''}>‹</button><select class="${p.length === 7 ? 'on' : ''}">${options}</select><button data-period="${shiftMonth(month, 1)}" title="Next month" ${month >= thisMonth ? 'disabled' : ''}>›</button></span>
      ${btn(thisMonth.slice(0, 4), 'This year')}${btn(String(+thisMonth.slice(0, 4) - 1), 'Last year')}${btn('all', 'All')}
    </div>`;
  }

  function attendanceView() {
    const { days, leaveMap } = state.data;
    const all = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
    if (!all.length) return '<p class="empty">No attendance records.</p>';
    const { from, to, label: periodLabel } = periodBounds(all[0].date);
    const inRange = all.filter((d) => d.date >= from && d.date <= to);
    const done = inRange.filter((d) => d.minutes > 0);

    const series = [];
    for (let t = parseDate(from); t <= parseDate(to); t += dayMs) {
      const date = fmtDate(t), d = days.get(date), l = leaveMap.get(date);
      const label = shortDate(date);
      if (d) {
        const note = d.notes.length ? `\n${d.notes.join(' | ').slice(0, 200)}` : '';
        series.push({ label, value: d.minutes / 60, d,
          title: `${WEEKDAYS[new Date(t).getUTCDay()]} ${label}: ${clock(d.first)} – ${d.last == null ? '?' : clock(d.last)} · ${d.minutes ? hm(d.minutes) : 'no checkout'}${note}` });
      } else if (l) {
        series.push({ label, value: 0, cls: 'leave', title: `${label}: ${leaveLabel(l.leave_type)} leave — ${l.title || ''}` });
      } else {
        series.push({ label, value: 0, title: label });
      }
    }

    const byMonth = new Map();
    for (const d of inRange) {
      const k = d.date.slice(0, 7);
      const m = byMonth.get(k) || { days: 0, minutes: 0, done: 0 };
      m.days++; if (d.minutes) { m.minutes += d.minutes; m.done++; }
      byMonth.set(k, m);
    }
    const monthLabel = (k) => `${MONTHS[+k.slice(5) - 1]} '${k.slice(2, 4)}`;
    const months = [...byMonth.entries()].sort();

    const byWd = WEEKDAYS.map(() => []);
    for (const d of done) byWd[new Date(parseDate(d.date)).getUTCDay()].push(d.minutes);

    const longest = done.reduce((m, d) => (d.minutes > (m ? m.minutes : 0) ? d : m), null);
    const noCheckout = inRange.filter((d) => d.open && !d.minutes).length;
    const leaveDaysInRange = [...leaveMap.keys()].filter((d) => d >= from && d <= to).length;

    const rows = [...inRange].reverse().map((d) => `<tr><td>${esc(longDate(d.date))}</td><td>${WEEKDAYS[new Date(parseDate(d.date)).getUTCDay()]}</td><td>${clock(d.first)}</td><td>${d.last == null ? '—' : clock(d.last)}</td><td>${d.minutes ? hm(d.minutes) : '<em>no checkout</em>'}</td><td class="note">${esc(d.notes.join(' | '))}</td></tr>`).join('');

    // monthly charts only say something when the period spans several months
    const monthly = months.length > 1 ? `
      ${card('Average hours by month', barChart(months.map(([k, m]) => ({ label: monthLabel(k), value: m.done ? m.minutes / m.done / 60 : 0, title: `${monthLabel(k)}: avg ${hm(m.minutes / m.done)} · ${m.days} days present · total ${hm(m.minutes)}` })), { yFmt: (v) => `${v}h`, ref: 8, maxLabels: 12 }))}
      ${card('Days present per month', barChart(months.map(([k, m]) => ({ label: monthLabel(k), value: m.days, title: `${monthLabel(k)}: ${m.days} days present` })), { maxLabels: 12 }))}` : '';

    return `
      ${periodBar(all[0].date.slice(0, 7))}
      <p class="meta">${esc(periodLabel)} · ${esc(longDate(from))} – ${esc(longDate(to))}</p>
      <div class="tiles">
        ${tile('Days present', inRange.length, `${noCheckout} without checkout`)}
        ${tile('Avg hours / day', hm(avg(done.map((d) => d.minutes))), `${done.length} completed days`)}
        ${tile('Total logged', hm(done.reduce((a, d) => a + d.minutes, 0)))}
        ${tile('Avg check-in', clock(avg(inRange.map((d) => d.first))))}
        ${tile('Avg check-out', clock(avg(inRange.filter((d) => d.last != null).map((d) => d.last))))}
        ${tile('Longest day', longest ? hm(longest.minutes) : 'n/a', longest ? shortDate(longest.date) : '')}
        ${tile('Leave days', leaveDaysInRange, 'approved, in period')}
      </div>
      ${card('Hours logged per day', barChart(series, { yFmt: (v) => `${v}h`, ref: 8 }), '<i class="k bar"></i>logged <i class="k leave"></i>leave <i class="k ref"></i>8h')}
      ${card('Check-in / check-out time', timeChart(series.map((s) => ({ label: s.label, a: s.d ? s.d.first : null, b: s.d ? s.d.last : null, title: s.title }))), '<i class="k in"></i>in <i class="k out"></i>out')}
      ${card('Average hours by weekday', barChart(WEEKDAYS.map((w, i) => ({ label: w, value: byWd[i].length ? avg(byWd[i]) / 60 : 0, title: `${w}: avg ${hm(avg(byWd[i]))} over ${byWd[i].length} days` })), { yFmt: (v) => `${v}h`, ref: 8 }))}
      ${monthly}
      ${card('Daily details', `<div class="scroll"><table><thead><tr><th>Date</th><th>Day</th><th>In</th><th>Out</th><th>Logged</th><th>Work note</th></tr></thead><tbody>${rows}</tbody></table></div>`)}
    `;
  }

  function leavesView() {
    const { leaves } = state.data;
    if (!leaves.length) return '<p class="empty">No leave records.</p>';
    const years = [...new Set(leaves.map((l) => l.from_date.slice(0, 4)))].sort().reverse();
    if (!years.includes(state.leaveYear)) state.leaveYear = years[0];
    const list = leaves.filter((l) => l.from_date.startsWith(state.leaveYear)).sort((a, b) => b.from_date.localeCompare(a.from_date));
    const approved = list.filter((l) => l.leave_status === 'approved');
    const sumDays = (arr) => arr.reduce((a, l) => a + (+l.days_count || 0), 0);

    const byType = new Map();
    for (const l of approved) byType.set(l.leave_type || '', (byType.get(l.leave_type || '') || 0) + (+l.days_count || 0));
    const byMonth = MONTHS.map(() => 0);
    for (const l of approved) byMonth[+l.from_date.slice(5, 7) - 1] += +l.days_count || 0;
    const perYear = years.slice().reverse().map((y) => {
      const n = sumDays(leaves.filter((l) => l.from_date.startsWith(y) && l.leave_status === 'approved'));
      return { label: y, value: n, title: `${y}: ${n} approved leave days` };
    });
    const pending = list.filter((l) => ['applied', 'processing'].includes(l.leave_status));

    const rows = list.map((l) => `<tr><td>${esc(shortDate(l.from_date))}${l.to_date !== l.from_date ? ' – ' + esc(shortDate(l.to_date)) : ''}</td><td>${esc(l.days_count)}</td><td>${esc(leaveLabel(l.leave_type))}</td><td><b class="st ${esc(l.leave_status)}">${esc(((vars.leave_statuses || {})[l.leave_status] || {}).label || l.leave_status)}</b></td><td>${esc(l.title)}</td><td class="note">${esc(l.note)}</td><td>${l.created_at ? `${esc(longDate(l.created_at))}, ${clock(toMin(l.created_at))}` : ''}</td></tr>`).join('');

    return `
      <div class="seg">${years.map((y) => `<button data-year="${y}" class="${state.leaveYear === y ? 'on' : ''}">${y}</button>`).join('')}</div>
      <p class="meta">Leaves · ${esc(state.leaveYear)}</p>
      <div class="tiles">
        ${tile('Approved leave days', sumDays(approved), `${approved.length} applications`)}
        ${[...byType.entries()].map(([t, n]) => tile(leaveLabel(t), n, 'days')).join('')}
        ${tile('Pending', sumDays(pending), `${pending.length} applications`)}
      </div>
      <div class="two">
        ${card(`Leave days by month — ${state.leaveYear}`, barChart(MONTHS.map((m, i) => ({ label: m, value: byMonth[i], title: `${m}: ${byMonth[i]} days` })), { maxLabels: 12, W: 480 }))}
        ${card('Leave days by year', barChart(perYear, { maxLabels: 12, W: 480 }))}
      </div>
      ${card('Leave details', `<div class="scroll"><table><thead><tr><th>Dates</th><th>Days</th><th>Type</th><th>Status</th><th>Title</th><th>Note</th><th>Applied</th></tr></thead><tbody>${rows}</tbody></table></div>`)}
    `;
  }

  // ---------- styles ----------
  const CSS = `
    .wrap { --bg:#fff; --fg:#1f2430; --mut:#6b7280; --line:#e5e7eb; --soft:#f4f5f8; --acc:#4f6df5; --out:#9a6bd8; --leave:#e8963a; --ref:#d14b4b; }
    .wrap.dark { --bg:#1b1e26; --fg:#e8eaf0; --mut:#9aa1b0; --line:#2f3440; --soft:#242833; --acc:#7f96ff; --out:#c19bf0; --leave:#f0ab5c; --ref:#ef7b7b; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .fab { position: fixed; right: 20px; bottom: 20px; z-index: 99998; border: 0; border-radius: 999px; padding: 10px 16px; background: var(--acc); color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.25); }
    .overlay { position: fixed; inset: 0; z-index: 99999; background: rgba(0,0,0,.45); display: none; }
    .overlay.open { display: block; }
    .panel { position: absolute; inset: 24px; max-width: 1100px; margin: 0 auto; background: var(--bg); color: var(--fg); border-radius: 12px; display: flex; flex-direction: column; overflow: hidden; font-size: 14px; }
    header { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
    header h2 { margin: 0; font-size: 16px; }
    .status { margin-right: auto; color: var(--mut); font-size: 12px; }
    .body { padding: 16px; overflow: auto; }
    .body > h2 { font-size: 16px; margin: 20px 0 10px; }
    button, select { font: inherit; color: var(--fg); }
    .tabs button, .seg button, .seg select, .x { border: 1px solid var(--line); background: var(--bg); padding: 6px 12px; border-radius: 6px; cursor: pointer; }
    .tabs button.on, .seg button.on { background: var(--acc); border-color: var(--acc); color: #fff; }
    .seg select.on { border-color: var(--acc); box-shadow: 0 0 0 1px var(--acc); }
    .wrap.dark select { color-scheme: dark; }
    button:disabled { opacity: .4; cursor: default; }
    .seg { display: flex; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; align-items: center; }
    .pick { display: inline-flex; gap: 2px; margin: 0 6px; }
    .meta { margin: 0 0 12px; color: var(--mut); font-size: 13px; }
    .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; margin-bottom: 12px; }
    .tile { background: var(--soft); border-radius: 8px; padding: 10px 12px; }
    .tv { font-size: 20px; font-weight: 700; } .tl { color: var(--mut); font-size: 12px; } .ts { color: var(--mut); font-size: 11px; margin-top: 2px; }
    .card { border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin-bottom: 12px; min-width: 0; }
    .card h3 { margin: 0 0 8px; font-size: 13px; display: flex; justify-content: space-between; gap: 8px; }
    .card h3 span { font-weight: 400; color: var(--mut); font-size: 12px; }
    .two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    @media (max-width: 800px) { .two { grid-template-columns: 1fr; } .panel { inset: 0; border-radius: 0; } }
    svg { width: 100%; height: auto; display: block; }
    .grid { stroke: var(--line); } .ax { fill: var(--mut); font-size: 11px; }
    .bar { fill: var(--acc); } .bar:hover, circle:hover { opacity: .7; } .leave { fill: var(--leave); }
    .ref { stroke: var(--ref); stroke-dasharray: 5 4; } .span { stroke: var(--line); stroke-width: 1.5; }
    .in { fill: var(--acc); } .out { fill: var(--out); }
    .k { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin: 0 4px 0 10px; }
    .k.bar, .k.in { background: var(--acc); } .k.out { background: var(--out); } .k.leave { background: var(--leave); } .k.ref { background: var(--ref); height: 2px; vertical-align: middle; }
    .scroll { max-height: 360px; overflow: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; vertical-align: top; }
    th { position: sticky; top: 0; background: var(--bg); color: var(--mut); font-weight: 600; }
    td.note { white-space: normal; color: var(--mut); min-width: 200px; } em { color: var(--leave); font-style: normal; }
    .st { font-weight: 600; } .st.approved { color: #2e9e5b; } .st.declined, .st.cancelled { color: var(--ref); } .st.applied, .st.processing { color: var(--leave); }
    footer { margin-top: 16px; text-align: center; color: var(--mut); font-size: 11px; opacity: .7; }
    .empty { color: var(--mut); padding: 24px; text-align: center; }
  `;
  // Flat, unscrolled layout — shared by the exported HTML file and the print (PDF) view.
  const STATIC_CSS = `
    .fab, .tabs, .x, .seg { display: none !important; }
    .overlay { position: static; display: block; background: none; }
    .panel { position: static; display: block; overflow: visible; border-radius: 0; }
    .body, .scroll { overflow: visible; max-height: none; }
    th { position: static; }
    .card:has(svg), .tile, tr { break-inside: avoid; }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  `;

  const FOOTER = '<footer>Attendance Insights · made with care by Masiur Rahman Siddiki</footer>';

  // ---------- shell ----------
  const host = document.createElement('div');
  host.id = 'att-insights-host';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>:host { all: initial; display: block; } ${CSS} @media print { ${STATIC_CSS} }</style>
    <div class="wrap">
      <button class="fab">📊 Insights</button>
      <div class="overlay"><div class="panel">
        <header><h2>Attendance Insights</h2><span class="status"></span>
          <div class="tabs"><button data-tab="attendance">Attendance</button> <button data-tab="leaves">Leaves</button></div>
          <button class="x" data-export="html" title="Download a standalone HTML report">⬇ HTML</button>
          <button class="x" data-export="pdf" title="Print / Save as PDF">⬇ PDF</button>
          <button class="x" data-resync title="Reload data">↻</button><button class="x" data-close>✕</button>
        </header>
        <div class="body"></div>
      </div></div>
    </div>`;
  document.body.appendChild(host);

  // While printing, only the report is on the page.
  const printStyle = document.createElement('style');
  printStyle.textContent = `@media print { html, body.att-printing { height: auto !important; overflow: visible !important; background: #fff !important; } body.att-printing > *:not(#att-insights-host) { display: none !important; } }`;
  document.head.appendChild(printStyle);

  const wrap = root.querySelector('.wrap');
  const overlay = root.querySelector('.overlay');
  const body = root.querySelector('.body');
  const statusEl = root.querySelector('.status');

  function render() {
    wrap.classList.toggle('dark', document.documentElement.classList.contains('dark'));
    root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));
    statusEl.textContent = state.status;
    if (state.data) body.innerHTML = (state.tab === 'attendance' ? attendanceView() : leavesView()) + FOOTER;
  }

  // Report = both tabs, for the period / year currently selected.
  const reportHtml = () => `<p class="meta">${esc((vars.auth && vars.auth.display_name) || '')} · generated ${esc(new Date().toLocaleString())}</p><h2>Attendance</h2>${attendanceView()}<h2>Leaves</h2>${leavesView()}${FOOTER}`;
  const reportName = () => `attendance-${state.period}`;

  function exportHtml() {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(reportName())}</title><style>body { margin: 0; background: #fff; } ${CSS} ${STATIC_CSS} .panel { max-width: 1100px; margin: 0 auto; }</style></head><body><div class="wrap"><div class="panel"><header><h2>Attendance Insights</h2></header><div class="body">${reportHtml()}</div></div></div></body></html>`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    a.download = `${reportName()}.html`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function exportPdf() {
    const title = document.title;
    const restore = () => {
      document.body.classList.remove('att-printing');
      document.title = title;
      render();
    };
    window.addEventListener('afterprint', restore, { once: true });
    document.title = reportName(); // becomes the suggested PDF file name
    document.body.classList.add('att-printing');
    wrap.classList.remove('dark');
    body.innerHTML = reportHtml();
    window.print();
  }

  async function load() {
    body.innerHTML = '<p class="empty">Loading…</p>';
    state.status = '';
    try {
      const [attendances, leaves] = await Promise.all([
        fetchAll('attendance/my-attendances', 'attendances'),
        fetchAll('hr/leaves', 'leaves')
      ]);
      state.data = { days: groupDays(attendances), leaves, leaveMap: leaveDates(leaves) };
      state.status = `${attendances.length} records · loaded ${new Date().toLocaleTimeString([], { timeStyle: 'short' })}`;
    } catch (e) {
      body.innerHTML = `<p class="empty">Could not load data: ${esc(e.message)}</p>`;
    }
    render();
  }

  root.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (e.target === overlay || (t && 'close' in t.dataset)) return overlay.classList.remove('open');
    if (!t) return;
    if (t.classList.contains('fab')) {
      overlay.classList.add('open');
      state.period = state.period || todayStr().slice(0, 7);
      return state.data ? render() : load();
    }
    if ('resync' in t.dataset) return load();
    if (!state.data) return;
    if (t.dataset.export) return t.dataset.export === 'html' ? exportHtml() : exportPdf();
    if (t.dataset.tab) state.tab = t.dataset.tab;
    else if (t.dataset.period) state.period = t.dataset.period;
    else if (t.dataset.year) state.leaveYear = t.dataset.year;
    else return;
    render();
  });
  root.addEventListener('change', (e) => {
    if (e.target.tagName !== 'SELECT') return;
    state.period = e.target.value;
    render();
  });
  document.addEventListener('keydown', (e) => e.key === 'Escape' && overlay.classList.remove('open'));
})();
