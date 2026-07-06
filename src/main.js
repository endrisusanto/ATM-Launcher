import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import "./styles.css";
import atmLogo from "./assets/ATM.png";
import ctsAvailable from "./assets/cts-verifier/ListTestCaseAvailable.json";
import ctsActivities from "./assets/cts-verifier/TestCaseToActivity.json";

const state = {
  devices: [],
  selected: new Set(),
  tools: ["getprop", "bvt", "svt", "sdt"],
  concurrency: 1,
  running: false,
  loadedDevices: false,
  atmRoot: localStorage.getItem("atmRoot") || "",
  wifi: {
    enabled: localStorage.getItem("atmWifiAutoConnect") === "true",
    ssid: localStorage.getItem("atmWifiSsid") || "RTT / IEEE 802.11",
    password: localStorage.getItem("atmWifiPassword") || "1234qwer",
  },
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
  ctsVerifier: {
    tests: [],
    selected: new Set(),
    results: new Map(),
  },
  activeTasks: 0,
  pendingJavaAfterCts: null,
  lampStates: new Map(),
};

function formatStatus(status) {
  return status === "Error" ? "Cek Log-nya blay" : escapeHtml(status);
}

const testcases = [
  { tool: "cts_verifier", name: "CTS Verifier", description: "Android Compatibility Test Suite Verifier Auto" },
  { tool: "getprop", name: "GetpropSnapshot", description: "Collect device build properties" },
  { tool: "bvt", name: "BasicInfoTests", description: "Run BVT basic info compatibility checks" },
  { tool: "svt", name: "SVTPreloadValidation", description: "Run SVT preload validation" },
  { tool: "sdt", name: "SDTDeviceTest", description: "Run SDT silent test package" },
];

const terminalStatuses = ["Pass", "Warning", "Failed", "Error"];

const app = document.querySelector("#app");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function initScrcpyWrap() {
  app.innerHTML = `
    <main class="scrcpy-wrap">
      <section class="scrcpy-grid" id="scrcpyGrid">
        <div class="empty large">Waiting for scrcpy device...</div>
      </section>
      <button class="scrcpy-floating-refresh" id="scrcpyRefreshBtn">Refresh</button>
    </main>
  `;

  const grid = document.querySelector("#scrcpyGrid");
  const refreshButton = document.querySelector("#scrcpyRefreshBtn");
  let devices = [];
  const frameUrls = new Map();
  let frameInFlight = false;
  let frameCursor = 0;

  async function refresh() {
    try {
      devices = await invoke("get_scrcpy_wrap_devices");
      render();
    } catch (error) {
      grid.innerHTML = `<div class="empty large">Scrcpy metadata failed: ${escapeHtml(error)}</div>`;
    }
  }

  function render() {
    if (!devices.length) {
      grid.innerHTML = `<div class="empty large">Trigger SCRCPY from a device card</div>`;
      return;
    }
    grid.style.setProperty("--scrcpy-count", devices.length);
    applyScrcpyGridLayout();
    grid.innerHTML = devices.map((device) => `
      <article class="scrcpy-tile">
        ${renderScrcpyFrame(device)}
        <div class="scrcpy-overlay">
          <header>
            <div>
              <h2>${escapeHtml(device.model || "Unknown")}</h2>
              <p>${escapeHtml(device.serial)}</p>
            </div>
            <b class="status-pass"><small>Battery level:</small>${escapeHtml(device.battery_level || "-")}</b>
          </header>
        </div>
        <div class="scrcpy-tile-actions">
          <button data-scrcpy-action="home" data-serial="${escapeHtml(device.serial)}" title="Home">HOME</button>
          <button data-scrcpy-action="brightness" data-serial="${escapeHtml(device.serial)}" title="Max brightness">BRIGHT</button>
          <button data-scrcpy-action="frame" data-serial="${escapeHtml(device.serial)}" title="Update screencap">CAP</button>
          <button data-scrcpy-action="native" data-serial="${escapeHtml(device.serial)}" title="Open native scrcpy">NATIVE</button>
        </div>
      </article>
    `).join("");
  }

  function renderScrcpyFrame(device) {
    const frameUrl = frameUrls.get(device.serial);
    if (frameUrl) {
      return `<img class="scrcpy-frame" data-frame-serial="${escapeHtml(device.serial)}" src="${frameUrl}" alt="${escapeHtml(device.serial)} screen" />`;
    }
    return `
      <div class="scrcpy-video-placeholder skeleton">
        <strong>${escapeHtml(device.model || "Unknown")}</strong>
        <span>${escapeHtml(device.serial)}</span>
      </div>
    `;
  }

  async function refreshNextFrame() {
    if (frameInFlight || document.hidden || !devices.length) return;
    const device = devices[frameCursor % devices.length];
    frameCursor = (frameCursor + 1) % devices.length;
    frameInFlight = true;
    try {
      await refreshFrameForSerial(device.serial);
    } catch (error) {
      console.warn(`scrcpy frame failed for ${device.serial}`, error);
    } finally {
      frameInFlight = false;
    }
  }

  async function refreshFrameForSerial(serial) {
    const bytes = await invoke("get_scrcpy_frame", { serial });
    if (!isPngBytes(bytes)) throw new Error("Frame is not PNG data");
    const nextUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
    const previousUrl = frameUrls.get(serial);
    frameUrls.set(serial, nextUrl);
    updateFrameImage(serial, nextUrl);
    if (previousUrl) setTimeout(() => URL.revokeObjectURL(previousUrl), 500);
  }

  function applyScrcpyGridLayout() {
    const count = Math.max(1, devices.length);
    const rect = grid.getBoundingClientRect();
    const width = rect.width || window.innerWidth;
    const height = Math.max(1, rect.height || window.innerHeight);
    const portraitW = 9;
    const portraitH = 16;
    let best = { cols: 1, rows: count, score: 0 };
    for (let cols = 1; cols <= count; cols += 1) {
      const rows = Math.ceil(count / cols);
      const cellW = Math.max(1, width / cols);
      const cellH = Math.max(1, height / rows);
      const scale = Math.min(cellW / portraitW, cellH / portraitH);
      const usedW = portraitW * scale;
      const usedH = portraitH * scale;
      const fillRatio = (usedW * usedH) / (cellW * cellH);
      const score = usedW * usedH * fillRatio;
      if (score > best.score) best = { cols, rows, score };
    }
    const { cols, rows } = best;
    grid.style.setProperty("--scrcpy-cols", cols);
    grid.style.setProperty("--scrcpy-rows", rows);
  }

  function isPngBytes(bytes) {
    return bytes?.length >= 8
      && bytes[0] === 0x89
      && bytes[1] === 0x50
      && bytes[2] === 0x4e
      && bytes[3] === 0x47
      && bytes[4] === 0x0d
      && bytes[5] === 0x0a
      && bytes[6] === 0x1a
      && bytes[7] === 0x0a;
  }

  function updateFrameImage(serial, frameUrl) {
    const existing = grid.querySelector(`[data-frame-serial="${CSS.escape(serial)}"]`);
    if (existing) {
      requestAnimationFrame(() => {
        existing.src = frameUrl;
      });
      return;
    }
    render();
  }

  refreshButton.addEventListener("click", refresh);
  grid.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-scrcpy-action]");
    if (!button) return;
    const serial = button.dataset.serial;
    const action = button.dataset.scrcpyAction;
    button.disabled = true;
    try {
      if (action === "home") {
        await invoke("press_device_home", { serial });
      } else if (action === "brightness") {
        await invoke("set_device_lamp", { serial, brighten: true });
      } else if (action === "frame") {
        await refreshFrameForSerial(serial);
      } else if (action === "native") {
        await invoke("open_native_scrcpy", { serial });
      }
    } catch (error) {
      console.warn(`scrcpy ${action} failed for ${serial}`, error);
    } finally {
      button.disabled = false;
    }
  });
  window.addEventListener("resize", () => {
    applyScrcpyGridLayout();
  });
  listen("scrcpy-wrap-updated", refresh);
  refresh().then(refreshNextFrame);
  setInterval(refresh, 30000);
  setInterval(refreshNextFrame, 1200);
}

