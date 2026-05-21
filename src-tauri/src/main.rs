#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Debug, Clone, Serialize)]
struct DeviceInfo {
    serial: String,
    state: String,
    model: String,
    android: String,
    build: String,
    csc: String,
    security_patch: String,
    carrier: String,
    region: String,
    modem: String,
}

#[derive(Debug, Clone, Deserialize)]
struct RunRequest {
    devices: Vec<String>,
    tools: Vec<String>,
    concurrency: Option<u8>,
    update: Option<bool>,
    atm_root: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct RunFinished {
    exit_code: i32,
}

#[derive(Default)]
struct RunState {
    active: Mutex<Option<ActiveBatch>>,
}

#[derive(Debug, Clone)]
struct ActiveBatch {
    pid: Option<u32>,
    cancel_file: PathBuf,
}

#[tauri::command]
fn default_atm_root() -> Result<String, String> {
    Ok(atm_root()?.display().to_string())
}

#[tauri::command]
fn preflight(atm_root: Option<String>) -> Result<Vec<String>, String> {
    let root = resolve_atm_root(atm_root)?;
    let mut lines = vec![
        format!("Root: {}", root.display()),
        check_file("ATM_v5.jar", root.join("ATM_v5.jar")),
        check_file("AtmAgent.jar", root.join("AtmAgent.jar")),
        check_file("AtmInfo.xml", root.join("AtmInfo.xml")),
        check_dir("tools", root.join("tools")),
        check_dir("results", root.join("results")),
    ];
    for tool in [
        "Getprop.jar",
        "BVT.jar",
        "SVT.jar",
        "SDT.jar",
        "FMDUT.jar",
        "CSCChecker.jar",
        "AtmOctopus.jar",
    ] {
        lines.push(check_file(tool, root.join("tools").join(tool)));
    }
    Ok(lines)
}

#[tauri::command]
fn list_devices() -> Result<Vec<DeviceInfo>, String> {
    let adb = adb_path();
    let output = run_output(Command::new(&adb).args(["devices", "-l"]))?;
    let mut devices = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("List of devices") || trimmed.starts_with('*')
        {
            continue;
        }
        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.len() < 2 {
            continue;
        }
        let serial = parts[0].to_string();
        let state = parts[1].to_string();
        let props = if state == "device" {
            adb_props(&adb, &serial).unwrap_or_default()
        } else {
            HashMap::new()
        };
        devices.push(DeviceInfo {
            serial: serial.clone(),
            state,
            model: first_non_empty(&[
                token_value(trimmed, "model"),
                props.get("ro.product.model").cloned().unwrap_or_default(),
                props
                    .get("ro.product.vendor.model")
                    .cloned()
                    .unwrap_or_default(),
            ]),
            android: first_non_empty(&[
                props
                    .get("ro.build.version.release")
                    .cloned()
                    .unwrap_or_default(),
                props
                    .get("ro.system.build.version.release")
                    .cloned()
                    .unwrap_or_default(),
            ]),
            build: first_non_empty(&[
                props
                    .get("ro.build.version.incremental")
                    .cloned()
                    .unwrap_or_default(),
                props
                    .get("ro.vendor.build.version.incremental")
                    .cloned()
                    .unwrap_or_default(),
            ]),
            csc: first_non_empty(&[
                props
                    .get("ril.official_cscver")
                    .cloned()
                    .unwrap_or_default(),
                props.get("ro.csc.sales_code").cloned().unwrap_or_default(),
            ]),
            security_patch: props
                .get("ro.build.version.security_patch")
                .cloned()
                .unwrap_or_default(),
            carrier: props.get("ro.csc.sales_code").cloned().unwrap_or_default(),
            region: props
                .get("ro.product.locale.region")
                .cloned()
                .unwrap_or_else(|| "INDONESIA".to_string()),
            modem: first_non_empty(&[
                props
                    .get("gsm.version.baseband")
                    .cloned()
                    .unwrap_or_default(),
                props.get("ril.modem.board").cloned().unwrap_or_default(),
            ]),
        });
    }
    Ok(devices)
}

