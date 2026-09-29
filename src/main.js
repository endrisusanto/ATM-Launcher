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
  runningDevices: new Set(),
  deviceTools: new Map(),
  tools: ["getprop", "bvt", "svt", "sdt"],
  concurrency: 1,
  get running() {
    return this.runningDevices.size > 0;
  },
  loadedDevices: false,
  atmRoot: localStorage.getItem("atmRoot") || "",
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

function getToolsForDevice(serial) {
  if (!state.deviceTools.has(serial)) {
    state.deviceTools.set(serial, new Set(state.tools));
  }
  return state.deviceTools.get(serial);
}

function selectedTestcasesForDevice(serial) {
  const deviceToolSet = getToolsForDevice(serial);
  return testcases.filter((testcase) => deviceToolSet.has(testcase.tool));
}

function toggleToolForDevice(serial, tool) {
  if (state.runningDevices.has(serial)) return; // Locked while running!
  const toolSet = getToolsForDevice(serial);
  if (toolSet.has(tool)) {
    toolSet.delete(tool);
  } else {
    toolSet.add(tool);
  }
}

function formatStatus(status) {
  return status === "Error" ? "Error (Periksa Log)" : escapeHtml(status);
}

const testcases = [
  { tool: "cts_verifier", name: "CTS Verifier", description: "Android Compatibility Test Suite Verifier Auto" },
  { tool: "getprop", name: "GetpropSnapshot", description: "Pengumpulan Informasi Build Property Perangkat" },
  { tool: "bvt", name: "BasicInfoTests (BVT)", description: "Pengujian Informasi Dasar & Kompatibilitas BVT" },
  { tool: "svt", name: "SVTPreloadValidation", description: "Validasi Preload Aplikasi & Komponen SVT" },
  { tool: "sdt", name: "SDTDeviceTest", description: "Eksekusi Paket Pengujian Tersembunyi SDT" },
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

async function openNativeScrcpy(serial) {
  if (!serial) return;
  appendLog(`[scrcpy] Opening native scrcpy for ${serial}...`);
  try {
    await invoke("open_native_scrcpy", { serial });
    appendLog(`[scrcpy] Native scrcpy launched for ${serial}`);
  } catch (error) {
    appendLog(`[scrcpy] Failed to launch native scrcpy for ${serial}: ${error}`);
  }
}
app.innerHTML = `
  <div class="shell" id="shell">
    <div class="splash" id="splash">
      <img src="${atmLogo}" alt="ATM" />
    </div>
    <header class="titlebar">
      <div class="brand" id="brandGroup" role="button" tabindex="0" title="Konfigurasi Sistem & Preflight Check (Klik untuk Pengaturan)">
        <img class="brand-mark" src="${atmLogo}" alt="ATM" />
        <div>
          <h1>ATM BERSAMA HUB</h1>
          <p>Automated Device Test Orchestration Engine</p>
        </div>
      </div>
    </header>

    <aside class="devices-pane">
      <div class="pane-head">
        <h2>FLEET DEVICES</h2>
        <div class="pane-actions">
          <button class="mini-button" id="unselectBtn">Unselect All</button>
          <button class="mini-button" id="refreshBtn">Refresh Devices</button>
        </div>
      </div>
      <div class="device-list" id="deviceList"></div>
      <footer>© 2026 ATM Automation Engine</footer>
    </aside>

    <main class="workspace">
      <div class="toolbar">
        <button class="run-button" id="runBtn">Jalankan Pengujian (0)</button>
        <button class="ghost-button" id="cancelBtn" disabled>Batal</button>
        <div class="toolbar-spacer"></div>
        <label class="retry">Concurrent: <input id="concurrencyInput" type="number" min="1" max="16" value="1" /></label>
        <label class="check"><input id="allTools" type="checkbox" checked /> Semua Test</label>
        <label class="check"><input id="onlyFailed" type="checkbox" /> Gagal Saja</label>
      </div>

      <section class="test-area" id="testArea"></section>
    </main>

    <div class="panel-resizer" id="panelResizer" title="Geser untuk mengubah ukuran panel"></div>

    <aside class="summary-pane" id="summaryPane">
      <section class="summary">
        <h2>EXECUTION METRICS</h2>
        <div class="metric-row"><span>Total Dieksekusi:</span><strong id="executedMetric">0</strong></div>
        <div class="metric-row"><span>Dalam Proses / Antrean:</span><strong id="pendingMetric">0</strong></div>
        <div class="metric-row"><span>Lulus (Pass):</span><strong class="pass" id="passMetric">0</strong></div>
        <div class="metric-row"><span>Gagal (Fail):</span><strong class="fail" id="failMetric">0</strong></div>
        <div class="metric-row"><span>Total Waktu Eksekusi:</span><strong id="runtimeMetric">00:00:00</strong></div>
      </section>
      <section class="running-log">
        <div class="log-head">
          <h2>RUNNING LOGS</h2>
          <button id="clearLogBtn">[ Bersihkan Log ]</button>
        </div>
        <pre id="logBox"></pre>
      </section>
      <footer class="status-line" id="statusLine">Standby</footer>
    </aside>

    <div class="modal-backdrop hidden" id="settingsModal">
      <section class="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settingsTitle">
        <header>
          <div>
            <h2 id="settingsTitle">SYSTEM CONFIGURATION & PREFLIGHT</h2>
            <p>Konfigurasi jalur ATM Root dan pemeriksaan kesiapan lingkungan eksekusi</p>
          </div>
          <button class="icon-button" id="settingsCloseBtn" title="Tutup">×</button>
        </header>
        <label class="path-field">
          <span>Jalur ATM Root</span>
          <div class="path-row">
            <input id="atmRootInput" type="text" placeholder="/path/to/ATM root" />
            <button id="browseBtn" class="ghost-button">Pilih Folder</button>
          </div>
        </label>
        <div class="settings-actions">
          <button class="ghost-button" id="autoDetectBtn">Deteksi Otomatis</button>
          <button class="ghost-button" id="updateToolsBtn">Pembaruan Tools</button>
          <button class="ghost-button" id="settingsCheckBtn">Jalankan Preflight</button>
          <button class="run-button" id="settingsSaveBtn">Simpan Konfigurasi</button>
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
  brandGroup: document.querySelector("#brandGroup"),
  settingsModal: document.querySelector("#settingsModal"),
  settingsCloseBtn: document.querySelector("#settingsCloseBtn"),
  autoDetectBtn: document.querySelector("#autoDetectBtn"),
  updateToolsBtn: document.querySelector("#updateToolsBtn"),
  settingsCheckBtn: document.querySelector("#settingsCheckBtn"),
  settingsSaveBtn: document.querySelector("#settingsSaveBtn"),
  atmRootInput: document.querySelector("#atmRootInput"),
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
  initPanelResizer();
  render();
});

function initPanelResizer() {
  const shell = document.querySelector("#shell");
  const resizer = document.querySelector("#panelResizer");
  const summaryPane = document.querySelector("#summaryPane");
  if (!shell || !resizer || !summaryPane) return;

  let savedWidth = parseInt(localStorage.getItem("summaryPaneWidth"), 10);
  if (!savedWidth || isNaN(savedWidth) || savedWidth < 450 || savedWidth > 850) {
    savedWidth = 500;
    localStorage.setItem("summaryPaneWidth", "500");
  }
  shell.style.setProperty("--summary-pane-width", `${savedWidth}px`);

  let isDragging = false;
  let startX = 0;
  let startWidth = 0;

  resizer.addEventListener("mousedown", (e) => {
    isDragging = true;
    startX = e.clientX;
    startWidth = summaryPane.getBoundingClientRect().width;
    resizer.classList.add("resizing");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });

  window.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const deltaX = startX - e.clientX;
    const newWidth = Math.max(450, Math.min(850, startWidth + deltaX));
    shell.style.setProperty("--summary-pane-width", `${newWidth}px`);
  });

  window.addEventListener("mouseup", () => {
    if (!isDragging) return;
    isDragging = false;
    resizer.classList.remove("resizing");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    const currentWidth = Math.max(450, Math.round(summaryPane.getBoundingClientRect().width));
    localStorage.setItem("summaryPaneWidth", currentWidth);
  });
}

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
  const shouldCheck = els.allTools.checked;
  idleSelectedDevices().forEach((device) => {
    const toolSet = getToolsForDevice(device.serial);
    toolSet.clear();
    if (shouldCheck) {
      testcases.forEach((tc) => toolSet.add(tc.tool));
    }
  });
  state.tools = shouldCheck ? allToolIds() : [];
  els.onlyFailed.checked = false;
  renderTests();
  updateRunButton();
});
els.onlyFailed.addEventListener("change", () => {
  const shouldCheckFailed = els.onlyFailed.checked;
  if (shouldCheckFailed) {
    idleSelectedDevices().forEach((device) => {
      const failedTools = testcases.filter((tc) => {
        const st = state.results.get(`${device.serial}:${tc.tool}`)?.status;
        return st === "Failed" || st === "Error";
      }).map((tc) => tc.tool);

      const toolSet = getToolsForDevice(device.serial);
      toolSet.clear();
      if (failedTools.length) {
        failedTools.forEach((t) => toolSet.add(t));
      } else {
        failedToolIds().forEach((t) => toolSet.add(t));
      }
    });
  } else {
    // Unchecking "Failed" deselects failed-only filter and restores all tools for idle selected devices!
    idleSelectedDevices().forEach((device) => {
      const toolSet = getToolsForDevice(device.serial);
      toolSet.clear();
      testcases.forEach((tc) => toolSet.add(tc.tool));
    });
    state.tools = allToolIds();
  }
  renderTests();
  updateRunButton();
});
els.concurrencyInput.addEventListener("input", () => {
  state.concurrency = Math.max(1, Number(els.concurrencyInput.value || 1));
});
els.brandGroup.addEventListener("click", openSettings);
els.brandGroup.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    openSettings();
  }
});
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

function idleSelectedDevices() {
  return selectedDevices().filter((d) => !state.runningDevices.has(d.serial));
}

function finishBatch(exitCode, finishedSerials = []) {
  const serialsToFinish = finishedSerials.length > 0 ? finishedSerials : Array.from(state.runningDevices);
  serialsToFinish.forEach((serial) => state.runningDevices.delete(serial));

  serialsToFinish.forEach((serial) => {
    state.results.forEach((result, key) => {
      if (key.startsWith(`${serial}:`) && (result.status === "Running" || result.status === "Executing")) {
        const status = exitCode === 130 ? "Cancelled" : "Standby";
        const time = exitCode === 130 ? (result.startedAt ? formatDuration(Date.now() - result.startedAt) : result.time) : "-";
        state.results.set(key, { ...result, status, time });
      }
    });
  });

  if (state.runningDevices.size === 0) {
    els.cancelBtn.disabled = true;
    if (exitCode === 130) {
      els.statusLine.textContent = "Cancelled";
    } else {
      els.statusLine.textContent = exitCode === 0 ? "Completed" : "Completed with warnings";
    }
    if (exitCode !== 130) startDollarConfetti();
  }

  renderSummary();
  renderTests();
  updateRunButton();
}

listen("atm-run-finished", (event) => {
  const exitCode = Number(event.payload?.exit_code || 0);
  const finishedDevices = event.payload?.devices || Array.from(state.runningDevices);
  finishBatch(exitCode, finishedDevices);
});

function render() {
  renderDevices();
  renderTests();
  renderSummary();
  renderLog();
  updateRunButton();
}

function updateRunButton() {
  const selectedCount = state.selected.size;
  const idleSelected = idleSelectedDevices();
  const runningCount = state.runningDevices.size;

  if (els.concurrencyInput && runningCount === 0) {
    els.concurrencyInput.value = selectedCount > 0 ? selectedCount : 1;
    state.concurrency = Math.max(1, selectedCount);
  }

  const idleCount = idleSelected.length;
  const hasTestcases = idleSelected.some((device) => selectedTestcasesForDevice(device.serial).length > 0);

  if (runningCount > 0 && idleCount > 0) {
    els.runBtn.textContent = `Jalankan Pengujian (+${idleCount} Baru)`;
  } else {
    els.runBtn.textContent = `Jalankan Pengujian (${selectedCount})`;
  }
  els.runBtn.disabled = idleCount === 0 || !hasTestcases;
  els.cancelBtn.disabled = runningCount === 0;

  const allChecked = idleSelected.length > 0 && idleSelected.every((device) => selectedTestcasesForDevice(device.serial).length === testcases.length);
  els.allTools.checked = allChecked;
  updateSelectToggle();
}

function updateSelectToggle() {
  const readyCount = state.devices.filter((device) => device.state === "device").length;
  els.unselectBtn.textContent = state.selected.size === readyCount && readyCount > 0 ? "Unselect All" : "Select All";
  els.unselectBtn.disabled = readyCount === 0;
}

function renderDevices() {
  if (!state.devices.length) {
    els.deviceList.innerHTML = `<div class="empty">Tidak ada perangkat terdeteksi</div>`;
    return;
  }

  const groups = new Map();
  [...state.devices]
    .sort((a, b) => {
      const stateRank = (device) => device.state === "device" ? 0 : 1;
      const model = (device) => String(device.model || "Unknown").trim().toLocaleLowerCase();
      return stateRank(a) - stateRank(b)
        || model(a).localeCompare(model(b))
        || String(a.serial || "").localeCompare(String(b.serial || ""));
    })
    .forEach((device) => {
      const model = String(device.model || "Unknown").trim() || "Unknown";
      const key = model.toLocaleLowerCase();
      if (!groups.has(key)) groups.set(key, { model, devices: [] });
      groups.get(key).devices.push(device);
    });

	els.deviceList.innerHTML = [...groups.values()].map(({ model, devices }, groupIndex) => `
    <section class="model-group model-group-${groupIndex % 5}">
      <header class="model-group-header" data-model="${escapeHtml(model)}" role="button" tabindex="0" aria-label="Select ${escapeHtml(model)} devices">
        <strong>${escapeHtml(model)}</strong>
        <span>${devices.length} Perangkat</span>
      </header>
	      ${devices.map((device) => {
	  const selected = state.selected.has(device.serial);
	  const ready = device.state === "device";
	  const badge = ready ? String(device.build_type || "USER").toUpperCase() : String(device.state || "OFFLINE").toUpperCase();
	  const connection = ready ? "connected" : "disconnected";
	  const lampActive = state.lampStates.get(device.serial);
	  const progress = deviceProgress(device.serial);
    const flow = selected ? `
      <div class="device-flow ${statusClass(progress.status)}">
        <div class="device-flow-fill" style="width:${progress.percent}%"></div>
        <div class="device-flow-content">
          <span>${escapeHtml(progress.label)}</span>
          <strong>${progress.percent}%</strong>
        </div>
      </div>
    ` : "";
    return `
      <article class="device-card ${selected ? "selected" : ""} ${ready ? "" : "disabled"}" data-serial="${escapeHtml(device.serial)}" role="button" tabindex="${ready ? "0" : "-1"}">
        <div class="device-top">
          <span class="check-dot ${selected ? "checked" : ""}"></span>
          <div>
            <strong>${escapeHtml(device.model || "Unknown")}</strong>
	            <p><b>${escapeHtml(device.serial)}</b> <span class="connection-status ${connection}" aria-label="${ready ? "Tersambung" : escapeHtml(deviceStateLabel(device.state))}" title="${ready ? "Tersambung" : escapeHtml(deviceStateLabel(device.state))}"></span></p>
	          </div>
	          <div class="device-inline-actions">
	            <span class="type-pill ${ready ? "" : "busy"}">${badge}</span>
	            <button class="icon-mini lamp-button ${lampActive ? "active" : ""}" data-lamp="${escapeHtml(device.serial)}" ${ready ? "" : "disabled"} title="Toggle Senter Perangkat">💡</button>
	            <button class="icon-mini scrcpy-button" data-scrcpy="${escapeHtml(device.serial)}" ${ready ? "" : "disabled"} title="Buka Screen Mirroring (Scrcpy)">📱</button>
	          </div>
        </div>
        <div class="device-meta">
	      <span><small>ANDROID</small>${escapeHtml(device.android || "-")}</span>
          <span><small>SPL</small>${escapeHtml(device.security_patch || "-")}</span>
	      <span><small>CARRIER</small>${escapeHtml(device.carrier || device.csc || "-")}</span>
          <span><small>PDA</small>${escapeHtml(device.build || "-")}</span>
          <span><small>MODEM</small>${escapeHtml(device.modem || "-")}</span>
          <span><small>CSC</small>${escapeHtml(device.csc || "-")}</span>
        </div>
        ${flow}
      </article>
    `;
      }).join("")}
    </section>
  `).join("");
  els.deviceList.querySelectorAll(".model-group-header").forEach((header) => {
    const toggleModel = () => {
      const model = header.dataset.model.toLocaleLowerCase();
      const devices = state.devices.filter((device) =>
        device.state === "device" && String(device.model || "Unknown").trim().toLocaleLowerCase() === model,
      );
      if (!devices.length) return;
      const allSelected = devices.every((device) => state.selected.has(device.serial));
      devices.forEach((device) => {
        if (allSelected) state.selected.delete(device.serial);
        else state.selected.add(device.serial);
      });
      render();
    };
    header.addEventListener("click", toggleModel);
    header.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggleModel();
    });
  });
  els.deviceList.querySelectorAll(".device-card").forEach((card) => {
    card.addEventListener("click", () => {
      if (card.classList.contains("disabled")) return;
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
  els.deviceList.querySelectorAll("[data-lamp]").forEach((button) => {
    button.addEventListener("click", async (e) => {
      e.stopPropagation();
      await toggleLamp(button.dataset.lamp);
    });
  });
  els.deviceList.querySelectorAll("[data-scrcpy]").forEach((button) => {
    button.addEventListener("click", async (e) => {
      e.stopPropagation();
      await openNativeScrcpy(button.dataset.scrcpy);
    });
  });
}

function renderTests() {
  const subtestScrolls = new Map(
    [...els.testArea.querySelectorAll(".subtest-scroll")].map((element) => [element.dataset.scrollKey, element.scrollLeft]),
  );
  const devices = selectedDevices();
  if (!devices.length) {
    els.testArea.innerHTML = `<div class="empty large">PILIH PERANGKAT UNTUK MENAMPILKAN WORKSPACE PENGUJIAN</div>`;
    return;
  }
  els.testArea.innerHTML = devices.map((device) => {
    const isDeviceRunning = state.runningDevices.has(device.serial);
    const deviceSelectedTools = selectedTestcasesForDevice(device.serial);
    const deviceToolSet = getToolsForDevice(device.serial);
    const hasAnyChecked = deviceSelectedTools.length > 0;
    const rows = testcases.map((testcase) => {
      const key = `${device.serial}:${testcase.tool}`;
      const result = state.results.get(key) || { status: "Standby", time: "-" };
      const checked = deviceToolSet.has(testcase.tool);
      const progress = progressForStatus(result.status);
      const isRunning = result.status === "Executing" || result.status === "Running";
      const displayTime = isRunning && result.startedAt
        ? formatDuration(Date.now() - result.startedAt)
        : result.time;
      let subtests = `<span class="subtest-empty">-</span>`;
      if (testcase.tool === "bvt") {
        subtests = renderBvtSubtests(result.subtests, key);
      } else if (testcase.tool === "cts_verifier") {
        subtests = renderCtsSubtests(device.serial);
      }
      return `
        <tr class="${checked ? "checked" : ""}" data-tool="${testcase.tool}">
          <td>
            <button class="row-check ${checked ? "checked" : ""}" data-serial="${escapeHtml(device.serial)}" data-tool="${testcase.tool}" title="${isDeviceRunning ? "Sedang Berjalan (Terkunci)" : "Pilih testcase"}" ${isDeviceRunning ? "disabled" : ""}></button>
          </td>
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
      <article class="test-card ${isDeviceRunning ? "running" : ""}">
        <header>
          <div>
            <h3>${escapeHtml(device.model || "Unknown")} ${isDeviceRunning ? `<small style="color:var(--cyan); font-weight:normal;">[Running]</small>` : ""}</h3>
            <p>${escapeHtml(device.serial)} · Android ${escapeHtml(device.android || "-")}</p>
          </div>
          <span>${deviceSelectedTools.length}/${testcases.length} tercentang</span>
        </header>
        <table>
          <thead>
            <tr>
              <th>
                <div class="th-select">
                  <button class="head-check-btn ${hasAnyChecked ? "checked" : ""}" data-serial="${escapeHtml(device.serial)}" title="${isDeviceRunning ? "Sedang Berjalan (Terkunci)" : hasAnyChecked ? "Hapus semua centang testcase perangkat ini" : "Pilih semua testcase perangkat ini"}" ${isDeviceRunning ? "disabled" : ""}></button>
                  <span>${hasAnyChecked ? "Uncheck" : "Select"}</span>
                </div>
              </th>
              <th>Testcase</th>
              <th>Status Pengujian</th>
              <th>Sub-Testcase / Detail</th>
              <th>Durasi</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </article>
    `;
  }).join("");
  els.testArea.querySelectorAll(".subtest-scroll").forEach((element) => {
    element.scrollLeft = subtestScrolls.get(element.dataset.scrollKey) || 0;
  });
  els.testArea.querySelectorAll(".head-check-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const serial = button.dataset.serial;
      if (state.runningDevices.has(serial)) return;
      const toolSet = getToolsForDevice(serial);
      if (toolSet.size > 0) {
        toolSet.clear();
      } else {
        testcases.forEach((tc) => toolSet.add(tc.tool));
      }
      els.onlyFailed.checked = false;
      renderTests();
      updateRunButton();
    });
  });
  els.testArea.querySelectorAll(".row-check").forEach((button) => {
    button.addEventListener("click", () => {
      const serial = button.dataset.serial;
      const tool = button.dataset.tool;
      toggleToolForDevice(serial, tool);
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

let ctsDynamicConfig = { available: null, activities: null };

async function fetchCtsDynamicConfig() {
  try {
    const config = await invoke("get_cts_verifier_config", { atmRoot: state.atmRoot || null });
    if (config?.available) ctsDynamicConfig.available = config.available;
    if (config?.activities) ctsDynamicConfig.activities = config.activities;
  } catch (err) {
    console.warn("Failed to fetch dynamic CTS config, falling back to bundled asset JSON:", err);
  }
}

function ctsNormalTests() {
  const activeAvailable = ctsDynamicConfig.available || ctsAvailable?.CtsVerModule || [];
  const activeActivities = ctsDynamicConfig.activities || ctsActivities || {};

  const available = new Set(activeAvailable);
  const normalizedActivities = Object.entries(activeActivities).map(([name, activity]) => ({
    name,
    key: name.replace(/\s+/g, "").toLowerCase(),
    activity,
  }));

  const preferred = ["DeviceOwnerTestsNormal", "BYODManagedProvisioningNormal"];
  const matchedPreferred = preferred.filter((testcase) => available.has(testcase));
  const testList = matchedPreferred.length ? matchedPreferred : Array.from(available);

  return testList
    .map((testcase) => {
      let activity = "";
      if (testcase === "BYODManagedProvisioningNormal") {
        activity = activeActivities["BYOD Provisioning tests"] || activeActivities[testcase];
      } else if (testcase === "DeviceOwnerTestsNormal") {
        activity = activeActivities["Device Owner Tests"] || activeActivities[testcase];
      } else {
        activity = activeActivities[testcase] || normalizedActivities.find((item) => item.key === testcase.toLowerCase())?.activity || "";
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

async function loadCtsNormalTests(writeLog = true) {
  await fetchCtsDynamicConfig();
  state.ctsVerifier.tests = ctsNormalTests();
  state.ctsVerifier.selected = new Set(state.ctsVerifier.tests.map((test) => test.testcase));
  if (writeLog) appendLog(`[cts-verifier] Loaded ${state.ctsVerifier.tests.length} testcase(s).`);
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
  const lines = state.logLines.slice(-600);
  els.logBox.innerHTML = lines.map((line) => {
    const escaped = escapeHtml(line);
    const lower = line.toLowerCase();
    let colorClass = "log-line-default";
    if (lower.includes("fail") || lower.includes("error") || lower.includes("cancel")) {
      colorClass = "log-line-fail";
    } else if (lower.includes("pass") || lower.includes("complete") || lower.includes("success")) {
      colorClass = "log-line-pass";
    } else if (lower.includes("save") || lower.includes("install")) {
      colorClass = "log-line-info";
    }
    return `<div class="${colorClass}">${escaped}</div>`;
  }).join("");
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
        .filter((d) => d.state === "device" && previousSelection.has(d.serial))
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
  els.settingsOutput.textContent = state.atmRoot ? `Current ATM path:\n${state.atmRoot}` : "ATM path is empty. Use Auto Detect or paste the ATM root path.";
  els.settingsModal.classList.remove("hidden");
  els.atmRootInput.focus();
}

function closeSettings() {
  els.settingsModal.classList.add("hidden");
}

function saveSettings(writeLog = true) {
  state.atmRoot = els.atmRootInput.value.trim();
  if (state.atmRoot) localStorage.setItem("atmRoot", state.atmRoot);
  else localStorage.removeItem("atmRoot");
  if (writeLog) appendLog(`[launcher] Settings saved. ATM path: ${state.atmRoot || "(auto)"}`);
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
  const idleDevices = idleSelectedDevices();
  if (!idleDevices.length) return;

  const deviceToolGroups = new Map();
  idleDevices.forEach((device) => {
    const tools = selectedTestcasesForDevice(device.serial).map((tc) => tc.tool);
    if (!tools.length) return;
    const groupKey = tools.join(",");
    if (!deviceToolGroups.has(groupKey)) {
      deviceToolGroups.set(groupKey, { tools, serials: [] });
    }
    deviceToolGroups.get(groupKey).serials.push(device.serial);
  });

  if (!deviceToolGroups.size) return;

  stopDollarConfetti();

  if (!state.runStartedAt) {
    state.runStartedAt = Date.now();
  }

  for (const { tools, serials } of deviceToolGroups.values()) {
    serials.forEach((serial) => state.runningDevices.add(serial));
    updateRunButton();

    try {
      const archived = await invoke("clear_results", { atmRoot: state.atmRoot || null, serials, tools });
      if (archived?.length) {
        archived.forEach((item) => appendLog(`[launcher] Archived previous results: ${item}`));
      }
    } catch (err) {
      appendLog(`[launcher] Warning: Failed to prepare result folders: ${err}`);
    }

    const javaTools = tools.filter((t) => t !== "cts_verifier");
    const runCts = tools.includes("cts_verifier");

    serials.forEach((serial) => {
      testcases.forEach((tc) => {
        state.results.set(`${serial}:${tc.tool}`, { status: "Standby", time: "-" });
      });
      tools.forEach((tool, index) => {
        if (index === 0) {
          state.results.set(`${serial}:${tool}`, { status: "Running", time: "00:00:00", startedAt: Date.now() });
        }
      });
    });

    els.cancelBtn.disabled = false;
    els.statusLine.textContent = "Running";
    appendLog(`[launcher] Starting batch: devices=${serials.join(", ")} tools=${tools.join(", ")}`);
    render();

    try {
      if (runCts && javaTools.length > 0) {
        state.pendingJavaAfterCts = { devices: serials, javaTools };
        appendLog(`[cts-verifier] Starting CTS Verifier sequence for ${serials.join(", ")}...`);
        runCtsVerifierSequence();
      } else if (runCts) {
        appendLog(`[cts-verifier] Starting CTS Verifier sequence for ${serials.join(", ")}...`);
        runCtsVerifierSequence();
      } else if (javaTools.length > 0) {
        await invoke("run_batch", {
          request: {
            devices: serials,
            tools: javaTools,
            concurrency: parseInt(els.concurrencyInput?.value || "1", 10),
            update: false,
            atm_root: state.atmRoot || null,
          },
        });
      }
    } catch (error) {
      appendLog(`[launcher] Run failed for ${serials.join(", ")}: ${error}`);
      finishBatch(1, serials);
    }
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

function renderBvtSubtests(subtests = [], scrollKey = "bvt") {
  const failed = subtests.filter((item) => item.status === "Failed" || item.status === "Timeout");
  const summary = renderBvtSummary(subtests.summary);
  if (!failed.length) return `${summary}<span class="subtest-empty">No failed BVT subtest</span>`;
  const shown = failed.slice(0, 12).map((item, index) => `
    <div class="subtest-row">
      <div class="subtest-scroll" data-scroll-key="${escapeHtml(`${scrollKey}:${index}`)}">
        <div class="subtest-copy">
          <span title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
          <small title="${escapeHtml(item.detail || "Failure details unavailable")}">${escapeHtml(item.detail || "Failure details unavailable")}</small>
        </div>
      </div>
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
  const subtest = line.match(/^\[([^\]]+)] BVT_SUBTEST\t([^\t]+)\t([^\t]+)(?:\t(.*))?$/);
  if (subtest) {
    const serial = subtest[1];
    const key = `${serial}:bvt`;
    const previous = state.results.get(key) || { status: "Executing", time: "00:00:00", subtests: [] };
    const currentSubtests = previous.subtests || [];
    const nextSubtests = [...currentSubtests, {
      status: normalizeSubtestStatus(subtest[2]),
      name: subtest[3],
      detail: subtest[4] || "",
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
  renderSummary();
  render();
}

function selectedRunKeys() {
  return selectedDevices().flatMap((device) => selectedTestcasesForDevice(device.serial).map((testcase) => `${device.serial}:${testcase.tool}`));
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
  const selected = selectedTestcasesForDevice(serial);
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
  return status === "Error" ? "Completed with warnings" : status;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}



setInterval(() => {
  if (state.running) {
    renderSummary();
    renderTests();
  }
}, 1000);

refreshDevices();
