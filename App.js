/* ---------- tiny helpers ---------- */
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const uid = () => Math.random().toString(36).slice(2, 9);
const money = (n) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);
const today = () => new Date().toISOString().slice(0, 10);

// auto-assigned so each job is still color-coded at a glance (no picker UI)
const COLORS = ["#1F8A70", "#E4572E", "#2E86AB", "#6A4C93",
                "#C9A227", "#B5446E", "#3D5A80", "#8C5E58"];

/* ---------- persistence ---------- */
const DB = {
  load(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch { return fallback; }
  },
  save(key, val) { localStorage.setItem(key, JSON.stringify(val)); },
};

let jobs    = DB.load("tt_jobs", null);
let shifts  = DB.load("tt_shifts", []);
let activeJobId = DB.load("tt_active", null);

// First run: seed a default job that matches your original C++ constants.
if (!jobs || jobs.length === 0) {
  jobs = [{
    id: uid(), name: "Server", color: "#1F8A70",
    rate: 2.13, tipout: 8, tax: 15, otRule: "weekly", otMult: 1.5,
  }];
}
if (!activeJobId || !jobs.find((j) => j.id === activeJobId)) {
  activeJobId = jobs[0].id;
}

const persist = () => {
  DB.save("tt_jobs", jobs);
  DB.save("tt_shifts", shifts);
  DB.save("tt_active", activeJobId);
};
const getActiveJob = () => jobs.find((j) => j.id === activeJobId);

/* ============================================================
   CALC ENGINE  (your Payroll class, in JS, plus overtime)
   ============================================================ */
const calc = {
  // split a shift's hours into regular + overtime based on the job's rule
  splitHours(hours, job, priorWeekHours = 0) {
    if (job.otRule === "daily") {
      const reg = Math.min(hours, 8);
      return { reg, ot: Math.max(0, hours - 8) };
    }
    // weekly: only hours past 40 in the week are OT
    const regBefore = Math.min(priorWeekHours, 40);
    const regAfter  = Math.min(priorWeekHours + hours, 40);
    const reg = Math.max(0, regAfter - regBefore);
    return { reg, ot: hours - reg };
  },
  hourlyPay(reg, ot, job) { return reg * job.rate + ot * job.rate * job.otMult; },
  tipout(sales, job)      { return sales * (job.tipout / 100); },
  finalTips(tips, sales, job) { return tips - this.tipout(sales, job); },
  gross(hourly, finalTips)    { return hourly + finalTips; },
  tax(gross, job)             { return gross * (job.tax / 100); },
  net(gross, job)             { return gross - this.tax(gross, job); },

  // full breakdown for one shift
  breakdown(shift, job, priorWeekHours = 0) {
    const { reg, ot } = this.splitHours(shift.hours, job, priorWeekHours);
    const hourly    = this.hourlyPay(reg, ot, job);
    const tipout    = this.tipout(shift.sales, job);
    const finalTips = this.finalTips(shift.tips, shift.sales, job);
    const gross     = this.gross(hourly, finalTips);
    const tax       = this.tax(gross, job);
    const net       = this.net(gross, job);
    return { reg, ot, hourly, tipout, finalTips, gross, tax, net };
  },
};

/* ---------- week grouping (Monday start) ---------- */
function weekKey(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const offset = (d.getDay() + 6) % 7; // Mon = 0
  d.setDate(d.getDate() - offset);
  return d.toISOString().slice(0, 10);
}

// How many hours were already worked at this job, in the same week,
// on shifts dated before this one. Used so weekly OT is allocated correctly.
function priorWeekHours(shift, job) {
  const wk = weekKey(shift.date);
  return shifts
    .filter((s) => s.jobId === job.id && s !== shift && weekKey(s.date) === wk)
    .filter((s) => s.date < shift.date || (s.date === shift.date && s.id < shift.id))
    .reduce((sum, s) => sum + s.hours, 0);
}

/* ============================================================
   RENDER
   ============================================================ */