#[tauri::command]
fn run_batch(
    app: AppHandle,
    run_state: State<'_, RunState>,
    request: RunRequest,
) -> Result<(), String> {
    let root = resolve_atm_root(request.atm_root.clone())?;
    if request.devices.is_empty() {
        return Err("No devices selected".to_string());
    }
    if request.tools.is_empty() {
        return Err("No tools selected".to_string());
    }
    {
        let active = run_state.active.lock().map_err(|err| err.to_string())?;
        if active.is_some() {
            return Err("Batch is already running".to_string());
        }
    }

    let cancel_file = root
        .join("atm-batch-launcher")
        .join("runs")
        .join(format!(".cancel-{}", unique_millis()));
    if let Some(parent) = cancel_file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::remove_file(&cancel_file);
    {
        let mut active = run_state.active.lock().map_err(|err| err.to_string())?;
        *active = Some(ActiveBatch {
            pid: None,
            cancel_file: cancel_file.clone(),
        });
    }

    thread::spawn(move || {
        let java_file = root
            .join("atm-batch-launcher")
            .join("AtmBatchLauncher.java");
        match sync_bundled_batch_launcher(&app, &root) {
            Ok(Some(message)) => {
                let _ = app.emit("atm-run-log", message);
            }
            Ok(None) => {}
            Err(err) => {
                let _ = app.emit("atm-run-log", format!("[launcher] Resource sync warning: {err}"));
            }
        }
        match ensure_batch_launcher_compat(&root) {
            Ok(Some(message)) => {
                let _ = app.emit("atm-run-log", message);
            }
            Ok(None) => {}
            Err(err) => {
                let _ = app.emit("atm-run-log", format!("[launcher] Patch warning: {err}"));
            }
        }
        let devices = request.devices.join(",");
        let tools = request.tools.join(",");
        let concurrency = request.concurrency.unwrap_or(1).max(1).to_string();
        let mut args = vec![
            java_file.to_string_lossy().to_string(),
            "--run".to_string(),
            "--tools".to_string(),
            tools,
            "--devices".to_string(),
            devices,
            "--concurrency".to_string(),
            concurrency,
            "--cancel-file".to_string(),
            cancel_file.to_string_lossy().to_string(),
        ];
        if request.update.unwrap_or(false) {
            args.push("--update".to_string());
        }

        let java = java_bin();
        let _ = app.emit(
            "atm-run-log",
            format!("[launcher] Spawning: {java} {}", args.join(" ")),
        );
        let mut command = Command::new(java);
        command
            .current_dir(&root)
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        command.creation_flags(0x08000000);
        #[cfg(unix)]
        unsafe {
            command.pre_exec(|| {
                libc_setpgid();
                Ok(())
            });
        }

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(err) => {
                let _ = app.emit(
                    "atm-run-log",
                    format!("[launcher] Failed to start batch: {err}"),
                );
                let state = app.state::<RunState>();
                if let Ok(mut active) = state.active.lock() {
                    if active
                        .as_ref()
                        .is_some_and(|batch| batch.cancel_file == cancel_file)
                    {
                        *active = None;
                    }
                }
                let _ = app.emit("atm-run-finished", RunFinished { exit_code: 1 });
                return;
            }
        };
        let child_id = child.id();
        let _ = app.emit(
            "atm-run-log",
            format!("[launcher] Batch process started pid={child_id}"),
        );
        let state = app.state::<RunState>();
        if let Ok(mut active) = state.active.lock() {
            if let Some(batch) = active
                .as_mut()
                .filter(|batch| batch.cancel_file == cancel_file)
            {
                batch.pid = Some(child_id);
            }
        }

        if let Some(stdout) = child.stdout.take() {
            let app_stdout = app.clone();
            thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    let _ = app_stdout.emit("atm-run-log", line);
                }
            });
        }
        if let Some(stderr) = child.stderr.take() {
            let app_stderr = app.clone();
            thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    let _ = app_stderr.emit("atm-run-log", line);
                }
            });
        }

        let exit_code = child.wait().ok().and_then(|s| s.code()).unwrap_or(1);
        let mut should_emit_finished = true;
        let _ = std::fs::remove_file(&cancel_file);
        if let Ok(mut active) = state.active.lock() {
            match active.as_ref() {
                Some(batch) if batch.cancel_file == cancel_file => *active = None,
                _ => should_emit_finished = false,
            }
        }
        if should_emit_finished {
            let _ = app.emit("atm-run-finished", RunFinished { exit_code });
        }
    });

    Ok(())
}

fn sync_bundled_batch_launcher(app: &AppHandle, root: &Path) -> Result<Option<String>, String> {
    let source_dir = bundled_batch_launcher_dir(app)
        .ok_or_else(|| "Bundled atm-batch-launcher resource was not found".to_string())?;
    let target_dir = root.join("atm-batch-launcher");
    std::fs::create_dir_all(&target_dir)
        .map_err(|err| format!("Cannot create {}: {err}", target_dir.display()))?;

    let mut copied = 0;
    for file_name in [
        "AtmBatchLauncher.java",
        "README.md",
        "run-launcher.bat",
        "run-launcher.sh",
    ] {
        let source = source_dir.join(file_name);
        if !source.is_file() {
            continue;
        }
        let target = target_dir.join(file_name);
        std::fs::copy(&source, &target).map_err(|err| {
            format!(
                "Cannot copy {} to {}: {err}",
                source.display(),
                target.display()
            )
        })?;
        copied += 1;

        #[cfg(unix)]
        if file_name.ends_with(".sh") {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(&target)
                .map_err(|err| format!("Cannot read permissions for {}: {err}", target.display()))?
                .permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&target, permissions)
                .map_err(|err| format!("Cannot set permissions for {}: {err}", target.display()))?;
        }
    }

    if copied == 0 {
        return Err(format!("No launcher files found in {}", source_dir.display()));
    }

    Ok(Some(format!(
        "[launcher] Synced bundled atm-batch-launcher to {}",
        target_dir.display()
    )))
}

fn bundled_batch_launcher_dir(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("atm-batch-launcher"));
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("atm-batch-launcher"));
    candidates.into_iter().find(|path| path.join("AtmBatchLauncher.java").is_file())
}