if (location.hash === "#scrcpy-wrap") {
  initScrcpyWrap();
} else {
app.innerHTML = `
  <div class="shell">
    <div class="splash" id="splash">
      <img src="${atmLogo}" alt="ATM" />
    </div>
    <header class="titlebar">
      <div class="brand">
        <img class="brand-mark" src="${atmLogo}" alt="ATM" />
        <div>
          <h1>ATM Bersama</h1>
          <p>Sequence runner for ATM test tools. Bukan buat narik duit ya!!!</p>
        </div>
      </div>
      <button class="icon-button" id="preflightBtn" title="Settings">⚙</button>
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

    <div class="modal-backdrop hidden" id="settingsModal">
      <section class="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settingsTitle">
        <header>
          <div>
            <h2 id="settingsTitle">SETTINGS</h2>
            <p>ATM root path dan preflight check</p>
          </div>
          <button class="icon-button" id="settingsCloseBtn" title="Close">×</button>
        </header>
        <label class="path-field">
          <span>ATM Path</span>
          <div style="display: flex; gap: 8px;">
            <input id="atmRootInput" type="text" placeholder="/path/to/ATM root" style="flex: 1; min-width: 0;" />
            <button id="browseBtn" class="ghost-button" style="padding: 0 12px; height: 34px;">Browse</button>
          </div>
        </label>
        <section class="settings-section">
          <label class="check"><input id="wifiAutoConnectInput" type="checkbox" /> Auto connect Wi-Fi before test</label>
          <label class="path-field compact">
            <span>Preset SSID</span>
            <input id="wifiSsidInput" type="text" placeholder="Wi-Fi SSID" autocomplete="off" />
          </label>
          <label class="path-field compact">
            <span>Password</span>
            <input id="wifiPasswordInput" type="password" placeholder="Wi-Fi password" autocomplete="off" />
          </label>
        </section>
        <div class="settings-actions">
          <button class="ghost-button" id="autoDetectBtn">Auto Detect</button>
          <button class="ghost-button" id="updateToolsBtn">Update Tools</button>
          <button class="ghost-button" id="settingsCheckBtn">Check</button>
          <button class="run-button" id="settingsSaveBtn">Save</button>
        </div>
        <pre class="settings-output" id="settingsOutput"></pre>
      </section>
    </div>


  </div>
`;

const els = {
  deviceList: document.querySelector("#deviceList"),
  testArea: document.querySelector("#testArea"),
  logBox: document.querySelector("#logBox"),
  runBtn: document.querySelector("#runBtn"),
  cancelBtn: document.querySelector("#cancelBtn"),
  unselectBtn: document.querySelector("#unselectBtn"),
  refreshBtn: document.querySelector("#refreshBtn"),
  preflightBtn: document.querySelector("#preflightBtn"),
  settingsModal: document.querySelector("#settingsModal"),
  settingsCloseBtn: document.querySelector("#settingsCloseBtn"),
  autoDetectBtn: document.querySelector("#autoDetectBtn"),
  updateToolsBtn: document.querySelector("#updateToolsBtn"),
  settingsCheckBtn: document.querySelector("#settingsCheckBtn"),
  settingsSaveBtn: document.querySelector("#settingsSaveBtn"),
  atmRootInput: document.querySelector("#atmRootInput"),
  wifiAutoConnectInput: document.querySelector("#wifiAutoConnectInput"),
  wifiSsidInput: document.querySelector("#wifiSsidInput"),
  wifiPasswordInput: document.querySelector("#wifiPasswordInput"),
  settingsOutput: document.querySelector("#settingsOutput"),
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
  browseBtn: document.querySelector("#browseBtn"),
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
document.addEventListener("DOMContentLoaded", () => {
  els.testArea.innerHTML = "";
  render();
});

let confettiInterval = null;
const confettiContainer = document.createElement("div");
confettiContainer.id = "confetti-container";
document.body.appendChild(confettiContainer);

function startDollarConfetti() {
  if (confettiInterval) return;
  const emojis = ["💲", "💸", "💵"];
  confettiInterval = setInterval(() => {
    const el = document.createElement("div");
    el.className = "confetti";
    el.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    el.style.left = Math.random() * 100 + "vw";
    el.style.animationDuration = Math.random() * 2 + 3 + "s";
    el.style.fontSize = Math.random() * 10 + 20 + "px";

    confettiContainer.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }, 150);
}

function stopDollarConfetti() {
  if (confettiInterval) {
    clearInterval(confettiInterval);
    confettiInterval = null;
  }
  confettiContainer.innerHTML = "";
}

document.addEventListener("click", stopDollarConfetti);
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
els.preflightBtn.addEventListener("click", openSettings);
els.settingsCloseBtn.addEventListener("click", closeSettings);
els.settingsModal.addEventListener("click", (event) => {
  if (event.target === els.settingsModal) closeSettings();
});
els.autoDetectBtn.addEventListener("click", autoDetectAtmRoot);
els.updateToolsBtn.addEventListener("click", updateTools);
els.settingsCheckBtn.addEventListener("click", runPreflight);
els.settingsSaveBtn.addEventListener("click", saveSettings);
els.runBtn.addEventListener("click", runBatch);
els.cancelBtn.addEventListener("click", cancelBatch);
// Removed ctsVerifier event listeners
els.browseBtn.addEventListener("click", async () => {
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select ATM Root Directory",
    });
    const path = normalizeDialogPath(selected);
    if (path) {
      els.atmRootInput.value = path;
      saveSettings(false);
      els.settingsOutput.textContent = `Selected ATM path:\n${path}`;
    }
  } catch (error) {
    els.settingsOutput.textContent = `Browse failed: ${error}`;
    appendLog(`[launcher] Browse failed: ${error}`);
  }
});

