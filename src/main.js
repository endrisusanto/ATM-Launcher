import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./styles.css";
import atmLogo from "./assets/ATM.png";

const state = {
  devices: [],
  selected: new Set(),
  tools: ["getprop", "bvt", "svt", "sdt"],
  concurrency: 1,
  running: false,
  loadedDevices: false,
  logLines: [],
  results: new Map(),
  summary: {
    executed: 0,
    pass: 0,
    fail: 0,
    pending: 0,
    runtime: "00:00:00",
  },
  runStartedAt: null,
};

const testcases = [
  { tool: "getprop", name: "GetpropSnapshot", description: "Collect device build properties" },
  { tool: "bvt", name: "BasicInfoTests", description: "Run BVT basic info compatibility checks" },
  { tool: "svt", name: "SVTPreloadValidation", description: "Run SVT preload validation" },
  { tool: "sdt", name: "SDTDeviceTest", description: "Run SDT silent test package" },
];

const app = document.querySelector("#app");

app.innerHTML = `
  <div class="shell">
    <div class="splash" id="splash">
      <img src="${atmLogo}" alt="ATM" />
    </div>
    <header class="titlebar">
      <div class="brand">
        <img class="brand-mark" src="${atmLogo}" alt="ATM" />
        <div>
          <h1>ATM Batch Launcher</h1>
          <p>Sequence runner for ATM test tools</p>
        </div>
      </div>
      <button class="icon-button" id="preflightBtn" title="Preflight">⚙</button>
    </header>

    <aside class="devices-pane">
      <div class="pane-head">
        <h2>DEVICES</h2>
        <div class="pane-actions">
          <button class="mini-button" id="unselectBtn">Unselect</button>
          <button class="mini-button" id="refreshBtn">Refresh</button>
        </div>
      </div>
      <div class="device-list" id="deviceList"></div>
      <footer>© 2026 ATM Automation</footer>
    </aside>

    <main class="workspace">
      <div class="toolbar">
        <button class="run-button" id="runBtn">Run Selected</button>
        <button class="ghost-button" id="cancelBtn" disabled>Cancel</button>
        <div class="toolbar-spacer"></div>
        <label class="retry">Concurrency: <input id="concurrencyInput" type="number" min="1" max="16" value="1" /></label>
        <label class="check"><input id="allTools" type="checkbox" checked /> All</label>
        <label class="check"><input id="onlyFailed" type="checkbox" /> Failed</label>
      </div>

      <section class="test-area" id="testArea"></section>
    </main>

    <aside class="summary-pane">
      <section class="summary">
        <h2>SUMMARIZE</h2>
        <div class="metric-row"><span>Executed:</span><strong id="executedMetric">0</strong></div>
        <div class="metric-row"><span>Started, not have result:</span><strong id="pendingMetric">0</strong></div>
        <div class="metric-row"><span>Pass:</span><strong class="pass" id="passMetric">0</strong></div>
        <div class="metric-row"><span>Fail:</span><strong class="fail" id="failMetric">0</strong></div>
        <div class="metric-row"><span>Total runtime:</span><strong id="runtimeMetric">00:00:00</strong></div>
      </section>
      <section class="running-log">
        <div class="log-head">
          <h2>RUNNING LOG</h2>
          <button id="clearLogBtn">[ Clear Log ]</button>
        </div>
        <pre id="logBox"></pre>
      </section>
      <footer class="status-line" id="statusLine">Standby</footer>
    </aside>
  </div>
`;

const els = {
  deviceList: document.querySelector("#deviceList"),
  testArea: document.querySelector("#testArea"),
  logBox: document.querySelector("#logBox"),
  runBtn: document.querySelector("#runBtn"),
  cancelBtn: document.querySelector("#cancelBtn"),
  refreshBtn: document.querySelector("#refreshBtn"),
  unselectBtn: document.querySelector("#unselectBtn"),
  preflightBtn: document.querySelector("#preflightBtn"),
  clearLogBtn: document.querySelector("#clearLogBtn"),
  allTools: document.querySelector("#allTools"),
  onlyFailed: document.querySelector("#onlyFailed"),
  concurrencyInput: document.querySelector("#concurrencyInput"),
  statusLine: document.querySelector("#statusLine"),
  executedMetric: document.querySelector("#executedMetric"),
  pendingMetric: document.querySelector("#pendingMetric"),
  passMetric: document.querySelector("#passMetric"),
  failMetric: document.querySelector("#failMetric"),
  runtimeMetric: document.querySelector("#runtimeMetric"),
};