fn ensure_batch_launcher_compat(root: &Path) -> Result<Option<String>, String> {
    let java_file = root
        .join("atm-batch-launcher")
        .join("AtmBatchLauncher.java");
    let original = std::fs::read_to_string(&java_file)
        .map_err(|err| format!("Cannot read {}: {err}", java_file.display()))?;
    let mut updated = original.clone();

    let bvt_new = r#"case BVT -> Arrays.asList(JAVA_BIN, "-jar", jar, device.serial);"#;
    for bvt_old in [
        r#"case BVT -> Arrays.asList(JAVA_BIN, "-jar", jar, "--ui", "false", "--devices", device.serial);"#,
        r#"case BVT -> Arrays.asList(JAVA_BIN, "-jar", jar, "-s", device.serial);"#,
        r#"Arrays.asList(JAVA_BIN, "-jar", jar, "--ui", "false", "--devices", device.serial)"#,
        r#"Arrays.asList(JAVA_BIN, "-jar", jar, "-s", device.serial)"#,
    ] {
        let replacement = if bvt_old.starts_with("case BVT") {
            bvt_new
        } else {
            r#"Arrays.asList(JAVA_BIN, "-jar", jar, device.serial)"#
        };
        updated = updated.replace(bvt_old, replacement);
    }

    let sdt_ui_old = r#"                if (tool == ToolProfile.SDT) {
                    ResultSummary deviceResult = inspectDeviceSdtResult(adb(), device);
                    if ("NOTEXECUTED".equals(deviceResult.status) && exitCode == 0) {
                        return new ResultSummary("PASS", "exit=0 (result saved by SDT)");
                    }
                    return deviceResult;
                }"#;
    let sdt_ui_new = r#"                if (tool == ToolProfile.SDT) {
                    if (exitCode == 0) {
                        return new ResultSummary("PASS", "exit=0 (SDT saved result externally)");
                    }
                    ResultSummary deviceResult = inspectDeviceSdtResult(adb(), device);
                    return deviceResult;
                }"#;
    updated = updated.replace(sdt_ui_old, sdt_ui_new);

    let sdt_cli_old = r#"                if (tool == ToolProfile.SDT) {
                    ResultSummary deviceResult = inspectDeviceSdtResult(cliAdbPath, device);
                    if ("NOTEXECUTED".equals(deviceResult.status) && exitCode == 0) {
                        return new ResultSummary("PASS", "exit=0 (result saved by SDT)");
                    }
                    return deviceResult;
                }"#;
    let sdt_cli_new = r#"                if (tool == ToolProfile.SDT) {
                    if (exitCode == 0) {
                        return new ResultSummary("PASS", "exit=0 (SDT saved result externally)");
                    }
                    ResultSummary deviceResult = inspectDeviceSdtResult(cliAdbPath, device);
                    return deviceResult;
                }"#;
    updated = updated.replace(sdt_cli_old, sdt_cli_new);

    if updated == original {
        return Ok(None);
    }

    std::fs::write(&java_file, updated)
        .map_err(|err| format!("Cannot update {}: {err}", java_file.display()))?;
    Ok(Some(format!(
        "[launcher] Patched batch launcher compatibility: {}",
        java_file.display()
    )))
}

#[tauri::command]
fn cancel_batch(app: AppHandle, run_state: State<'_, RunState>) -> Result<(), String> {
    let active = {
        let active = run_state.active.lock().map_err(|err| err.to_string())?;
        active.clone()
    };
    let Some(active) = active else {
        let _ = app.emit(
            "atm-run-log",
            "[launcher] No active batch process to cancel.",
        );
        return Ok(());
    };
    let pid = active.pid;

    let message = match pid {
        Some(pid) => format!("[launcher] Cancelling batch pid={pid}; waiting for cleanup..."),
        None => "[launcher] Cancelling pending batch; waiting for cleanup...".to_string(),
    };
    let _ = app.emit("atm-run-log", message);
    std::fs::write(&active.cancel_file, b"cancel").map_err(|err| err.to_string())?;
    let app_watchdog = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(8));
        let Some(pid) = pid else {
            return;
        };
        let state = app_watchdog.state::<RunState>();
        let still_active = state
            .active
            .lock()
            .ok()
            .and_then(|active| active.as_ref().map(|batch| batch.pid == Some(pid)))
            .unwrap_or(false);
        if still_active {
            let _ = app_watchdog.emit(
                "atm-run-log",
                format!("[launcher] Cancel cleanup timeout; force-killing pid={pid}..."),
            );
            terminate_process_tree(pid);
        }
    });
    Ok(())
}

#[tauri::command]
fn open_device_results(serial: String, atm_root: Option<String>) -> Result<String, String> {
    let root = resolve_atm_root(atm_root)?;
    let results = root.join("results");
    if !results.exists() {
        return Err(format!("Results folder not found: {}", results.display()));
    }
    let target = find_device_results_dir(&results, &serial).unwrap_or(results);
    open_path(&target)?;
    Ok(target.display().to_string())
}