listen("atm-run-log", (event) => {
  const line = String(event.payload || "");
  appendLog(line);
  collectResultFromLine(line);
});

function finishBatch(exitCode) {
  state.running = false;
  els.runBtn.disabled = false;
  els.cancelBtn.disabled = true;
  if (exitCode === 130) {
    markRunningAs("Cancelled");
    els.statusLine.textContent = "Cancelled";
  } else {
    els.statusLine.textContent = exitCode === 0 ? "Completed" : "Testnya udah selesai tapi ada beberapa catatan";
  }
  renderSummary();
  renderTests();
  updateRunButton();
  if (exitCode !== 130) startDollarConfetti();
}

listen("atm-run-finished", (event) => {
  const exitCode = Number(event.payload?.exit_code || 0);
  finishBatch(exitCode);
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

  if (els.concurrencyInput && !state.running) {
    els.concurrencyInput.value = count > 0 ? count : 1;
    state.concurrency = Math.max(1, count);
  }

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
	  const lampActive = state.lampStates.get(device.serial);
	  const progress = deviceProgress(device.serial);
    const flow = selected ? `
      <div class="device-flow ${statusClass(progress.status)}">
        <div class="device-flow-top">
          <span>${escapeHtml(progress.label)}</span>
          <strong>${progress.percent}%</strong>
        </div>
        <div class="device-flow-track">
          <div class="device-flow-fill" style="width:${progress.percent}%"></div>
        </div>
      </div>
    ` : "";
    return `
      <article class="device-card ${selected ? "selected" : ""} ${ready ? "" : "disabled"}" data-serial="${device.serial}" role="button" tabindex="${ready ? "0" : "-1"}">
        <div class="device-top">
          <span class="check-dot ${selected ? "checked" : ""}">${selected ? "✓" : ""}</span>
          <div>
            <strong>${escapeHtml(device.model || "Unknown")}</strong>
	            <p><b>${escapeHtml(device.serial)}</b> · Android ${escapeHtml(device.android || "-")} · <span>${escapeHtml(deviceStateLabel(device.state))}</span></p>
	          </div>
	          <div style="display:flex; gap:6px;">
	            <button class="result-pill lamp-button ${lampActive ? "active" : ""}" data-lamp="${device.serial}" ${ready ? "" : "disabled"} title="Toggle Brightness">💡</button>
            <button class="result-pill scrcpy-button" data-scrcpy="${device.serial}" ${ready ? "" : "disabled"}>SCRCPY</button>
            <button class="result-pill" data-serial="${device.serial}" ${ready ? "" : "disabled"}>RESULT</button>
          </div>
        </div>
        <div class="device-meta">
          <span><small>SPL</small>${escapeHtml(device.security_patch || "-")}</span>
          <span><small>CARRIER</small>${escapeHtml(device.carrier || device.csc || "-")}</span>
          <span><small>REGION</small>${escapeHtml(device.region || "INDONESIA")}</span>
          <span><small>PDA</small>${escapeHtml(device.build || "-")}</span>
          <span><small>MODEM</small>${escapeHtml(device.modem || device.build || "-")}</span>
          <span><small>CSC</small>${escapeHtml(device.csc || "-")}</span>
        </div>
        ${flow}
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
  els.deviceList.querySelectorAll("[data-serial].result-pill").forEach((button) => {
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      openDeviceResults(button.dataset.serial);
    });
  });
  els.deviceList.querySelectorAll("[data-lamp]").forEach((button) => {
    button.addEventListener("click", async (e) => {
      e.stopPropagation();
      await toggleLamp(button.dataset.lamp);
    });
  });
  els.deviceList.querySelectorAll("[data-scrcpy]").forEach((button) => {
    button.addEventListener("click", async (e) => {
      e.stopPropagation();
      await openScrcpyWrap(button.dataset.scrcpy);
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
      const result = state.results.get(key) || { status: "Standby", time: "-" };
      const checked = state.tools.includes(testcase.tool);
      const progress = progressForStatus(result.status);
      const isRunning = result.status === "Executing" || result.status === "Running";
      const displayTime = isRunning && result.startedAt
        ? formatDuration(Date.now() - result.startedAt)
        : result.time;
      let subtests = `<span class="subtest-empty">-</span>`;
      if (testcase.tool === "bvt") {
        subtests = renderBvtSubtests(result.subtests);
      } else if (testcase.tool === "cts_verifier") {
        subtests = renderCtsSubtests(device.serial);
      }
      return `
        <tr class="${checked ? "checked" : ""}" data-tool="${testcase.tool}">
          <td><button class="row-check ${checked ? "checked" : ""}" data-tool="${testcase.tool}" title="Select testcase">${checked ? "✓" : ""}</button></td>
          <td>
            <span class="test-name">${escapeHtml(testcase.name)}</span>
            <small>${escapeHtml(testcase.description)}</small>
            <div class="progress-track ${statusClass(result.status)}"><div class="progress-fill" style="width:${progress}%"></div></div>
          </td>
          <td class="${statusClass(result.status)}">${formatStatus(result.status)}</td>
          <td>${subtests}</td>
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
          <thead><tr><th>Select</th><th>Testcase</th><th>Status</th><th>Sub Testcases</th><th>Time</th></tr></thead>
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
  els.testArea.querySelectorAll(".cts-test-check").forEach((input) => {
    input.addEventListener("change", () => {
      const testcase = input.dataset.testcase;
      if (input.checked) state.ctsVerifier.selected.add(testcase);
      else state.ctsVerifier.selected.delete(testcase);
      renderTests();
      updateRunButton();
    });
  });
}

function renderSummary() {
  state.summary.executed = Array.from(state.results.values()).filter((r) => terminalStatuses.includes(r.status)).length;
  state.summary.pass = Array.from(state.results.values()).filter((r) => r.status === "Pass").length;
  state.summary.fail = Array.from(state.results.values()).filter((r) => r.status === "Failed" || r.status === "Error").length;
  state.summary.pending = state.running ? Math.max(0, selectedRunKeys().length - state.summary.executed) : 0;
  if (state.runStartedAt) state.summary.runtime = formatDuration(Date.now() - state.runStartedAt);
  els.executedMetric.textContent = state.summary.executed;
  els.pendingMetric.textContent = state.summary.pending;
  els.passMetric.textContent = state.summary.pass;
  els.failMetric.textContent = state.summary.fail;
  els.runtimeMetric.textContent = state.summary.runtime;
}

function ctsNormalTests() {
  const available = new Set(ctsAvailable?.CtsVerModule || []);
  const normalizedActivities = Object.entries(ctsActivities || {}).map(([name, activity]) => ({
    name,
    key: name.replace(/\s+/g, "").toLowerCase(),
    activity,
  }));
  const preferred = ["DeviceOwnerTestsNormal", "BYODManagedProvisioningNormal"];
  return preferred
    .filter((testcase) => available.has(testcase))
    .map((testcase) => {
      let activity = "";
      if (testcase === "BYODManagedProvisioningNormal") {
        activity = ctsActivities["BYOD Provisioning tests"];
      } else if (testcase === "DeviceOwnerTestsNormal") {
        activity = ctsActivities["Device Owner Tests"];
      } else {
        activity = normalizedActivities.find((item) => item.key === testcase.toLowerCase())?.activity || "";
      }
      return activity ? { testcase, activity } : null;
    })
    .filter(Boolean);
}

function renderCtsSubtests(serial) {
  if (!state.ctsVerifier.tests.length) return `<span class="subtest-empty">No tests loaded</span>`;
  const list = state.ctsVerifier.tests.map((test) => {
    const checked = state.ctsVerifier.selected.has(test.testcase);
    const resultKey = `${serial}:${test.testcase}`;
    const result = state.ctsVerifier.results.get(resultKey) || { status: "-", time: "-" };
    return `
      <div class="subtest-row">
        <label style="display:flex; align-items:center; gap:4px; font-size:11px; cursor:pointer;" title="${escapeHtml(test.activity)}">
          <input type="checkbox" class="cts-test-check" data-testcase="${escapeHtml(test.testcase)}" ${checked ? "checked" : ""} ${state.running ? "disabled" : ""} />
          <span>${escapeHtml(test.testcase)}</span>
        </label>
        <strong class="${statusClass(ctsDisplayStatus(result.status))}">${formatStatus(result.status)}</strong>
      </div>
    `;
  }).join("");
  return `<div class="subtest-list"><div class="subtest-summary">${state.ctsVerifier.selected.size}/${state.ctsVerifier.tests.length} selected</div>${list}</div>`;
}

async function openCtsVerifierOnDevices() {
  const devices = selectedDevices();
  if (!devices.length) return;
  await Promise.all(devices.map(async (device) => {
    appendLog(`[cts-verifier] Opening app on ${device.serial}...`);
    try {
      await invoke("open_cts_verifier", { serial: device.serial });
      appendLog(`[cts-verifier] Opened on ${device.serial}`);
    } catch (error) {
      appendLog(`[cts-verifier] Open failed on ${device.serial}: ${error}`);
    }
  }));
}

async function installCtsVerifierOnDevices() {
  const devices = selectedDevices();
  if (!devices.length) return;
  setCtsActionsDisabled(true);
  try {
    await Promise.all(devices.map(async (device) => {
      appendLog(`[cts-verifier] Installing APK set on ${device.serial}...`);
      try {
        await invoke("install_cts_verifier", { serial: device.serial, atmRoot: state.atmRoot || null });
        appendLog(`[cts-verifier] Install complete on ${device.serial}`);
      } catch (error) {
        appendLog(`[cts-verifier] Install failed on ${device.serial}: ${error}`);
      }
    }));
  } finally {
    setCtsActionsDisabled(false);
  }
}

async function cleanupCtsVerifierOnDevices() {
  const devices = selectedDevices();
  if (!devices.length) return;
  await Promise.all(devices.map(async (device) => {
    appendLog(`[cts-verifier] Cleaning up APK set on ${device.serial}...`);
    try {
      await invoke("cleanup_cts_verifier", { serial: device.serial });
      appendLog(`[cts-verifier] Cleanup complete on ${device.serial}`);
    } catch (error) {
      appendLog(`[cts-verifier] Cleanup failed on ${device.serial}: ${error}`);
    }
  }));
}

async function startSelectedCtsVerifierTests() {
  const devices = selectedDevices();
  const tests = state.ctsVerifier.tests.filter((test) => state.ctsVerifier.selected.has(test.testcase));
  if (!devices.length || !tests.length) return;
  setCtsActionsDisabled(true);
  try {
    await Promise.all(devices.map(async (device) => {
      for (const test of tests) {
        appendLog(`[cts-verifier] Starting ${test.testcase} on ${device.serial}...`);
        try {
          await invoke("start_cts_verifier_activity", { serial: device.serial, activity: test.activity });
          appendLog(`[cts-verifier] Started ${test.testcase} on ${device.serial}`);
        } catch (error) {
          appendLog(`[cts-verifier] Start failed ${test.testcase} on ${device.serial}: ${error}`);
        }
      }
    }));
  } finally {
    setCtsActionsDisabled(false);
  }
}

async function runSelectedCtsVerifierTests() {
  const devices = selectedDevices();
  const tests = state.ctsVerifier.tests.filter((test) => state.ctsVerifier.selected.has(test.testcase));
  if (!devices.length || !tests.length) return;
  setCtsActionsDisabled(true);
  try {
    await Promise.all(devices.map(async (device) => {
      for (const test of tests) {
        if (!state.running) break;
        const key = `${device.serial}:${test.testcase}`;
        const startedAt = Date.now();
        state.ctsVerifier.results.set(key, { status: "Running", time: "00:00:00" });
        updateCtsVerifierToolResult(device.serial);
        renderTests();
        appendLog(`[cts-verifier] Running ${test.testcase} on ${device.serial}...`);
        try {
          const status = await invoke("run_cts_verifier_test", {
            serial: device.serial,
            testcase: test.testcase,
            atmRoot: state.atmRoot || null,
          });
          state.ctsVerifier.results.set(key, {
            status: normalizeCtsResult(status),
            time: formatDuration(Date.now() - startedAt),
          });
          appendLog(`[cts-verifier] ${test.testcase} on ${device.serial}: ${status}`);
        } catch (error) {
          state.ctsVerifier.results.set(key, {
            status: "Failed",
            time: formatDuration(Date.now() - startedAt),
          });
          appendLog(`[cts-verifier] Run failed ${test.testcase} on ${device.serial}: ${error}`);
        }
        updateCtsVerifierToolResult(device.serial);
        renderTests();
      }
    }));
  } finally {
    setCtsActionsDisabled(false);
  }
}

async function pullCtsVerifierReports() {
  const devices = selectedDevices();
  if (!devices.length) return;
  await Promise.all(devices.map(async (device) => {
    appendLog(`[cts-verifier] Pulling reports from ${device.serial}...`);
    try {
      const path = await invoke("pull_cts_verifier_results", { serial: device.serial, atmRoot: state.atmRoot || null });
      appendLog(`[cts-verifier] Reports saved: ${path}`);
    } catch (error) {
      appendLog(`[cts-verifier] Pull failed on ${device.serial}: ${error}`);
    }
  }));
}

function setCtsActionsDisabled(disabled) {
  // Not used anymore for modal buttons
}

function loadCtsNormalTests(writeLog = true) {
  state.ctsVerifier.tests = ctsNormalTests();
  state.ctsVerifier.selected = new Set(state.ctsVerifier.tests.map((test) => test.testcase));
  if (writeLog) appendLog(`[cts-verifier] Loaded ${state.ctsVerifier.tests.length} normal testcase(s).`);
  renderTests();
}

function normalizeCtsResult(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "pass" || normalized === "passed") return "Pass";
  if (normalized === "running" || normalized === "executing") return "Running";
  if (normalized === "done") return "Done";
  return "Failed";
}