function applyJobColor(job) {
  document.documentElement.style.setProperty("--job", job.color);
  document.documentElement.style.setProperty(
    "--job-soft", `color-mix(in srgb, ${job.color} 10%, transparent)`);
}

function renderJobBar() {
  const bar = $("#jobBar");
  bar.innerHTML = "";
  jobs.forEach((job) => {
    const chip = document.createElement("button");
    chip.className = "chip" + (job.id === activeJobId ? " is-active" : "");
    chip.style.setProperty("--c", job.color);
    chip.innerHTML = `<span class="dot"></span>${job.name}`;
    chip.onclick = () => { activeJobId = job.id; persist(); renderAll(); };
    bar.appendChild(chip);
  });
  const add = document.createElement("button");
  add.className = "chip add";
  add.textContent = "+ New job";
  add.onclick = () => { showPanel("jobs"); resetJobForm(); $("#j-name").focus(); };
  bar.appendChild(add);
}

/* ----- live breakdown ----- */
function renderReceipt() {
  const job = getActiveJob();
  $("#logJobName").textContent = job.name;
  $("#r-job").textContent = job.name;

  const hours = parseFloat($("#f-hours").value) || 0;
  const tips  = parseFloat($("#f-tips").value)  || 0;
  const sales = parseFloat($("#f-sales").value) || 0;
  const date  = $("#f-date").value || today();
  $("#r-date").textContent = date;

  // estimate prior week hours from saved shifts (so weekly OT preview is real)
  const prior = job.otRule === "weekly"
    ? shifts.filter((s) => s.jobId === job.id && weekKey(s.date) === weekKey(date))
            .reduce((sum, s) => sum + s.hours, 0)
    : 0;

  const b = calc.breakdown({ hours, tips, sales, date }, job, prior);

  const rows = [
    ["Regular hours", `${b.reg.toFixed(2)} hrs`, ""],
    ...(b.ot > 0 ? [["Overtime hours", `${b.ot.toFixed(2)} hrs @ ${job.otMult}×`, "ot"]] : []),
    ["Hourly pay", money(b.hourly), ""],
    ["Tips earned", money(tips), ""],
    [`Tipout (${job.tipout}%)`, "−" + money(b.tipout), "neg"],
    ["Tips after tipout", money(b.finalTips), b.finalTips < 0 ? "neg" : ""],
    ["Gross pay", money(b.gross), b.gross < 0 ? "neg" : ""],
    [`Tax (${job.tax}%)`, "−" + money(b.tax), "neg"],
  ];
  $("#r-tape").innerHTML = rows
    .map(([k, v, cls]) => `<li class="${cls}"><span>${k}</span><span>${v}</span></li>`)
    .join("");
  $("#r-net").textContent = money(b.net);
  $("#r-stamp").textContent = b.ot > 0 ? `Includes ${b.ot.toFixed(2)} overtime hrs` : "Regular shift";
}

/* ----- history ----- */
function renderHistory() {
  const list = $("#historyList");
  if (shifts.length === 0) {
    list.innerHTML = `<p class="empty">No shifts logged yet. Add one from the “Log shift” tab.</p>`;
    return;
  }
  const sorted = [...shifts].sort((a, b) =>
    a.date === b.date ? b.id.localeCompare(a.id) : b.date.localeCompare(a.date));

  list.innerHTML = sorted.map((s) => {
    const job = jobs.find((j) => j.id === s.jobId);
    if (!job) return "";
    const b = calc.breakdown(s, job, priorWeekHours(s, job));
    return `
      <div class="hrow" style="--c:${job.color}">
        <div class="stripe"></div>
        <div class="h-main">
          <div class="h-job">${job.name}</div>
          <div class="h-meta">${s.date} · ${s.hours.toFixed(2)} hrs · tips ${money(s.tips)} · sales ${money(s.sales)}</div>
        </div>
        ${b.ot > 0 ? `<span class="h-ot">${b.ot.toFixed(1)} OT</span>` : `<span></span>`}
        <div style="display:flex;align-items:center;gap:6px">
          <span class="h-net">${money(b.net)}</span>
          <button class="h-del" title="Delete" data-del="${s.id}">×</button>
        </div>
      </div>`;
  }).join("");

  $$("[data-del]").forEach((btn) => {
    btn.onclick = () => {
      shifts = shifts.filter((s) => s.id !== btn.dataset.del);
      persist(); renderAll(); toast("Shift deleted");
    };
  });
}