els.refreshBtn.addEventListener("click", refreshDevices);
els.unselectBtn.addEventListener("click", () => {
  const readyDevices = state.devices.filter((device) => device.state === "device");
  if (state.selected.size === readyDevices.length && readyDevices.length > 0) {
    state.selected.clear();
  } else {
    state.selected = new Set(readyDevices.map((device) => device.serial));
  }
  render();
});
els.clearLogBtn.addEventListener("click", () => {
  state.logLines = [];
  renderLog();
});
els.allTools.addEventListener("change", () => {
  state.tools = els.allTools.checked ? allToolIds() : [];
  els.onlyFailed.checked = false;
  renderTests();
  updateRunButton();
});
els.onlyFailed.addEventListener("change", () => {
  if (els.onlyFailed.checked) {
    state.tools = failedToolIds();
    els.allTools.checked = state.tools.length === testcases.length;
  }
  renderTests();
  updateRunButton();
});
els.concurrencyInput.addEventListener("input", () => {
  state.concurrency = Math.max(1, Number(els.concurrencyInput.value || 1));
});
els.preflightBtn.addEventListener("click", runPreflight);
els.runBtn.addEventListener("click", runBatch);
els.cancelBtn.addEventListener("click", cancelBatch);

listen("atm-run-log", (event) => {
  const line = String(event.payload || "");
  appendLog(line);
  collectResultFromLine(line);
});

listen("atm-run-finished", (event) => {
  const exitCode = Number(event.payload?.exit_code || 0);
  state.running = false;
  els.runBtn.disabled = false;
  els.cancelBtn.disabled = true;
  if (exitCode === 130) {
    markRunningAs("CANCELLED");
    els.statusLine.textContent = "Cancelled";
  } else {
    els.statusLine.textContent = exitCode === 0 ? "Completed" : "Completed with errors";
  }
  renderSummary();
  renderTests();
  updateRunButton();
});

function render() {
  renderDevices();
  renderTests();
  renderSummary();
  renderLog();
  updateRunButton();
}

function updateRunButton() {
  const count = state.selected.size;
  const testcaseCount = selectedTestcases().length;
  els.runBtn.textContent = `Run Selected (${count})`;
  els.runBtn.disabled = state.running || count === 0 || testcaseCount === 0;
  els.allTools.checked = state.tools.length === testcases.length;
  updateSelectToggle();
}

function updateSelectToggle() {
  const readyCount = state.devices.filter((device) => device.state === "device").length;
  els.unselectBtn.textContent = state.selected.size === readyCount && readyCount > 0 ? "Unselect" : "Select";
  els.unselectBtn.disabled = readyCount === 0;
}

function renderDevices() {
  if (!state.devices.length) {
    els.deviceList.innerHTML = `<div class="empty">No devices detected</div>`;
    return;
  }
  els.deviceList.innerHTML = state.devices.map((device) => {
    const selected = state.selected.has(device.serial);
    const ready = device.state === "device";
    return `
      <article class="device-card ${selected ? "selected" : ""} ${ready ? "" : "disabled"}" data-serial="${device.serial}" role="button" tabindex="${ready ? "0" : "-1"}">
        <div class="device-top">
          <span class="check-dot ${selected ? "checked" : ""}">${selected ? "✓" : ""}</span>
          <div>
            <strong>${escapeHtml(device.model || "Unknown")}</strong>
            <p><b>${escapeHtml(device.serial)}</b> · Android ${escapeHtml(device.android || "-")} · <span>${escapeHtml(device.state)}</span></p>
          </div>
          <button class="result-pill" data-serial="${device.serial}" ${ready ? "" : "disabled"}>RESULT</button>
        </div>
        <div class="device-meta">
          <span><small>SPL</small>${escapeHtml(device.security_patch || "-")}</span>
          <span><small>CARRIER</small>${escapeHtml(device.carrier || device.csc || "-")}</span>
          <span><small>REGION</small>${escapeHtml(device.region || "INDONESIA")}</span>
          <span><small>PDA</small>${escapeHtml(device.build || "-")}</span>
          <span><small>MODEM</small>${escapeHtml(device.modem || device.build || "-")}</span>
          <span><small>CSC</small>${escapeHtml(device.csc || "-")}</span>
        </div>
      </article>
    `;
  }).join("");
  els.deviceList.querySelectorAll(".device-card").forEach((card) => {
    card.addEventListener("click", () => {
      const serial = card.dataset.serial;
      if (state.selected.has(serial)) state.selected.delete(serial);
      else state.selected.add(serial);
      render();
    });
    card.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      card.click();
    });
  });
  els.deviceList.querySelectorAll(".result-pill").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      openDeviceResults(button.dataset.serial);
    });
  });
}