function ctsDisplayStatus(status) {
  if (status === "Done") return "Pass";
  if (status === "-") return "Standby";
  return status;
}

function updateCtsVerifierToolResult(serial) {
  const selectedTests = state.ctsVerifier.tests.filter((test) => state.ctsVerifier.selected.has(test.testcase));
  const key = `${serial}:cts_verifier`;
  const previous = state.results.get(key) || { status: "Running", time: "00:00:00", startedAt: Date.now() };
  if (!selectedTests.length) {
    state.results.set(key, { ...previous, status: "Standby", time: "-" });
    return;
  }

  const statuses = selectedTests.map((test) => state.ctsVerifier.results.get(`${serial}:${test.testcase}`)?.status || "Standby");
  let status = "Standby";
  if (statuses.some((item) => item === "Running")) {
    status = "Running";
  } else if (statuses.some((item) => item === "Failed" || item === "Error")) {
    status = "Failed";
  } else if (statuses.every((item) => item === "Pass" || item === "Done")) {
    status = "Pass";
  }

  const elapsed = previous.startedAt ? formatDuration(Date.now() - previous.startedAt) : previous.time;
  state.results.set(key, {
    ...previous,
    status,
    time: status === "Standby" ? previous.time : elapsed,
  });
  renderSummary();
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
  loadCtsNormalTests(false);
  render();
}