#[tauri::command]
fn open_cts_verifier(serial: String) -> Result<(), String> {
    let adb = adb_path();
    let mut start = Command::new(&adb);
    start.args([
        "-s",
        &serial,
        "shell",
        "am",
        "start",
        "-n",
        "com.android.cts.verifier/.CtsVerifierActivity",
    ]);
    match run_output(&mut start) {
        Ok(_) => Ok(()),
        Err(_) => {
            let mut monkey = Command::new(&adb);
            monkey.args(["-s", &serial, "shell", "monkey", "-p", "com.android.cts.verifier", "1"]);
            run_output(&mut monkey).map(|_| ())
        }
    }
}

#[tauri::command]
fn pull_cts_verifier_results(serial: String, atm_root: Option<String>) -> Result<String, String> {
    let root = resolve_atm_root(atm_root)?;
    let target = cts_verifier_result_dir(&root, &serial);
    std::fs::create_dir_all(&target)
        .map_err(|err| format!("Cannot create {}: {err}", target.display()))?;

    let adb = adb_path();
    let mut sync = Command::new(&adb);
    sync.args(["-s", &serial, "shell", "sync"]);
    let _ = run_output(&mut sync);

    let remote_paths = [
        "/sdcard/verifierReports/.",
        "/sdcard/VerifierReports/.",
        "/storage/emulated/0/verifierReports/.",
        "/storage/emulated/0/VerifierReports/.",
        "/sdcard/Android/data/com.android.cts.verifier/files/VerifierReports/.",
        "/sdcard/Android/data/com.android.cts.verifier/files/verifierReports/.",
        "/storage/emulated/0/Android/data/com.android.cts.verifier/files/VerifierReports/.",
        "/storage/emulated/0/Android/data/com.android.cts.verifier/files/verifierReports/.",
    ];

    let mut last_error = String::new();
    for remote in remote_paths {
        let mut pull = Command::new(&adb);
        pull.args(["-s", &serial, "pull", remote, &target.to_string_lossy()]);
        match run_output(&mut pull) {
            Ok(output) => {
                if output.to_lowercase().contains("pulled") || target_has_files(&target) {
                    return Ok(target.display().to_string());
                }
            }
            Err(error) => last_error = error,
        }
    }

    if target_has_files(&target) {
        return Ok(target.display().to_string());
    }
    Err(format!(
        "No CTS Verifier reports found for {serial}. Export results in CTS Verifier first. {}",
        last_error.trim()
    ))
}

#[tauri::command]
fn install_cts_verifier(app: AppHandle, serial: String, atm_root: Option<String>) -> Result<(), String> {
    cts_log(&app, &serial, "Resolving CTS Verifier APK resources...");
    let resource_root = resolve_cts_resource_root(&app, atm_root.as_deref().map(Path::new))?;
    let (apk_dir, version_label) = resolve_cts_apk_dir(&app, &serial, &resource_root)?;
    cts_log(
        &app,
        &serial,
        &format!("Using CTS Verifier resources: {version_label} ({})", apk_dir.display()),
    );

    cts_log(&app, &serial, "Installing CTS Verifier core APKs...");
    install_apk(&serial, &apk_dir.join("CtsVerifier.apk"), &["-g", "-t"])?;
    install_apk(&serial, &apk_dir.join("CtsEmptyDeviceOwner.apk"), &["-t"])?;
    install_optional_apk(&serial, &apk_dir.join("CtsPermissionApp.apk"));

    let automation_root = resource_root.join("ApkTest");
    cts_log(&app, &serial, "Installing AutoCtsVerifier automation APKs...");
    install_apk(&serial, &automation_root.join("AutoCtsVerifier-debug.apk"), &["-t", "-g"])?;
    install_apk(&serial, &automation_root.join("AutoCtsVerifier-debug-androidTest.apk"), &["-t", "-g"])?;

    cts_log(&app, &serial, "Installing companion APKs when available...");
    for apk in [
        "CtsEmptyDeviceAdmin.apk",
        "CtsDeviceControlsApp.apk",
        "CtsDefaultNotesApp.apk",
        "CtsCarWatchdogCompanionApp.apk",
        "CrossProfileTestApp.apk",
        "CtsForceStopHelper.apk",
        "CtsTileServiceApp.apk",
        "NotificationBot.apk",
        "CtsVerifierInstantApp.apk",
        "CtsVerifierUSBCompanion.apk",
        "CtsTtsEngineSelectorTestHelper.apk",
        "CtsTtsEngineSelectorTestHelper2.apk",
        "CtsVpnFirewallAppApi23.apk",
        "CtsVpnFirewallAppApi24.apk",
        "CtsVpnFirewallAppNotAlwaysOn.apk",
        "jetpack-camera-app.apk",
        "CameraFeatureCombinationVerifier.apk",
    ] {
        install_optional_apk(&serial, &apk_dir.join(apk));
    }

    cts_log(&app, &serial, "Applying CTS Verifier permissions/settings...");
    grant_cts_permissions(&serial);
    let _ = adb_device_output(&serial, &["shell", "dpm", "set-device-owner", "--user", "0", "com.android.cts.emptydeviceowner/.EmptyDeviceAdmin"]);
    let _ = adb_device_output(&serial, &["shell", "appops", "set", "com.android.cts.verifier", "android:read_device_identifiers", "allow"]);
    let _ = adb_device_output(&serial, &["shell", "appops", "set", "com.android.cts.verifier", "MANAGE_EXTERNAL_STORAGE", "allow"]);
    let _ = adb_device_output(&serial, &["shell", "settings", "put", "global", "verifier_verify_adb_installs", "0"]);
    let _ = adb_device_output(&serial, &["shell", "settings", "put", "global", "device_name", &serial]);

    cts_log(&app, &serial, "CTS Verifier install sequence complete.");
    Ok(())
}