function renderTests() {
  const devices = selectedDevices();
  const visibleDevices = devices.length ? devices : state.devices.filter((d) => d.state === "device");
  if (!visibleDevices.length) {
    els.testArea.innerHTML = `<div class="empty large">Refresh devices to load testcase groups</div>`;
    return;
  }
  els.testArea.innerHTML = visibleDevices.map((device) => {
    const rows = testcases.map((testcase) => {
      const key = `${device.serial}:${testcase.tool}`;
      const result = state.results.get(key) || { status: "READY", time: "-" };
      const checked = state.tools.includes(testcase.tool);
      const progress = progressForStatus(result.status);
      const displayTime = result.status === "RUNNING" && result.startedAt
        ? formatDuration(Date.now() - result.startedAt)
        : result.time;
      return `
        <tr class="${checked ? "checked" : ""}" data-tool="${testcase.tool}">
          <td><button class="row-check ${checked ? "checked" : ""}" data-tool="${testcase.tool}" title="Select testcase">${checked ? "✓" : ""}</button></td>
          <td>
            <span class="test-name">${escapeHtml(testcase.name)}</span>
            <small>${escapeHtml(testcase.description)}</small>
            <div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div>
          </td>
          <td class="${result.status.toLowerCase()}">${escapeHtml(result.status)}</td>
          <td>${escapeHtml(displayTime)}</td>
        </tr>
      `;
    }).join("");
    return `
      <article class="test-card">
        <header>
          <div>
            <h3>${escapeHtml(device.model || "Unknown")}</h3>
            <p>${escapeHtml(device.serial)} · Android ${escapeHtml(device.android || "-")}</p>
          </div>
          <span>${selectedTestcases().length}/${testcases.length} checked</span>
        </header>
        <table>
          <thead><tr><th>Select</th><th>Testcase</th><th>Result</th><th>Time</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </article>
    `;
  }).join("");
  els.testArea.querySelectorAll(".row-check").forEach((button) => {
    button.addEventListener("click", () => {
      toggleTool(button.dataset.tool);
      els.onlyFailed.checked = false;
      renderTests();
      updateRunButton();
    });
  });
}

function renderSummary() {
  state.summary.executed = Array.from(state.results.values()).filter((r) => ["PASS", "FAIL", "ERROR", "INCOMPLETE"].includes(r.status)).length;
  state.summary.pass = Array.from(state.results.values()).filter((r) => r.status === "PASS").length;
  state.summary.fail = Array.from(state.results.values()).filter((r) => r.status === "FAIL" || r.status === "ERROR").length;
  state.summary.pending = state.running ? Math.max(0, state.selected.size * selectedTestcases().length - state.summary.executed) : 0;
  if (state.runStartedAt) state.summary.runtime = formatDuration(Date.now() - state.runStartedAt);
  els.executedMetric.textContent = state.summary.executed;
  els.pendingMetric.textContent = state.summary.pending;
  els.passMetric.textContent = state.summary.pass;
  els.failMetric.textContent = state.summary.fail;
  els.runtimeMetric.textContent = state.summary.runtime;
}

function renderLog() {
  els.logBox.textContent = state.logLines.slice(-600).join("\n");
  els.logBox.scrollTop = els.logBox.scrollHeight;
}

async function refreshDevices() {
  els.statusLine.textContent = "Refreshing devices";
  appendLog("[launcher] Refreshing devices...");
  try {
    const previousSelection = state.selected;
    state.devices = await invoke("list_devices");
    state.selected = new Set(
      state.devices
        .filter((d) => d.state === "device" && (!state.loadedDevices || previousSelection.has(d.serial)))
        .map((d) => d.serial),
    );
    state.loadedDevices = true;
    appendLog(`[launcher] Found ${state.devices.length} device row(s).`);
  } catch (error) {
    appendLog(`[launcher] Refresh failed: ${error}`);
  }
  els.statusLine.textContent = "Standby";
  render();
}