async function runPreflight() {
  saveSettings(false);
  appendLog("[launcher] Running preflight...");
  els.settingsOutput.textContent = "Checking...";
  try {
    const lines = await invoke("preflight", { atmRoot: state.atmRoot || null });
    lines.forEach(appendLog);
    els.settingsOutput.textContent = lines.join("\n");
  } catch (error) {
    appendLog(`[launcher] Preflight failed: ${error}`);
    els.settingsOutput.textContent = `Preflight failed: ${error}`;
  }
}

function openSettings() {
  els.atmRootInput.value = state.atmRoot;
  els.wifiAutoConnectInput.checked = state.wifi.enabled;
  els.wifiSsidInput.value = state.wifi.ssid;
  els.wifiPasswordInput.value = state.wifi.password;
  els.settingsOutput.textContent = state.atmRoot ? `Current ATM path:\n${state.atmRoot}` : "ATM path is empty. Use Auto Detect or paste the ATM root path.";
  els.settingsModal.classList.remove("hidden");
  els.atmRootInput.focus();
}

function closeSettings() {
  els.settingsModal.classList.add("hidden");
}

function saveSettings(writeLog = true) {
  state.atmRoot = els.atmRootInput.value.trim();
  state.wifi.enabled = els.wifiAutoConnectInput.checked;
  state.wifi.ssid = els.wifiSsidInput.value.trim();
  state.wifi.password = els.wifiPasswordInput.value;
  if (state.atmRoot) localStorage.setItem("atmRoot", state.atmRoot);
  else localStorage.removeItem("atmRoot");
  if (state.wifi.enabled) localStorage.setItem("atmWifiAutoConnect", "true");
  else localStorage.removeItem("atmWifiAutoConnect");
  if (state.wifi.ssid) localStorage.setItem("atmWifiSsid", state.wifi.ssid);
  else localStorage.removeItem("atmWifiSsid");
  if (state.wifi.password) localStorage.setItem("atmWifiPassword", state.wifi.password);
  else localStorage.removeItem("atmWifiPassword");
  if (writeLog) appendLog(`[launcher] Settings saved. ATM path: ${state.atmRoot || "(auto)"}, Wi-Fi: ${state.wifi.enabled && state.wifi.ssid ? state.wifi.ssid : "off"}`);
}