/* ----- pay period ----- */
function renderPeriod() {
  const start = $("#p-start").value;
  const end   = $("#p-end").value;
  const allJobs = $("#p-alljobs").checked;
  const box = $("#periodResult");
  if (!start || !end) { box.innerHTML = `<p class="note">Pick a start and end date to see totals.</p>`; return; }

  const inRange = shifts.filter((s) => {
    if (s.date < start || s.date > end) return false;
    if (!allJobs && s.jobId !== activeJobId) return false;
    return true;
  });
  if (inRange.length === 0) { box.innerHTML = `<p class="empty">No shifts in that range.</p>`; return; }

  const t = { hours: 0, ot: 0, tips: 0, tipout: 0, gross: 0, tax: 0, net: 0 };
  inRange.forEach((s) => {
    const job = jobs.find((j) => j.id === s.jobId);
    const b = calc.breakdown(s, job, priorWeekHours(s, job));
    t.hours += s.hours; t.ot += b.ot; t.tips += s.tips;
    t.tipout += b.tipout; t.gross += b.gross; t.tax += b.tax; t.net += b.net;
  });

  box.innerHTML = `
    <div class="stat-grid">
      <div class="stat hero"><div class="k">Take-home total</div><div class="v">${money(t.net)}</div></div>
      <div class="stat"><div class="k">Shifts</div><div class="v">${inRange.length}</div></div>
      <div class="stat"><div class="k">Hours (${t.ot.toFixed(1)} OT)</div><div class="v">${t.hours.toFixed(1)}</div></div>
      <div class="stat"><div class="k">Tips kept</div><div class="v">${money(t.tips - t.tipout)}</div></div>
      <div class="stat"><div class="k">Gross</div><div class="v">${money(t.gross)}</div></div>
      <div class="stat"><div class="k">Tax withheld</div><div class="v">${money(t.tax)}</div></div>
    </div>`;
}

/* ----- jobs panel ----- */
function renderJobList() {
  const list = $("#jobList");
  list.innerHTML = jobs.map((j) => `
    <div class="job-card" style="--c:${j.color}">
      <span class="dot"></span>
      <div class="jc-body">
        <div class="jc-name">${j.name}</div>
        <div class="jc-meta">$${j.rate}/hr · ${j.tipout}% tipout · ${j.tax}% tax · ${j.otRule === "weekly" ? "40+hr" : "8+hr"} OT @ ${j.otMult}×</div>
      </div>
      <button class="icon-btn" data-edit="${j.id}">Edit</button>
      ${jobs.length > 1 ? `<button class="icon-btn" data-jdel="${j.id}">Delete</button>` : ""}
    </div>`).join("");

  $$("[data-edit]").forEach((b) => b.onclick = () => editJob(b.dataset.edit));
  $$("[data-jdel]").forEach((b) => b.onclick = () => deleteJob(b.dataset.jdel));
}

/* ---------- job form ---------- */
let editingJobId = null;
let pickedColor = COLORS[0];   // auto-assigned color for the next new job

function resetJobForm() {
  editingJobId = null;
  $("#jobFormTitle").textContent = "New job";
  $("#jobSaveBtn").textContent = "Add job";
  $("#jobCancelBtn").hidden = true;
  $("#jobForm").reset();
  pickedColor = COLORS[jobs.length % COLORS.length];
  setOtRule("weekly");
}

function editJob(id) {
  const j = jobs.find((x) => x.id === id);
  editingJobId = id;
  $("#jobFormTitle").textContent = "Edit job";
  $("#jobSaveBtn").textContent = "Save changes";
  $("#jobCancelBtn").hidden = false;
  $("#j-name").value = j.name;
  $("#j-rate").value = j.rate;
  $("#j-tipout").value = j.tipout;
  $("#j-tax").value = j.tax;
  $("#j-otmult").value = j.otMult;
  pickedColor = j.color;   // keep its existing color on save
  setOtRule(j.otRule);
  showPanel("jobs");
}