#[tauri::command]
fn start_cts_verifier_activity(serial: String, activity: String) -> Result<(), String> {
    adb_device_output(&serial, &["shell", "am", "start", "-n", &activity]).map(|_| ())
}

#[tauri::command]
fn run_cts_verifier_test(
    app: AppHandle,
    serial: String,
    testcase: String,
    atm_root: Option<String>,
) -> Result<String, String> {
    let atm_path = atm_root.as_deref().map(Path::new);
    ensure_cts_verifier_runtime(&app, &serial, atm_path)?;
    run_cts_pre_test_setup(&serial);

    let automation_class = automation_test_class(&testcase);
    cts_log(&app, &serial, &format!("Running {testcase} via {automation_class}"));

    let adb = adb_path();
    let mut command = Command::new(&adb);
    command.args([
        "-s",
        &serial,
        "shell",
        "am",
        "instrument",
        "-w",
        "-r",
        "-e",
        "debug",
        "false",
        "-e",
        "class",
        &automation_class,
        "com.example.autoctsver.test/androidx.test.runner.AndroidJUnitRunner",
    ]);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x08000000);

    let mut child = command
        .spawn()
        .map_err(|err| format!("Failed to start CTS Verifier instrumentation: {err}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Cannot read instrumentation stdout".to_string())?;
    let mut final_status = "Done".to_string();

    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        cts_log(&app, &serial, trimmed);
        if let Some(result) = trimmed.strip_prefix("INSTRUMENTATION_STATUS: result=") {
            final_status = result.trim().to_string();
            cts_log(&app, &serial, &format!("{testcase} result: {final_status}"));
        } else if let Some(running) = trimmed.strip_prefix("INSTRUMENTATION_STATUS: testcase=") {
            cts_log(&app, &serial, &format!("Current testcase: {}", running.trim()));
        } else if let Some(command_text) = trimmed.strip_prefix("INSTRUMENTATION_STATUS: cmd=") {
            run_cts_status_command(&app, &serial, command_text.trim(), &automation_class);
        } else if let Some(apk_name) = trimmed.strip_prefix("INSTRUMENTATION_STATUS: InstallApk=") {
            install_requested_cts_apk(&app, &serial, atm_path, apk_name.trim())?;
        } else if let Some(apk_name) = trimmed.strip_prefix("INSTRUMENTATION_STATUS: PushAPK=") {
            push_requested_cts_apk(&app, &serial, atm_path, apk_name.trim())?;
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|err| format!("Failed waiting for instrumentation: {err}"))?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    for line in stderr.lines().filter(|line| !line.trim().is_empty()) {
        cts_log(&app, &serial, &format!("stderr: {}", line.trim()));
    }
    if !output.status.success() {
        return Err(format!("Instrumentation exited with {}", output.status));
    }
    Ok(final_status)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(RunState::default())
        .invoke_handler(tauri::generate_handler![
            default_atm_root,
            preflight,
            list_devices,
            run_batch,
            cancel_batch,
            open_device_results,
            open_cts_verifier,
            pull_cts_verifier_results,
            install_cts_verifier,
            start_cts_verifier_activity,
            run_cts_verifier_test
        ])
        .run(tauri::generate_context!())
        .expect("error while running ATM Batch Launcher");
}

#[cfg(unix)]
fn libc_setpgid() {
    unsafe extern "C" {
        fn setpgid(pid: i32, pgid: i32) -> i32;
    }
    unsafe {
        setpgid(0, 0);
    }
}

#[cfg(unix)]
fn terminate_process_tree(pid: u32) {
    let group = format!("-{pid}");
    let _ = Command::new("kill").args(["-TERM", &group]).status();
    thread::sleep(Duration::from_millis(800));
    let _ = Command::new("kill").args(["-KILL", &group]).status();
}

fn unique_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

#[cfg(windows)]
fn terminate_process_tree(pid: u32) {
    let mut command = Command::new("taskkill");
    command.args(["/PID", &pid.to_string(), "/T", "/F"]);
    command.creation_flags(0x08000000);
    let _ = command.status();
}

fn find_device_results_dir(results: &Path, serial: &str) -> Option<PathBuf> {
    let direct = results.join(serial);
    if direct.is_dir() {
        return Some(direct);
    }
    if let Some(atm_root) = results.parent() {
        let cts = cts_verifier_result_dir(atm_root, serial);
        if cts.is_dir() {
            return Some(cts);
        }
    }
    let needle = serial.to_lowercase();
    let mut stack = vec![results.to_path_buf()];
    let mut matches = Vec::new();
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let path_text = path.to_string_lossy().to_lowercase();
            if path_text.contains(&needle) {
                matches.push(path.clone());
            }
            stack.push(path);
        }
    }
    matches
        .into_iter()
        .max_by_key(|path| path.metadata().and_then(|meta| meta.modified()).ok())
}