async function autoDetectAtmRoot() {
  els.settingsOutput.textContent = "Detecting ATM root...";
  try {
    const path = await invoke("default_atm_root");
    els.atmRootInput.value = path;
    saveSettings(false);
    els.settingsOutput.textContent = `Detected ATM path:\n${path}`;
    appendLog(`[launcher] ATM path detected: ${path}`);
  } catch (error) {
    els.settingsOutput.textContent = `Auto detect failed: ${error}`;
    appendLog(`[launcher] Auto detect failed: ${error}`);
  }
}

async function updateTools() {
  saveSettings(false);
  els.settingsOutput.textContent = "Updating ATM tools resource...";
  appendLog("[launcher] Updating ATM tools resource...");
  try {
    const message = await invoke("update_tools", { atmRoot: state.atmRoot || null });
    els.settingsOutput.textContent = message;
    appendLog(`[launcher] ${message}`);
  } catch (error) {
    els.settingsOutput.textContent = `Update tools failed: ${error}`;
    appendLog(`[launcher] Update tools failed: ${error}`);
  }
}

async function toggleLamp(serial) {
  if (!serial) return;
  const brighten = !state.lampStates.get(serial);
  appendLog(`[launcher] Toggling lamp for ${serial}: ${brighten ? "max" : "min"} brightness`);
  try {
    await invoke("set_device_lamp", { serial, brighten });
    state.lampStates.set(serial, brighten);
    renderDevices();
  } catch (error) {
    appendLog(`[launcher] Failed to toggle lamp for ${serial}: ${error}`);
  }
}

async function openScrcpyWrap(serial) {
  if (!serial) return;
  appendLog(`[scrcpy] Opening wrap for ${serial}...`);
  try {
    await invoke("open_scrcpy_wrap", { serial });
    appendLog(`[scrcpy] Wrap updated for ${serial}`);
  } catch (error) {
    appendLog(`[scrcpy] Failed to open ${serial}: ${error}`);
  }
}