function deleteJob(id) {
  const used = shifts.some((s) => s.jobId === id);
  const msg = used
    ? "Delete this job and all of its logged shifts?"
    : "Delete this job?";
  if (!confirm(msg)) return;
  jobs = jobs.filter((j) => j.id !== id);
  shifts = shifts.filter((s) => s.jobId !== id);
  if (activeJobId === id) activeJobId = jobs[0].id;
  persist(); resetJobForm(); renderAll(); toast("Job deleted");
}

function setOtRule(val) {
  $$("#j-otrule .seg").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.val === val));
}
function getOtRule() {
  return $("#j-otrule .seg.is-active").dataset.val;
}

/* ============================================================
   WIRING
   ============================================================ */
function showPanel(name) {
  $$(".navitem").forEach((t) => {
    const on = t.dataset.panel === name;
    t.classList.toggle("is-active", on);
    if (on) t.setAttribute("aria-current", "page");
    else t.removeAttribute("aria-current");
  });
  $$(".panel").forEach((p) => p.classList.toggle("is-active", p.id === "panel-" + name));
  // on phones the nav is at the bottom, so jump back up to the panel
  if (window.matchMedia("(max-width: 719px)").matches) {
    window.scrollTo({ top: 0, behavior: "instant" in document.body.style ? "instant" : "auto" });
  }
}

function renderAll() {
  applyJobColor(getActiveJob());
  renderJobBar();
  renderReceipt();
  renderHistory();
  renderPeriod();
  renderJobList();
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg; el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

function init() {
  // defaults
  $("#f-date").value = today();
  const d = new Date(); const past = new Date(); past.setDate(d.getDate() - 13);
  $("#p-start").value = past.toISOString().slice(0, 10);
  $("#p-end").value = today();

  // tabs
  $$(".navitem").forEach((t) => t.onclick = () => showPanel(t.dataset.panel));

  // live breakdown
  ["#f-hours", "#f-tips", "#f-sales", "#f-date"].forEach((sel) =>
    $(sel).addEventListener("input", renderReceipt));

  // save shift
  $("#shiftForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const shift = {
      id: uid(),
      jobId: activeJobId,
      date: $("#f-date").value || today(),
      hours: parseFloat($("#f-hours").value) || 0,
      tips:  parseFloat($("#f-tips").value)  || 0,
      sales: parseFloat($("#f-sales").value) || 0,
    };
    shifts.push(shift);
    persist();
    $("#f-hours").value = $("#f-tips").value = $("#f-sales").value = "";
    renderAll(); toast("Shift saved");
  });

  // period recompute on input
  ["#p-start", "#p-end"].forEach((s) => $(s).addEventListener("input", renderPeriod));
  $("#p-alljobs").addEventListener("change", renderPeriod);

  // job OT segmented control
  $$("#j-otrule .seg").forEach((b) => b.onclick = () => setOtRule(b.dataset.val));

  // job form submit
  $("#jobForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const data = {
      name: $("#j-name").value.trim() || "Untitled job",
      color: pickedColor,
      rate: parseFloat($("#j-rate").value) || 0,
      tipout: parseFloat($("#j-tipout").value) || 0,
      tax: parseFloat($("#j-tax").value) || 0,
      otMult: parseFloat($("#j-otmult").value) || 1.5,
      otRule: getOtRule(),
    };
    if (editingJobId) {
      Object.assign(jobs.find((j) => j.id === editingJobId), data);
      toast("Job updated");
    } else {
      const job = { id: uid(), ...data };
      jobs.push(job); activeJobId = job.id;
      toast("Job added");
    }
    persist(); resetJobForm(); renderAll();
  });
  $("#jobCancelBtn").addEventListener("click", resetJobForm);

  resetJobForm();
  renderAll();
}

document.addEventListener("DOMContentLoaded", init);