fn open_path(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer");
        command.arg(path);
        command
    };

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(path);
        command
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(path);
        command
    };

    command
        .spawn()
        .map_err(|err| format!("Failed to open {}: {err}", path.display()))?;
    Ok(())
}

fn resolve_atm_root(value: Option<String>) -> Result<PathBuf, String> {
    let Some(value) = value else {
        return atm_root();
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return atm_root();
    }
    let path = PathBuf::from(trimmed);
    if path.join("ATM_v5.jar").exists() {
        return Ok(path);
    }
    Err(format!(
        "Invalid ATM root: {}. ATM_v5.jar was not found.",
        path.display()
    ))
}

fn atm_root() -> Result<PathBuf, String> {
    let cwd = env::current_dir().map_err(|err| err.to_string())?;
    if cwd.join("ATM_v5.jar").exists() {
        return Ok(cwd);
    }
    if let Some(parent) = cwd.parent() {
        if parent.join("ATM_v5.jar").exists() {
            return Ok(parent.to_path_buf());
        }
    }
    if let Some(grand_parent) = cwd.parent().and_then(Path::parent) {
        if grand_parent.join("ATM_v5.jar").exists() {
            return Ok(grand_parent.to_path_buf());
        }
    }
    Err("Cannot locate ATM_v5.jar. Run from ATM root or atm-tauri-launcher.".to_string())
}

fn adb_path() -> String {
    if let Ok(value) = env::var("ADB") {
        if !value.trim().is_empty() {
            return value;
        }
    }
    if let Ok(home) = env::var("HOME") {
        let candidate = PathBuf::from(home).join("Android/Sdk/platform-tools/adb");
        if candidate.exists() {
            return candidate.to_string_lossy().to_string();
        }
    }
    "adb".to_string()
}

fn java_bin() -> String {
    if let Ok(java_home) = env::var("JAVA_HOME") {
        let candidate = PathBuf::from(java_home).join("bin").join(if cfg!(windows) {
            "java.exe"
        } else {
            "java"
        });
        if candidate.exists() {
            return candidate.to_string_lossy().to_string();
        }
    }
    "java".to_string()
}

fn adb_props(adb: &str, serial: &str) -> Result<HashMap<String, String>, String> {
    let output = run_output(Command::new(adb).args(["-s", serial, "shell", "getprop"]))?;
    let mut props = HashMap::new();
    for line in output.lines() {
        if let Some((key, value)) = parse_getprop_line(line) {
            props.insert(key, value);
        }
    }
    Ok(props)
}

fn adb_device_output(serial: &str, args: &[&str]) -> Result<String, String> {
    let adb = adb_path();
    let mut command = Command::new(&adb);
    command.arg("-s").arg(serial).args(args);
    run_output(&mut command)
}

fn run_output(command: &mut Command) -> Result<String, String> {
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = command.output().map_err(|err| err.to_string())?;
    let mut text = String::new();
    text.push_str(&String::from_utf8_lossy(&output.stdout));
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    if !output.status.success() {
        return Err(text);
    }
    Ok(text)
}

fn cts_log(app: &AppHandle, serial: &str, message: &str) {
    let _ = app.emit("atm-run-log", format!("[cts-verifier][{serial}] {message}"));
}

fn candidate_cts_resource_roots(app: &AppHandle, atm_root: Option<&Path>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(path) = env::var("CTS_VERIFIER_RESOURCE_DIR") {
        if !path.trim().is_empty() {
            roots.push(PathBuf::from(path));
        }
    }
    if let Some(root) = atm_root {
        roots.push(root.join("resources"));
        roots.push(root.join("apks"));
    }
    if let Ok(exe_path) = env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            roots.push(exe_dir.join("resources"));
            roots.push(exe_dir.join("apks"));
        }
    }
    if let Ok(cwd) = env::current_dir() {
        roots.push(cwd.join("resources"));
        roots.push(cwd.join("apks"));
        roots.push(cwd.join("src-tauri").join("apks"));
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        roots.push(resource_dir.join("resources"));
        roots.push(resource_dir.join("apks"));
    }
    roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("apks"));
    roots
}

fn resolve_cts_resource_root(app: &AppHandle, atm_root: Option<&Path>) -> Result<PathBuf, String> {
    candidate_cts_resource_roots(app, atm_root)
        .into_iter()
        .find(|root| root.join("Normal").is_dir() && root.join("ApkTest").is_dir())
        .ok_or_else(|| {
            "CTS Verifier APK resource folder not found. Set CTS_VERIFIER_RESOURCE_DIR or place Normal/ and ApkTest/ under <ATM root>/resources.".to_string()
        })
}

fn resolve_cts_apk_dir(app: &AppHandle, serial: &str, resource_root: &Path) -> Result<(PathBuf, String), String> {
    let release = adb_device_output(serial, &["shell", "getprop", "ro.build.version.release"]).unwrap_or_default();
    let oneui = adb_device_output(serial, &["shell", "getprop", "ro.build.version.oneui"]).unwrap_or_default();
    let normalized = normalize_android_resource_version(release.trim(), oneui.trim());
    let normal = resource_root.join("Normal");
    let normalized_path = normal.join(&normalized);
    if normalized_path.is_dir() {
        return Ok((normalized_path, format!("Normal/{normalized}")));
    }
    let major = release.trim().split('.').next().unwrap_or("15");
    let major_path = normal.join(major);
    if major_path.is_dir() {
        return Ok((major_path, format!("Normal/{major}")));
    }
    let _ = app;
    Ok((normal, "Normal/default".to_string()))
}