async function runBatch() {
  if (state.running) return;

  const devices = selectedDevices().map((d) => d.serial);
  const tools = selectedTestcases().map((testcase) => testcase.tool);
  if (!devices.length || !tools.length) return;

  state.running = true;
  els.runBtn.disabled = true;

  stopDollarConfetti();

  if (state.wifi.enabled && state.wifi.ssid) {
    appendLog(`[launcher] Auto connecting Wi-Fi "${state.wifi.ssid}" on selected devices...`);
    for (const serial of devices) {
      try {
        const output = await invoke("connect_wifi", {
          serial,
          ssid: state.wifi.ssid,
          password: state.wifi.password || null,
        });
        appendLog(`[${serial}] WIFI ${output}`);
      } catch (err) {
        appendLog(`[${serial}] WIFI warning: ${err}`);
      }
    }
  } else if (state.wifi.enabled) {
    appendLog("[launcher] Wi-Fi auto connect is enabled but SSID is empty; skipping.");
  }

  try {
    const archived = await invoke("clear_results", { atmRoot: state.atmRoot || null, serials: devices, tools });
    if (archived?.length) {
      archived.forEach((item) => appendLog(`[launcher] Archived previous results: ${item}`));
    } else {
      appendLog("[launcher] No previous result folders found; starting with fresh result folders.");
    }
  } catch (err) {
    appendLog(`[launcher] Warning: Failed to prepare result folders: ${err}`);
  }

  const javaTools = tools.filter(t => t !== "cts_verifier");
  const runCts = tools.includes("cts_verifier");

  state.runStartedAt = Date.now();
  state.results.clear();
  state.pendingJavaAfterCts = null;

  devices.forEach((serial) => {
    tools.forEach((tool, index) => {
      if (index === 0) {
        state.results.set(`${serial}:${tool}`, { status: "Running", time: "00:00:00", startedAt: Date.now() });
      } else {
        state.results.set(`${serial}:${tool}`, { status: "Standby", time: "-" });
      }
    });
  });
  els.cancelBtn.disabled = false;
  els.statusLine.textContent = "Running";
  appendLog(`[launcher] Starting batch: devices=${devices.join(", ")} tools=${tools.join(", ")}`);
  render();
  try {
    if (runCts && javaTools.length > 0) {
      state.pendingJavaAfterCts = javaTools;
      appendLog("[cts-verifier] Starting CTS Verifier sequence (Java tools queued after)...");
      runCtsVerifierSequence();
    } else if (runCts) {
      appendLog("[cts-verifier] Starting CTS Verifier sequence...");
      runCtsVerifierSequence();
    } else if (javaTools.length > 0) {
      await invoke("run_batch", {
        request: {
          devices,
          tools: javaTools,
          concurrency: parseInt(els.concurrencyInput?.value || "1", 10),
          update: false,
          atm_root: state.atmRoot || null,
        },
      });
    }
  } catch (error) {
    appendLog(`[launcher] Run failed: ${error}`);
    finishBatch(1);
  }
  render();
}

async function runCtsVerifierSequence() {
  try {
    await installCtsVerifierOnDevices();
    await runSelectedCtsVerifierTests();
  } catch (e) {
    appendLog(`[cts-verifier] Error: ${e}`);
  } finally {
    await pullCtsVerifierReports();
    await cleanupCtsVerifierOnDevices();

    if (state.pendingJavaAfterCts && state.running) {
      const javaTools = state.pendingJavaAfterCts;
      state.pendingJavaAfterCts = null;
      appendLog("[launcher] CTS Verifier sequence finished; starting Java tools...");
      try {
        await invoke("run_batch", {
          request: {
            devices: selectedDevices().map((d) => d.serial),
            tools: javaTools,
            concurrency: parseInt(els.concurrencyInput?.value || "1", 10),
            update: false,
            atm_root: state.atmRoot || null,
          },
        });
      } catch (err) {
        appendLog(`[launcher] Failed to start Java tools: ${err}`);
        finishBatch(1);
      }
    } else {
      finishBatch(0);
    }
  }
}

async function cancelBatch() {
  appendLog("[launcher] Cancel requested.");
  els.cancelBtn.disabled = true;
  els.statusLine.textContent = "Cancelling";
  try {
    await invoke("cancel_batch");
  } catch (error) {
    appendLog(`[launcher] Cancel failed: ${error}`);
    els.cancelBtn.disabled = false;
    els.statusLine.textContent = state.running ? "Running" : "Standby";
  }
}

function normalizeDialogPath(selected) {
  if (!selected) return "";
  if (typeof selected === "string") return selected;
  if (Array.isArray(selected)) return normalizeDialogPath(selected[0]);
  return selected.path || selected.file || selected.toString?.() || "";
}

async function openDeviceResults(serial) {
  if (!serial) return;
  appendLog(`[launcher] Opening results for ${serial}...`);
  try {
    const path = await invoke("open_device_results", { serial, atmRoot: state.atmRoot || null });
    appendLog(`[launcher] Opened: ${path}`);
  } catch (error) {
    appendLog(`[launcher] Open results failed: ${error}`);
  }
}

function selectedDevices() {
  return state.devices.filter((device) => state.selected.has(device.serial));
}

function deviceStateLabel(state) {
  return state === "device" ? "tersambung" : state;
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
      return status === "Failed" || status === "Error";
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
  if (status === "Running") return 18;
  if (status === "Executing") return 55;
  if (terminalStatuses.includes(status) || status === "Cancelled") return 100;
  return 0;
}

function renderBvtSubtests(subtests = []) {
  const failed = subtests.filter((item) => item.status === "Failed" || item.status === "Timeout");
  const summary = renderBvtSummary(subtests.summary);
  if (!failed.length) return `${summary}<span class="subtest-empty">No failed BVT subtest</span>`;
  const shown = failed.slice(0, 12).map((item) => `
    <div class="subtest-row">
      <span title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
      <strong class="${statusClass(item.status)}">${formatStatus(item.status)}</strong>
    </div>
  `).join("");
  const more = failed.length > 12 ? `<div class="subtest-more">+${failed.length - 12} more failed</div>` : "";
  return `<div class="subtest-list">${summary}${shown}${more}</div>`;
}

function renderBvtSummary(summary) {
  if (!summary) return `<div class="subtest-summary">Total: - · Passed: - · Failed: -</div>`;
  return `
    <div class="subtest-summary">
      Total: ${escapeHtml(summary.total)} · Passed: ${escapeHtml(summary.pass)} · Failed: ${escapeHtml(summary.failed)}
    </div>
  `;
}

function markRunningAs(status) {
  state.results.forEach((result, key) => {
    if (result.status === "Running" || result.status === "Executing") {
      state.results.set(key, { status, time: result.startedAt ? formatDuration(Date.now() - result.startedAt) : result.time });
    }
  });
}

function appendLog(line) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  state.logLines.push(`[${timestamp}] ${line}`);
  if (state.logLines.length > 1200) state.logLines.shift();
  renderLog();
}