async function runPreflight() {
  appendLog("[launcher] Running preflight...");
  try {
    const lines = await invoke("preflight");
    lines.forEach(appendLog);
  } catch (error) {
    appendLog(`[launcher] Preflight failed: ${error}`);
  }
}

async function runBatch() {
  const devices = selectedDevices().map((d) => d.serial);
  const tools = selectedTestcases().map((testcase) => testcase.tool);
  if (!devices.length || !tools.length) return;
  state.running = true;
  state.runStartedAt = Date.now();
  state.results.clear();
  devices.forEach((serial) => {
    tools.forEach((tool) => {
      state.results.set(`${serial}:${tool}`, { status: "RUNNING", time: "00:00:00", startedAt: Date.now() });
    });
  });
  els.runBtn.disabled = true;
  els.cancelBtn.disabled = false;
  els.statusLine.textContent = "Running";
  appendLog(`[launcher] Starting batch: devices=${devices.join(", ")} tools=${tools.join(", ")}`);
  render();
  try {
    await invoke("run_batch", {
      request: {
        devices,
        tools,
        concurrency: state.concurrency,
        update: false,
      },
    });
  } catch (error) {
    appendLog(`[launcher] Run failed: ${error}`);
    state.running = false;
    els.runBtn.disabled = false;
    els.cancelBtn.disabled = true;
  }
  render();
}

async function cancelBatch() {
  appendLog("[launcher] Cancel requested.");
  els.cancelBtn.disabled = true;
  try {
    await invoke("cancel_batch");
  } catch (error) {
    appendLog(`[launcher] Cancel failed: ${error}`);
    els.cancelBtn.disabled = false;
  }
}

async function openDeviceResults(serial) {
  if (!serial) return;
  appendLog(`[launcher] Opening results for ${serial}...`);
  try {
    const path = await invoke("open_device_results", { serial });
    appendLog(`[launcher] Opened: ${path}`);
  } catch (error) {
    appendLog(`[launcher] Open results failed: ${error}`);
  }
}

function selectedDevices() {
  return state.devices.filter((device) => state.selected.has(device.serial));
}

function selectedTestcases() {
  return testcases.filter((testcase) => state.tools.includes(testcase.tool));
}

function allToolIds() {
  return testcases.map((testcase) => testcase.tool);
}

function failedToolIds() {
  const visibleSerials = selectedDevices().map((device) => device.serial);
  const serials = visibleSerials.length ? visibleSerials : state.devices.map((device) => device.serial);
  return testcases
    .filter((testcase) => serials.some((serial) => {
      const status = state.results.get(`${serial}:${testcase.tool}`)?.status;
      return status === "FAIL" || status === "ERROR";
    }))
    .map((testcase) => testcase.tool);
}

function toggleTool(tool) {
  if (!tool) return;
  const next = new Set(state.tools);
  if (next.has(tool)) next.delete(tool);
  else next.add(tool);
  state.tools = testcases.filter((testcase) => next.has(testcase.tool)).map((testcase) => testcase.tool);
}

function progressForStatus(status) {
  if (status === "RUNNING") return 45;
  if (["PASS", "FAIL", "ERROR", "INCOMPLETE", "CANCELLED"].includes(status)) return 100;
  return 0;
}

function markRunningAs(status) {
  state.results.forEach((result, key) => {
    if (result.status === "RUNNING") {
      state.results.set(key, { status, time: result.startedAt ? formatDuration(Date.now() - result.startedAt) : result.time });
    }
  });
}

function appendLog(line) {
  state.logLines.push(line);
  if (state.logLines.length > 1200) state.logLines.shift();
  renderLog();
}

function collectResultFromLine(line) {
  const start = line.match(/\[([^\]]+)] START ([^:]+):/);
  if (start) {
    const serial = start[1];
    const tool = start[2].toLowerCase();
    state.results.set(`${serial}:${tool}`, { status: "RUNNING", time: "00:00:00", startedAt: Date.now() });
    renderSummary();
    renderTests();
    return;
  }
  const match = line.match(/\[([^\]]+)] END ([^ ]+) .* result=([A-Z]+)/);
  if (!match) return;
  const serial = match[1];
  const tool = match[2].toLowerCase();
  const status = match[3];
  state.results.set(`${serial}:${tool}`, { status, time: formatDuration(Date.now() - state.runStartedAt) });
  renderSummary();
  renderTests();
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

setInterval(() => {
  if (state.running) {
    renderSummary();
    renderTests();
  }
}, 1000);

refreshDevices();