fn normalize_android_resource_version(release: &str, oneui: &str) -> String {
    let oneui_version = oneui.trim().parse::<u32>().unwrap_or(0);
    let release = release.trim();
    if release.starts_with("16") && oneui_version >= 80500 {
        "16.1".to_string()
    } else if release.starts_with("16") {
        "16".to_string()
    } else if release.starts_with("15") {
        "15".to_string()
    } else if release.starts_with("14") {
        "14".to_string()
    } else {
        release.split('.').next().unwrap_or("15").to_string()
    }
}

fn install_apk(serial: &str, apk_path: &Path, extra_flags: &[&str]) -> Result<(), String> {
    if !apk_path.is_file() {
        return Err(format!("Missing APK: {}", apk_path.display()));
    }
    let apk = apk_path.to_string_lossy();
    let mut args = vec!["install", "-r", "-d"];
    args.extend(extra_flags.iter().copied());
    args.push(&apk);
    adb_device_output(serial, &args).map(|_| ())
}

fn install_optional_apk(serial: &str, apk_path: &Path) {
    if apk_path.is_file() {
        let _ = install_apk(serial, apk_path, &["-g", "-t"]);
    }
}

fn grant_cts_permissions(serial: &str) {
    for permission in [
        "android.permission.ACCESS_FINE_LOCATION",
        "android.permission.ACCESS_COARSE_LOCATION",
        "android.permission.READ_EXTERNAL_STORAGE",
        "android.permission.WRITE_EXTERNAL_STORAGE",
        "android.permission.CAMERA",
        "android.permission.RECORD_AUDIO",
        "android.permission.READ_CONTACTS",
        "android.permission.READ_PHONE_STATE",
        "android.permission.POST_NOTIFICATIONS",
        "android.permission.BLUETOOTH_CONNECT",
        "android.permission.BLUETOOTH_SCAN",
        "android.permission.NEARBY_WIFI_DEVICES",
    ] {
        let _ = adb_device_output(serial, &["shell", "pm", "grant", "com.android.cts.verifier", permission]);
    }
}

fn package_installed(serial: &str, package_name: &str) -> bool {
    adb_device_output(serial, &["shell", "pm", "path", package_name])
        .map(|output| output.contains("package:"))
        .unwrap_or(false)
}

fn automation_instrumentation_available(serial: &str) -> bool {
    adb_device_output(serial, &["shell", "pm", "list", "instrumentation"])
        .map(|output| output.contains("com.example.autoctsver.test/androidx.test.runner.AndroidJUnitRunner"))
        .unwrap_or(false)
}

fn ensure_cts_verifier_runtime(app: &AppHandle, serial: &str, atm_root: Option<&Path>) -> Result<(), String> {
    let needs_core = !package_installed(serial, "com.android.cts.verifier")
        || !package_installed(serial, "com.android.cts.emptydeviceowner");
    let needs_automation = !package_installed(serial, "com.example.autoctsver")
        || !package_installed(serial, "com.example.autoctsver.test")
        || !automation_instrumentation_available(serial);

    if !needs_core && !needs_automation {
        cts_log(app, serial, "CTS Verifier runtime verified.");
        return Ok(());
    }

    let resource_root = resolve_cts_resource_root(app, atm_root)?;
    if needs_core {
        let (apk_dir, _) = resolve_cts_apk_dir(app, serial, &resource_root)?;
        cts_log(app, serial, "Installing missing CTS Verifier core APKs...");
        install_apk(serial, &apk_dir.join("CtsVerifier.apk"), &["-g", "-t"])?;
        install_apk(serial, &apk_dir.join("CtsEmptyDeviceOwner.apk"), &["-t"])?;
        install_optional_apk(serial, &apk_dir.join("CtsPermissionApp.apk"));
        grant_cts_permissions(serial);
    }
    if needs_automation {
        cts_log(app, serial, "Installing missing AutoCtsVerifier automation APKs...");
        let automation_root = resource_root.join("ApkTest");
        install_apk(serial, &automation_root.join("AutoCtsVerifier-debug.apk"), &["-t", "-g"])?;
        install_apk(serial, &automation_root.join("AutoCtsVerifier-debug-androidTest.apk"), &["-t", "-g"])?;
        if !automation_instrumentation_available(serial) {
            return Err("AutoCtsVerifier instrumentation runner is not available after install.".to_string());
        }
    }
    Ok(())
}

fn convert_legacy_testcase_name(testcase: &str) -> String {
    testcase
        .chars()
        .filter(|character| {
            !matches!(
                character,
                ' ' | '\t' | '-' | '*' | ':' | '+' | '(' | ')' | '#' | '/' | '_' | ',' | '&'
            )
        })
        .collect()
}