function collectResultFromLine(line) {
  const start = line.match(/\[([^\]]+)] START ([^:]+):/);
  if (start) {
    const serial = start[1];
    const tool = start[2].toLowerCase();
    state.results.set(`${serial}:${tool}`, { status: "Executing", time: "00:00:00", startedAt: Date.now(), subtests: [] });
    renderSummary();
    render();
    return;
  }
  const subtest = line.match(/^\[([^\]]+)] BVT_SUBTEST\t([^\t]+)\t(.+)$/);
  if (subtest) {
    const serial = subtest[1];
    const key = `${serial}:bvt`;
    const previous = state.results.get(key) || { status: "Executing", time: "00:00:00", subtests: [] };
    const currentSubtests = previous.subtests || [];
    const nextSubtests = [...currentSubtests, {
      status: normalizeSubtestStatus(subtest[2]),
      name: subtest[3],
    }];
    nextSubtests.summary = currentSubtests.summary;
    state.results.set(key, { ...previous, subtests: nextSubtests });
    renderTests();
    return;
  }
  const bvtSummary = line.match(/^\[([^\]]+)] BVT_SUMMARY\t(\d+)\t(\d+)\t(\d+)$/);
  if (bvtSummary) {
    const serial = bvtSummary[1];
    const key = `${serial}:bvt`;
    const previous = state.results.get(key) || { status: "Executing", time: "00:00:00", subtests: [] };
    const nextSubtests = [...(previous.subtests || [])];
    nextSubtests.summary = {
      total: Number(bvtSummary[2]),
      pass: Number(bvtSummary[3]),
      failed: Number(bvtSummary[4]),
    };
    state.results.set(key, { ...previous, subtests: nextSubtests });
    renderTests();
    return;
  }
  const match = line.match(/\[([^\]]+)] END ([^ ]+) .* result=([A-Z]+)/);
  if (!match) return;
  const serial = match[1];
  const tool = match[2].toLowerCase();
  const rawStatus = match[3];
  const status = normalizeEndStatus(tool, rawStatus, line);
  const previous = state.results.get(`${serial}:${tool}`);
  const elapsed = previous?.startedAt ? Date.now() - previous.startedAt : Date.now() - state.runStartedAt;
  const subtests = previous?.subtests || [];
  if (tool === "bvt" && !subtests.summary) {
    subtests.summary = parseBvtSummaryFromEndLine(line);
  }
  state.results.set(`${serial}:${tool}`, { status, time: formatDuration(elapsed), subtests });
  markNextToolRunning(serial, tool);
  renderSummary();
  render();
}

function selectedRunKeys() {
  return selectedDevices().flatMap((device) => selectedTestcases().map((testcase) => `${device.serial}:${testcase.tool}`));
}

function markNextToolRunning(serial, completedTool) {
  const tools = selectedTestcases().map((testcase) => testcase.tool);
  const index = tools.indexOf(completedTool);
  const nextTool = index >= 0 ? tools[index + 1] : null;
  if (!nextTool) return;
  const key = `${serial}:${nextTool}`;
  const current = state.results.get(key);
  if (!current || current.status === "Standby") {
    state.results.set(key, { status: "Running", time: "00:00:00", startedAt: Date.now() });
  }
}

function normalizeToolStatus(status) {
  if (status === "PASS") return "Pass";
  if (status === "WARNING") return "Warning";
  if (status === "FAIL") return "Failed";
  return "Error";
}

function normalizeEndStatus(tool, rawStatus, line) {
  if (tool === "sdt" && rawStatus === "NOTEXECUTED" && line.includes("exit=0")) return "Pass";
  if (tool === "bvt" && rawStatus === "FAIL") {
    const failed = Number(line.match(/\bfailed=(\d+)/)?.[1] || NaN);
    if (Number.isFinite(failed) && failed <= 2) return "Warning";
  }
  return normalizeToolStatus(rawStatus);
}

function normalizeSubtestStatus(status) {
  if (status === "PASS") return "Pass";
  if (status === "FAIL") return "Failed";
  if (status === "TIMEOUT") return "Timeout";
  return "Not Executed";
}

function parseBvtSummaryFromEndLine(line) {
  const pass = Number(line.match(/\bpass=(\d+)/)?.[1] || 0);
  const failed = Number(line.match(/\bfailed=(\d+)/)?.[1] || 0);
  return { total: pass + failed, pass, failed };
}

function statusClass(status) {
  return `status-${String(status || "Standby").toLowerCase().replaceAll(" ", "-")}`;
}

function deviceProgress(serial) {
  const selected = selectedTestcases();
  if (!selected.length) return { percent: 0, status: "Standby", label: "Standby" };
  const statuses = selected.map((testcase) => state.results.get(`${serial}:${testcase.tool}`)?.status || "Standby");
  const done = statuses.filter((status) => terminalStatuses.includes(status) || status === "Cancelled").length;
  const activeIndex = statuses.findIndex((status) => status === "Executing");
  const runningIndex = statuses.findIndex((status) => status === "Running");
  const partial = activeIndex >= 0 ? 0.55 : runningIndex >= 0 ? 0.18 : 0;
  const percent = Math.min(100, Math.round(((done + partial) / selected.length) * 100));
  const status = statuses.find((item) => item === "Error" || item === "Failed")
    || statuses.find((item) => item === "Warning")
    || statuses.find((item) => item === "Executing")
    || statuses.find((item) => item === "Running")
    || (done === selected.length ? "Pass" : "Standby");
  const label = status === "Pass" && done !== selected.length ? "Standby" : status;
  return { percent, status: label, label: deviceProgressLabel(label) };
}

function deviceProgressLabel(status) {
  return status === "Error" ? "Testnya udah selesai dengan beberapa catatan" : status;
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
}