fn automation_test_class(testcase: &str) -> String {
    let converted = convert_legacy_testcase_name(testcase);
    let converted = if converted.contains("6DoF") {
        format!("_{converted}")
    } else {
        converted
    };
    format!("com.example.autoctsver.ExampleInstrumentedTest#{converted}")
}

fn run_cts_pre_test_setup(serial: &str) {
    let _ = adb_device_output(serial, &["shell", "input", "keyevent", "KEYCODE_WAKEUP"]);
    let _ = adb_device_output(serial, &["shell", "locksettings", "clear", "--old", "1111"]);
    let _ = adb_device_output(serial, &["shell", "locksettings", "set-disabled", "true"]);
    let _ = adb_device_output(serial, &["shell", "settings", "put", "system", "accelerometer_rotation", "0"]);
    let _ = adb_device_output(serial, &["shell", "settings", "put", "system", "user_rotation", "0"]);
}

fn run_cts_status_command(app: &AppHandle, serial: &str, command_text: &str, automation_class: &str) {
    let replaced = command_text.replace(
        "DEFAULT_CMD",
        &format!(
            "-e class {} com.example.autoctsver.test/androidx.test.runner.AndroidJUnitRunner",
            automation_class
        ),
    );
    let parts: Vec<&str> = replaced.split_whitespace().collect();
    if parts.is_empty() {
        return;
    }
    cts_log(app, serial, &format!("Executing requested ADB command: {replaced}"));
    let _ = adb_device_output(serial, &parts);
}

fn install_requested_cts_apk(app: &AppHandle, serial: &str, atm_root: Option<&Path>, apk_name: &str) -> Result<(), String> {
    let resource_root = resolve_cts_resource_root(app, atm_root)?;
    let (apk_dir, _) = resolve_cts_apk_dir(app, serial, &resource_root)?;
    let apk_path = apk_dir.join(apk_name);
    cts_log(app, serial, &format!("Installing requested APK: {apk_name}"));
    if apk_name.contains("CtsEmptyDeviceOwner") {
        install_apk(serial, &apk_path, &["-t"])
    } else if apk_name.contains("CtsVerifierInstantApp") {
        install_apk(serial, &apk_path, &["--instant"])
    } else {
        install_apk(serial, &apk_path, &["-g"])
    }
}

fn push_requested_cts_apk(app: &AppHandle, serial: &str, atm_root: Option<&Path>, apk_name: &str) -> Result<(), String> {
    let resource_root = resolve_cts_resource_root(app, atm_root)?;
    let (apk_dir, _) = resolve_cts_apk_dir(app, serial, &resource_root)?;
    let apk_path = apk_dir.join(apk_name);
    if !apk_path.is_file() {
        return Err(format!("Missing APK: {}", apk_path.display()));
    }
    let apk = apk_path.to_string_lossy();
    cts_log(app, serial, &format!("Pushing requested APK: {apk_name}"));
    let _ = adb_device_output(serial, &["push", &apk, "/data/local/tmp/"]);
    let _ = adb_device_output(serial, &["push", &apk, "/sdcard"]);
    Ok(())
}

fn parse_getprop_line(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    let split = trimmed.find("]: [")?;
    let key = trimmed.get(1..split)?;
    let value_start = split + 4;
    let value_end = trimmed.len().checked_sub(1)?;
    let value = trimmed.get(value_start..value_end)?;
    Some((key.to_string(), value.to_string()))
}

fn token_value(line: &str, key: &str) -> String {
    let needle = format!("{key}:");
    line.split_whitespace()
        .find_map(|part| part.strip_prefix(&needle).map(|value| value.to_string()))
        .unwrap_or_default()
}

fn first_non_empty(values: &[String]) -> String {
    values
        .iter()
        .find(|value| !value.trim().is_empty())
        .cloned()
        .unwrap_or_default()
}

fn check_file(label: &str, path: PathBuf) -> String {
    format!(
        "{} {label}: {}",
        if path.is_file() { "OK  " } else { "FAIL" },
        path.display()
    )
}

fn check_dir(label: &str, path: PathBuf) -> String {
    format!(
        "{} {label}: {}",
        if path.is_dir() { "OK  " } else { "FAIL" },
        path.display()
    )
}

fn safe_path_segment(value: &str) -> String {
    value
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') { ch } else { '_' })
        .collect()
}

fn cts_verifier_result_dir(root: &Path, serial: &str) -> PathBuf {
    let model = adb_device_output(serial, &["shell", "getprop", "ro.product.model"])
        .unwrap_or_else(|_| serial.to_string());
    let build = adb_device_output(serial, &["shell", "getprop", "ro.build.version.incremental"])
        .unwrap_or_else(|_| "unknown-build".to_string());
    root.join("results")
        .join(safe_path_segment(first_non_blank(&[model.trim(), serial])))
        .join(safe_path_segment(first_non_blank(&[build.trim(), "unknown-build"])))
        .join("CTSVerifier")
}

fn first_non_blank<'a>(values: &'a [&str]) -> &'a str {
    values
        .iter()
        .copied()
        .find(|value| !value.trim().is_empty())
        .unwrap_or("")
}

fn target_has_files(path: &Path) -> bool {
    std::fs::read_dir(path)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.flatten())
        .any(|entry| entry.path().is_file())
}
