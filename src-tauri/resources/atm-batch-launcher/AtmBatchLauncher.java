import javax.swing.*;
import javax.swing.border.EmptyBorder;
import javax.swing.table.AbstractTableModel;
import java.awt.*;
import java.awt.event.WindowAdapter;
import java.awt.event.WindowEvent;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.text.SimpleDateFormat;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.*;
import java.util.concurrent.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

public class AtmBatchLauncher {
    private static final Path ROOT = Paths.get("").toAbsolutePath().normalize();
    private static final String JAVA_BIN = System.getProperty("java.home") + File.separator + "bin" + File.separator + javaExeName();
    private static final long DEVICE_INFO_TIMEOUT_SECONDS = 12;
    private static final long TOOL_TIMEOUT_MINUTES = 120;

    private final JFrame frame = new JFrame("ATM Batch Launcher");
    private final DeviceTableModel deviceTableModel = new DeviceTableModel();
    private final JTable deviceTable = new JTable(deviceTableModel);
    private final JTextArea logArea = new JTextArea();
    private final JTextArea commandArea = new JTextArea();
    private final JTextField adbField = new JTextField(defaultAdbPath());
    private final JSpinner concurrencySpinner = new JSpinner(new SpinnerNumberModel(1, 1, 16, 1));
    private final JCheckBox runUpdateAgent = new JCheckBox("Run AtmAgent before batch", false);
    private final Map<ToolProfile, JCheckBox> toolChecks = new LinkedHashMap<>();
    private final JButton refreshButton = new JButton("Refresh Devices");
    private final JButton preflightButton = new JButton("Preflight");
    private final JButton runButton = new JButton("Run Batch");
    private final JButton cancelButton = new JButton("Cancel");
    private final JButton openResultsButton = new JButton("Open Results");
    private final JLabel statusLabel = new JLabel("Ready");

    private volatile boolean cancelRequested;
    private ExecutorService executor;
    private final List<Process> runningProcesses = Collections.synchronizedList(new ArrayList<>());
    private final Set<String> activeDeviceSerials = ConcurrentHashMap.newKeySet();
    private final Map<String, Set<String>> initialThirdPartyPackages = new ConcurrentHashMap<>();
    private static volatile boolean cliCancelRequested;
    private static volatile String cliAdbPath = adbExeName();
    private static final List<Process> cliRunningProcesses = Collections.synchronizedList(new ArrayList<>());
    private static final Map<String, Set<String>> cliInitialThirdPartyPackages = new ConcurrentHashMap<>();

    public static void main(String[] args) {
        if (args.length > 0 && "--preflight".equalsIgnoreCase(args[0])) {
            cliPreflight();
            return;
        }
        if (args.length > 0 && "--help".equalsIgnoreCase(args[0])) {
            cliHelp();
            return;
        }
        if (args.length > 0 && "--list-devices".equalsIgnoreCase(args[0])) {
            cliListDevices(parseArgs(args).getOrDefault("adb", defaultAdbPath()));
            return;
        }
        if (args.length > 0 && "--run".equalsIgnoreCase(args[0])) {
            int exitCode = cliRun(parseArgs(args));
            System.exit(exitCode);
            return;
        }
        if (GraphicsEnvironment.isHeadless()) {
            System.err.println("ATM Batch Launcher needs a graphical desktop session.");
            System.err.println("No DISPLAY was detected, so Swing cannot open the launcher window.");
            System.err.println();
            System.err.println("Run it from a Linux desktop terminal, or configure X11 forwarding / a WSL X server.");
            System.err.println("For terminal-only validation, run:");
            System.err.println("  java atm-batch-launcher/AtmBatchLauncher.java --preflight");
            System.err.println("  java atm-batch-launcher/AtmBatchLauncher.java --list-devices");
            System.err.println("  java atm-batch-launcher/AtmBatchLauncher.java --run --tools getprop --devices all");
            System.exit(2);
        }
        SwingUtilities.invokeLater(() -> new AtmBatchLauncher().show());
    }

    private void show() {
        configureLookAndFeel();
        buildUi();
        wireEvents();
        frame.setDefaultCloseOperation(WindowConstants.DO_NOTHING_ON_CLOSE);
        frame.addWindowListener(new WindowAdapter() {
            @Override public void windowClosing(WindowEvent e) {
                requestCancel();
                frame.dispose();
                System.exit(0);
            }
        });
        frame.setMinimumSize(new Dimension(1100, 720));
        frame.setLocationRelativeTo(null);
        frame.setVisible(true);
        refreshDevices();
    }

    private void buildUi() {
        JPanel root = new JPanel(new BorderLayout(10, 10));
        root.setBorder(new EmptyBorder(10, 10, 10, 10));
        frame.setContentPane(root);

        JPanel top = new JPanel(new BorderLayout(8, 8));
        JPanel env = new JPanel(new BorderLayout(6, 0));
        env.add(new JLabel("ADB"), BorderLayout.WEST);
        env.add(adbField, BorderLayout.CENTER);
        JPanel topButtons = new JPanel(new FlowLayout(FlowLayout.RIGHT, 6, 0));
        topButtons.add(refreshButton);
        topButtons.add(preflightButton);
        topButtons.add(openResultsButton);
        top.add(env, BorderLayout.CENTER);
        top.add(topButtons, BorderLayout.EAST);
        root.add(top, BorderLayout.NORTH);

        deviceTable.setAutoCreateRowSorter(true);
        deviceTable.setRowHeight(24);
        JScrollPane deviceScroll = new JScrollPane(deviceTable);
        deviceScroll.setBorder(BorderFactory.createTitledBorder("Devices"));

        JPanel options = new JPanel();
        options.setLayout(new BoxLayout(options, BoxLayout.Y_AXIS));
        options.setBorder(BorderFactory.createTitledBorder("Batch Plan"));
        options.add(runUpdateAgent);
        options.add(spacer());
        JPanel concurrency = new JPanel(new FlowLayout(FlowLayout.LEFT, 4, 0));
        concurrency.add(new JLabel("Parallel devices"));
        concurrency.add(concurrencySpinner);
        options.add(concurrency);
        options.add(spacer());
        for (ToolProfile tool : ToolProfile.values()) {
            JCheckBox check = new JCheckBox(tool.displayName + (tool.enabled ? "" : " (detected only)"), tool.defaultSelected);
            check.setEnabled(tool.enabled);
            check.setToolTipText(tool.description);
            toolChecks.put(tool, check);
            options.add(check);
        }
        options.add(Box.createVerticalGlue());

        JSplitPane mainSplit = new JSplitPane(JSplitPane.HORIZONTAL_SPLIT, deviceScroll, options);
        mainSplit.setResizeWeight(0.78);
        root.add(mainSplit, BorderLayout.CENTER);

        logArea.setEditable(false);
        logArea.setFont(new Font(Font.MONOSPACED, Font.PLAIN, 12));
        commandArea.setEditable(false);
        commandArea.setFont(new Font(Font.MONOSPACED, Font.PLAIN, 12));
        JTabbedPane tabs = new JTabbedPane();
        tabs.addTab("Run Log", new JScrollPane(logArea));
        tabs.addTab("Command Preview", new JScrollPane(commandArea));
        tabs.setPreferredSize(new Dimension(100, 230));

        JPanel bottom = new JPanel(new BorderLayout(8, 0));
        JPanel actions = new JPanel(new FlowLayout(FlowLayout.RIGHT, 6, 0));
        cancelButton.setEnabled(false);
        actions.add(cancelButton);
        actions.add(runButton);
        bottom.add(statusLabel, BorderLayout.CENTER);
        bottom.add(actions, BorderLayout.EAST);

        JPanel south = new JPanel(new BorderLayout(8, 8));
        south.add(tabs, BorderLayout.CENTER);
        south.add(bottom, BorderLayout.SOUTH);
        root.add(south, BorderLayout.SOUTH);
    }

    private Component spacer() {
        return Box.createRigidArea(new Dimension(1, 8));
    }

    private void wireEvents() {
        refreshButton.addActionListener(e -> refreshDevices());
        preflightButton.addActionListener(e -> runPreflightDialog());
        runButton.addActionListener(e -> runBatch());
        cancelButton.addActionListener(e -> requestCancel());
        openResultsButton.addActionListener(e -> openResultsFolder());
        for (JCheckBox check : toolChecks.values()) {
            check.addActionListener(e -> updateCommandPreview());
        }
        deviceTableModel.onChange = this::updateCommandPreview;
        updateCommandPreview();
    }

    private void refreshDevices() {
        setBusy(true, "Refreshing devices...");
        log("Refreshing devices via adb.");
        CompletableFuture.supplyAsync(this::discoverDevices).whenComplete((devices, error) -> SwingUtilities.invokeLater(() -> {
            if (error != null) {
                log("Device refresh failed: " + error.getMessage());
                JOptionPane.showMessageDialog(frame, error.getMessage(), "Refresh Failed", JOptionPane.ERROR_MESSAGE);
            } else {
                deviceTableModel.setDevices(devices);
                log("Found " + devices.size() + " device row(s).");
            }
            setBusy(false, "Ready");
            updateCommandPreview();
        }));
    }

    private List<DeviceInfo> discoverDevices() {
        CommandResult adbDevices = runCommand(Arrays.asList(adb(), "devices", "-l"), ROOT, null, Duration.ofSeconds(15));
        if (adbDevices.exitCode != 0) {
            throw new IllegalStateException("adb devices failed:\n" + adbDevices.output);
        }
        List<DeviceInfo> devices = new ArrayList<>();
        for (String line : adbDevices.output.split("\\R")) {
            String trimmed = line.trim();
            if (trimmed.isEmpty() || trimmed.startsWith("List of devices") || trimmed.startsWith("*")) continue;
            String[] parts = trimmed.split("\\s+");
            if (parts.length < 2) continue;
            DeviceInfo device = new DeviceInfo();
            device.selected = "device".equals(parts[1]);
            device.serial = parts[0];
            device.state = parts[1];
            device.product = tokenValue(trimmed, "product");
            device.model = tokenValue(trimmed, "model");
            device.transport = tokenValue(trimmed, "transport_id");
            if ("device".equals(device.state)) {
                enrichDeviceInfo(device);
            } else {
                device.status = "Not authorized/ready";
            }
            devices.add(device);
        }
        return devices;
    }

    private void enrichDeviceInfo(DeviceInfo device) {
        Map<String, String> props = adbProps(device.serial);
        device.model = firstNonBlank(device.model, props.get("ro.product.model"), props.get("ro.product.vendor.model"));
        device.build = firstNonBlank(props.get("ro.build.version.incremental"), props.get("ro.vendor.build.version.incremental"));
        device.csc = firstNonBlank(props.get("ril.official_cscver"), props.get("ro.csc.sales_code"));
        device.android = firstNonBlank(props.get("ro.build.version.release"), props.get("ro.system.build.version.release"));
        device.status = "Ready";
    }

    private Map<String, String> adbProps(String serial) {
        CommandResult result = runCommand(Arrays.asList(adb(), "-s", serial, "shell", "getprop"), ROOT, null, Duration.ofSeconds(DEVICE_INFO_TIMEOUT_SECONDS));
        Map<String, String> props = new HashMap<>();
        Pattern pattern = Pattern.compile("^\\[(.+?)]\\s*:\\s*\\[(.*)]$");
        for (String line : result.output.split("\\R")) {
            Matcher matcher = pattern.matcher(line.trim());
            if (matcher.matches()) props.put(matcher.group(1), matcher.group(2));
        }
        return props;
    }

    private void runPreflightDialog() {
        List<String> lines = preflight();
        JTextArea text = new JTextArea(String.join("\n", lines), 18, 80);
        text.setEditable(false);
        text.setFont(new Font(Font.MONOSPACED, Font.PLAIN, 12));
        JOptionPane.showMessageDialog(frame, new JScrollPane(text), "Preflight", JOptionPane.INFORMATION_MESSAGE);
        lines.forEach(this::log);
    }

    private List<String> preflight() {
        List<String> lines = new ArrayList<>();
        lines.add(checkFile("Java runtime", Paths.get(JAVA_BIN)));
        lines.add(checkExecutable("ADB", adb()));
        lines.add(checkFile("ATM_v5.jar", ROOT.resolve("ATM_v5.jar")));
        lines.add(checkFile("AtmAgent.jar", ROOT.resolve("AtmAgent.jar")));
        lines.add(checkFile("AtmInfo.xml", ROOT.resolve("AtmInfo.xml")));
        lines.add(checkDir("tools", ROOT.resolve("tools")));
        lines.add(checkDir("results", ensureResultsDir()));
        for (ToolProfile tool : ToolProfile.values()) {
            lines.add(checkFile(tool.displayName, ROOT.resolve(tool.jarPath)));
        }
        long ready = deviceTableModel.devices.stream().filter(d -> "device".equals(d.state)).count();
        lines.add((ready > 0 ? "OK   " : "WARN ") + "Authorized devices: " + ready);
        return lines;
    }

    private void runBatch() {
        List<DeviceInfo> selectedDevices = deviceTableModel.devices.stream()
                .filter(d -> d.selected && "device".equals(d.state))
                .collect(Collectors.toList());
        List<ToolProfile> selectedTools = toolChecks.entrySet().stream()
                .filter(e -> e.getValue().isEnabled() && e.getValue().isSelected())
                .map(Map.Entry::getKey)
                .collect(Collectors.toList());
        if (selectedDevices.isEmpty()) {
            JOptionPane.showMessageDialog(frame, "Select at least one authorized device.", "No Device", JOptionPane.WARNING_MESSAGE);
            return;
        }
        if (selectedTools.isEmpty()) {
            JOptionPane.showMessageDialog(frame, "Select at least one enabled tool.", "No Tool", JOptionPane.WARNING_MESSAGE);
            return;
        }

        cancelRequested = false;
        activeDeviceSerials.clear();
        initialThirdPartyPackages.clear();
        setRunning(true);
        int concurrency = (Integer) concurrencySpinner.getValue();
        executor = Executors.newFixedThreadPool(concurrency);
        Path runDir = ROOT.resolve("atm-batch-launcher").resolve("runs").resolve(timestamp());
        createDirectories(runDir);
        log("Batch started. Devices=" + selectedDevices.size() + ", tools=" + selectedTools.size() + ", concurrency=" + concurrency);
        log("Run directory: " + runDir);

        CompletableFuture.runAsync(() -> {
            if (runUpdateAgent.isSelected() && !cancelRequested) {
                runUpdateAgent(runDir);
            }
            List<Future<?>> futures = new ArrayList<>();
            for (DeviceInfo device : selectedDevices) {
                futures.add(executor.submit(() -> runDeviceSequence(device, selectedTools, runDir)));
            }
            for (Future<?> future : futures) {
                try {
                    future.get();
                } catch (CancellationException ignored) {
                } catch (Exception ex) {
                    log("Worker failed: " + ex.getMessage());
                }
            }
            executor.shutdownNow();
        }).whenComplete((ok, error) -> SwingUtilities.invokeLater(() -> {
            if (error != null) log("Batch ended with error: " + error.getMessage());
            log(cancelRequested ? "Batch cancelled." : "Batch completed.");
            setRunning(false);
            refreshDevices();
        }));
    }

    private void runUpdateAgent(Path runDir) {
        log("Running AtmAgent update check...");
        ProcessOutcome outcome = runLoggedProcess(Arrays.asList(JAVA_BIN, "-jar", "AtmAgent.jar"), ROOT, null,
                runDir.resolve("AtmAgent.log"), Duration.ofMinutes(15));
        log("AtmAgent exit=" + outcome.exitCode + " duration=" + outcome.durationSeconds + "s");
    }

    private void runDeviceSequence(DeviceInfo device, List<ToolProfile> tools, Path runDir) {
        activeDeviceSerials.add(device.serial);
        initialThirdPartyPackages.put(device.serial, listThirdPartyPackages(device.serial));
        updateDeviceStatus(device, "Running");
        try {
            for (ToolProfile tool : tools) {
                if (cancelRequested) break;
                updateDeviceStatus(device, "Running " + tool.displayName);
                Path deviceRunDir = runDir.resolve(safeName(device.serial));
                createDirectories(deviceRunDir);
                Path logFile = deviceRunDir.resolve(tool.name() + ".log");
                Map<String, String> env = new HashMap<>();
                env.put("ANDROID_SERIAL", device.serial);
                env.put("ATM_BATCH_SERIAL", device.serial);
                env.put("ATM_BATCH_RESULT_DIR", ensureResultsDir().toString());
                env.put("ATM_BATCH_RUN_DIR", deviceRunDir.toString());
                List<String> command = tool.command(device, deviceRunDir);
                log("[" + device.serial + "] START " + tool.displayName + ": " + printable(command));
                Instant toolStarted = Instant.now();
                ProcessOutcome outcome = runLoggedProcess(command, ROOT.resolve("tools"), env, logFile, Duration.ofMinutes(TOOL_TIMEOUT_MINUTES));
                ResultSummary inspected = cancelRequested
                        ? new ResultSummary("CANCELLED", "cancel requested")
                        : inspectResult(device, tool, toolStarted, outcome.exitCode);
                ResultSummary summary = outcome.exitCode != 0 || outcome.timedOut
                        ? new ResultSummary("ERROR", processFailureDetail(outcome, inspected))
                        : inspected;
                log("[" + device.serial + "] END " + tool.displayName + " exit=" + outcome.exitCode
                        + " duration=" + outcome.durationSeconds + "s result=" + summary.status + " " + summary.detail);
                if (tool == ToolProfile.BVT) {
                    bvtSummaryFromSummary(summary).ifPresent(bvtSummary ->
                            log("[" + device.serial + "] BVT_SUMMARY\t" + bvtSummary.total + "\t" + bvtSummary.pass + "\t" + bvtSummary.failed));
                    for (BvtSubtest subtest : bvtSubtestsFromSummary(summary)) {
                        if (!subtest.isFailed()) continue;
                        log("[" + device.serial + "] BVT_SUBTEST\t" + subtest.status + "\t" + subtest.name);
                    }
                }
                updateDeviceLastResult(device, tool.displayName + ": " + summary.status);
                if (outcome.timedOut || outcome.exitCode != 0 || !isSuccessfulStatus(summary.status)) {
                    updateDeviceStatus(device, cancelRequested ? "Cancelled" : "Error in " + tool.displayName);
                    if (cancelRequested) break;
                }
            }
            if (cancelRequested) {
                updateDeviceStatus(device, "Cleaning up");
                cleanupInstalledPackages(device.serial);
                updateDeviceStatus(device, "Cancelled");
            } else if (!device.status.startsWith("Error")) {
                updateDeviceStatus(device, "Done");
            }
        } finally {
            activeDeviceSerials.remove(device.serial);
        }
    }

    private ProcessOutcome runLoggedProcess(List<String> command, Path workDir, Map<String, String> env,
                                            Path logFile, Duration timeout) {
        Instant started = Instant.now();
        int exitCode = -1;
        boolean timedOut = false;
        try {
            createDirectories(logFile.getParent());
            ProcessBuilder builder = new ProcessBuilder(command);
            builder.directory(workDir.toFile());
            builder.redirectErrorStream(true);
            if (env != null) builder.environment().putAll(env);
            Process process = builder.start();
            runningProcesses.add(process);
            ExecutorService pumpExecutor = Executors.newSingleThreadExecutor();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8));
                 BufferedWriter writer = Files.newBufferedWriter(logFile, StandardCharsets.UTF_8)) {
                Future<?> pump = pumpExecutor.submit(() -> {
                    try {
                        String line;
                        while ((line = reader.readLine()) != null) {
                            writer.write(line);
                            writer.newLine();
                            String display = trimLogLine(line);
                            if (!display.isEmpty()) log(display);
                        }
                    } catch (IOException ignored) {
                    }
                });
                long deadline = System.nanoTime() + timeout.toNanos();
                while (!cancelRequested && System.nanoTime() < deadline) {
                    if (process.waitFor(250, TimeUnit.MILLISECONDS)) break;
                }
                if (process.isAlive() && cancelRequested) {
                    process.destroy();
                    if (!process.waitFor(2, TimeUnit.SECONDS)) process.destroyForcibly();
                    log("Process cancelled: " + printable(command));
                } else if (process.isAlive()) {
                    timedOut = true;
                    process.destroyForcibly();
                    log("Process timed out: " + printable(command));
                }
                exitCode = process.waitFor();
                try { pump.get(2, TimeUnit.SECONDS); } catch (Exception ignored) {}
            } finally {
                pumpExecutor.shutdownNow();
                runningProcesses.remove(process);
            }
        } catch (Exception ex) {
            log("Process failed: " + printable(command) + " :: " + ex.getMessage());
        }
        return new ProcessOutcome(exitCode, timedOut, Duration.between(started, Instant.now()).getSeconds());
    }

    private ResultSummary inspectResult(DeviceInfo device, ToolProfile tool, Instant startedAt, int exitCode) {
        try {
            List<Path> candidates = findResultCandidates(device, tool, startedAt);
            if (candidates.isEmpty()) {
                if (tool == ToolProfile.SDT) {
                    if (exitCode == 0) {
                        return new ResultSummary("PASS", "exit=0 (SDT saved result externally)");
                    }
                    ResultSummary deviceResult = inspectDeviceSdtResult(adb(), device);
                    return deviceResult;
                }
                return new ResultSummary("NOTEXECUTED", "no fresh result file found");
            }
            Path latest = candidates.stream().max(Comparator.comparingLong(this::lastModified)).orElse(candidates.get(0));
            if (tool == ToolProfile.BVT) return parseBvtResult(latest);
            return new ResultSummary("PASS", latest.toString());
        } catch (Exception ex) {
            return new ResultSummary("ERROR", ex.getMessage());
        }
    }

    private List<Path> findResultCandidates(DeviceInfo device, ToolProfile tool, Instant startedAt) throws IOException {
        List<Path> all;
        List<Path> roots = resultSearchRoots(tool);
        all = new ArrayList<>();
        for (Path root : roots) {
            if (!Files.exists(root)) continue;
            try (var stream = Files.walk(root, resultSearchDepth(tool))) {
                all.addAll(stream.filter(Files::isRegularFile)
                        .filter(p -> isResultFileName(tool, p.getFileName().toString()))
                        .filter(p -> tool == ToolProfile.SDT || modifiedAtOrAfter(p, startedAt))
                        .collect(Collectors.toList()));
            }
        }
        String model = nullToEmpty(device.model);
        String build = nullToEmpty(device.build);
        List<Path> preferred = all.stream()
                .filter(p -> (!model.isBlank() && p.toString().contains(model))
                        || p.toString().contains(device.serial)
                        || (!build.isBlank() && p.toString().contains(build)))
                .collect(Collectors.toList());
        return preferred.isEmpty() ? all : preferred;
    }

    private ResultSummary parseBvtResult(Path xml) throws IOException {
        String text = Files.readString(xml, StandardCharsets.UTF_8);
        int failed = intAttr(text, "failed", -1);
        int pass = intAttr(text, "pass", -1);
        int modulesDone = intAttr(text, "modules_done", -1);
        int modulesTotal = intAttr(text, "modules_total", -1);
        if (failed > 0 && failed <= 2) return new ResultSummary("WARNING", "failed=" + failed + " pass=" + pass + " file=" + xml);
        if (failed > 2) return new ResultSummary("FAIL", "failed=" + failed + " pass=" + pass + " file=" + xml);
        if (modulesTotal > 0 && modulesDone >= 0 && modulesDone < modulesTotal) {
            return new ResultSummary("INCOMPLETE", "modules=" + modulesDone + "/" + modulesTotal + " file=" + xml);
        }
        if (pass <= 0 && failed == 0) return new ResultSummary("INCOMPLETE", "pass=0 file=" + xml);
        return new ResultSummary("PASS", "pass=" + pass + " file=" + xml);
    }

    private void requestCancel() {
        if (cancelRequested) return;
        cancelRequested = true;
        synchronized (runningProcesses) {
            for (Process process : runningProcesses) {
                process.destroy();
            }
        }
        if (executor != null) executor.shutdownNow();
        log("Cancel requested.");
    }

    private Set<String> listThirdPartyPackages(String serial) {
        CommandResult result = runCommand(Arrays.asList(adb(), "-s", serial, "shell", "pm", "list", "packages", "-3"),
                ROOT, null, Duration.ofSeconds(20));
        Set<String> packages = new LinkedHashSet<>();
        for (String line : result.output.split("\\R")) {
            String pkg = line.trim().replaceFirst("^package:", "");
            if (!pkg.isBlank()) packages.add(pkg);
        }
        return packages;
    }

    private void cleanupInstalledPackages(String serial) {
        Set<String> before = initialThirdPartyPackages.getOrDefault(serial, Set.of());
        Set<String> after = listThirdPartyPackages(serial);
        after.removeAll(before);
        if (after.isEmpty()) {
            log("[" + serial + "] Cleanup: no new APK packages found.");
            return;
        }
        for (String pkg : after) {
            CommandResult result = runCommand(Arrays.asList(adb(), "-s", serial, "uninstall", pkg), ROOT, null, Duration.ofSeconds(45));
            log("[" + serial + "] Cleanup uninstall " + pkg + " exit=" + result.exitCode);
        }
    }

    private void setRunning(boolean running) {
        refreshButton.setEnabled(!running);
        preflightButton.setEnabled(!running);
        runButton.setEnabled(!running);
        cancelButton.setEnabled(running);
        statusLabel.setText(running ? "Running batch..." : "Ready");
    }

    private void setBusy(boolean busy, String status) {
        refreshButton.setEnabled(!busy);
        preflightButton.setEnabled(!busy);
        runButton.setEnabled(!busy);
        statusLabel.setText(status);
    }

    private void updateCommandPreview() {
        List<DeviceInfo> selectedDevices = deviceTableModel.devices.stream().filter(d -> d.selected).collect(Collectors.toList());
        StringBuilder sb = new StringBuilder();
        sb.append("Root: ").append(ROOT).append('\n');
        sb.append("Java: ").append(JAVA_BIN).append('\n');
        sb.append("ADB : ").append(adb()).append("\n\n");
        for (DeviceInfo device : selectedDevices) {
            sb.append("# ").append(device.serial).append('\n');
            for (ToolProfile tool : ToolProfile.values()) {
                JCheckBox check = toolChecks.get(tool);
                if (check != null && check.isEnabled() && check.isSelected()) {
                    sb.append(printable(tool.command(device, ROOT.resolve("atm-batch-launcher").resolve("runs").resolve("preview")))).append('\n');
                }
            }
            sb.append('\n');
        }
        commandArea.setText(sb.toString());
    }

    private void updateDeviceStatus(DeviceInfo device, String status) {
        SwingUtilities.invokeLater(() -> {
            device.status = status;
            deviceTableModel.fireTableDataChanged();
        });
    }

    private void updateDeviceLastResult(DeviceInfo device, String result) {
        SwingUtilities.invokeLater(() -> {
            device.lastResult = result;
            deviceTableModel.fireTableDataChanged();
        });
    }

    private void openResultsFolder() {
        Path results = ensureResultsDir();
        try {
            Desktop.getDesktop().open(results.toFile());
        } catch (Exception ex) {
            JOptionPane.showMessageDialog(frame, results.toString(), "Results Folder", JOptionPane.INFORMATION_MESSAGE);
        }
    }

    private CommandResult runCommand(List<String> command, Path workDir, Map<String, String> env, Duration timeout) {
        try {
            ProcessBuilder builder = new ProcessBuilder(command);
            builder.directory(workDir.toFile());
            builder.redirectErrorStream(true);
            if (env != null) builder.environment().putAll(env);
            Process process = builder.start();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            Thread reader = new Thread(() -> {
                try (InputStream in = process.getInputStream()) {
                    in.transferTo(out);
                } catch (IOException ignored) {
                }
            });
            reader.start();
            if (!process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS)) {
                process.destroyForcibly();
                return new CommandResult(-1, out.toString(StandardCharsets.UTF_8) + "\nTimed out");
            }
            reader.join(1000);
            return new CommandResult(process.exitValue(), out.toString(StandardCharsets.UTF_8));
        } catch (Exception ex) {
            return new CommandResult(-1, ex.getMessage());
        }
    }

    private void log(String message) {
        SwingUtilities.invokeLater(() -> {
            String ts = new SimpleDateFormat("HH:mm:ss").format(new Date());
            logArea.append(ts + " " + message + "\n");
            logArea.setCaretPosition(logArea.getDocument().getLength());
        });
    }

    private Path ensureResultsDir() {
        Path results = ROOT.resolve("results");
        createDirectories(results);
        return results;
    }

    private void createDirectories(Path path) {
        try {
            Files.createDirectories(path);
        } catch (IOException ex) {
            throw new IllegalStateException("Cannot create " + path + ": " + ex.getMessage(), ex);
        }
    }

    private String adb() {
        String value = adbField.getText().trim();
        return value.isEmpty() ? "adb" : value;
    }

    private static String defaultAdbPath() {
        String home = System.getProperty("user.home", "");
        Path androidAdb = Paths.get(home, "Android", "Sdk", "platform-tools", adbExeName());
        if (Files.exists(androidAdb)) return androidAdb.toString();
        return adbExeName();
    }

    private static String javaExeName() {
        return isWindows() ? "java.exe" : "java";
    }

    private static String adbExeName() {
        return isWindows() ? "adb.exe" : "adb";
    }

    private static boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win");
    }

    private static void configureLookAndFeel() {
        try {
            UIManager.setLookAndFeel(UIManager.getSystemLookAndFeelClassName());
        } catch (Exception ignored) {
        }
    }

    private static void cliPreflight() {
        List<String> lines = new ArrayList<>();
        lines.add("ATM Batch Launcher CLI preflight");
        lines.add("Root: " + ROOT);
        lines.add(checkFile("Java runtime", Paths.get(JAVA_BIN)));
        lines.add(checkFile("ATM_v5.jar", ROOT.resolve("ATM_v5.jar")));
        lines.add(checkFile("AtmAgent.jar", ROOT.resolve("AtmAgent.jar")));
        lines.add(checkFile("AtmInfo.xml", ROOT.resolve("AtmInfo.xml")));
        lines.add(checkDir("tools", ROOT.resolve("tools")));
        lines.add(checkDir("results", ROOT.resolve("results")));
        for (ToolProfile tool : ToolProfile.values()) {
            lines.add(checkFile(tool.displayName, ROOT.resolve(tool.jarPath)));
        }
        lines.forEach(System.out::println);
    }

    private static void cliHelp() {
        System.out.println("ATM Batch Launcher");
        System.out.println();
        System.out.println("GUI:");
        System.out.println("  java atm-batch-launcher/AtmBatchLauncher.java");
        System.out.println();
        System.out.println("CLI:");
        System.out.println("  java atm-batch-launcher/AtmBatchLauncher.java --preflight");
        System.out.println("  java atm-batch-launcher/AtmBatchLauncher.java --list-devices");
        System.out.println("  java atm-batch-launcher/AtmBatchLauncher.java --run --tools getprop --devices all");
        System.out.println("  java atm-batch-launcher/AtmBatchLauncher.java --run --tools getprop,bvt --devices SERIAL1,SERIAL2 --concurrency 2");
        System.out.println();
        System.out.println("Options:");
        System.out.println("  --tools       Comma-separated enabled tools: getprop,bvt,svt,sdt");
        System.out.println("  --devices     all, first, or comma-separated serials");
        System.out.println("  --concurrency Parallel devices, default 1");
        System.out.println("  --adb         Custom adb path");
        System.out.println("  --update      Run AtmAgent.jar before batch");
    }

    private static void cliListDevices(String adbPath) {
        List<DeviceInfo> devices = cliDiscoverDevices(adbPath);
        if (devices.isEmpty()) {
            System.out.println("No devices found.");
            return;
        }
        System.out.printf("%-6s %-22s %-12s %-18s %-10s %-18s %-12s%n",
                "RUN", "SERIAL", "STATE", "MODEL", "ANDROID", "BUILD", "CSC");
        for (DeviceInfo d : devices) {
            System.out.printf("%-6s %-22s %-12s %-18s %-10s %-18s %-12s%n",
                    "device".equals(d.state) ? "yes" : "no",
                    d.serial, d.state, limit(d.model, 18), limit(d.android, 10), limit(d.build, 18), limit(d.csc, 12));
        }
    }

    private static int cliRun(Map<String, String> args) {
        String adbPath = args.getOrDefault("adb", defaultAdbPath());
        cliAdbPath = adbPath;
        cliCancelRequested = false;
        cliInitialThirdPartyPackages.clear();
        List<ToolProfile> tools = parseTools(args.getOrDefault("tools", "getprop"));
        if (tools.isEmpty()) {
            System.err.println("No valid enabled tools selected. Use: getprop,bvt,svt,sdt");
            return 2;
        }
        List<DeviceInfo> discovered = cliDiscoverDevices(adbPath).stream()
                .filter(d -> "device".equals(d.state))
                .collect(Collectors.toList());
        List<DeviceInfo> devices = selectDevices(discovered, args.getOrDefault("devices", "first"));
        if (devices.isEmpty()) {
            System.err.println("No authorized devices selected. Check `adb devices -l` or run --list-devices.");
            return 2;
        }
        int concurrency = parseInt(args.getOrDefault("concurrency", "1"), 1);
        concurrency = Math.max(1, Math.min(concurrency, devices.size()));
        Path runDir = ROOT.resolve("atm-batch-launcher").resolve("runs").resolve(timestamp());
        staticCreateDirectories(runDir);

        System.out.println("ATM Batch CLI run");
        System.out.println("Root       : " + ROOT);
        System.out.println("Run dir    : " + runDir);
        System.out.println("Devices    : " + devices.stream().map(d -> d.serial).collect(Collectors.joining(", ")));
        System.out.println("Tools      : " + tools.stream().map(t -> t.displayName).collect(Collectors.joining(", ")));
        System.out.println("Concurrency: " + concurrency);
        startCliCancelWatcher(args.get("cancel-file"));

        if (args.containsKey("update")) {
            System.out.println("Running AtmAgent.jar...");
            ProcessOutcome update = cliRunLoggedProcess(Arrays.asList(JAVA_BIN, "-jar", "AtmAgent.jar"), ROOT, null,
                    runDir.resolve("AtmAgent.log"), Duration.ofMinutes(15));
            System.out.println("AtmAgent exit=" + update.exitCode + " duration=" + update.durationSeconds + "s");
        }

        ExecutorService pool = Executors.newFixedThreadPool(concurrency);
        List<Future<Boolean>> futures = new ArrayList<>();
        for (DeviceInfo device : devices) {
            futures.add(pool.submit(() -> cliRunDeviceSequence(device, tools, runDir)));
        }
        pool.shutdown();
        boolean ok = true;
        for (Future<Boolean> future : futures) {
            try {
                ok &= future.get();
            } catch (Exception ex) {
                if (!cliCancelRequested) {
                    ok = false;
                    System.err.println("Worker failed: " + ex.getMessage());
                }
            }
        }
        if (cliCancelRequested) {
            pool.shutdownNow();
            System.out.println("Batch cancelled.");
            return 130;
        }
        System.out.println(ok ? "Batch completed." : "Batch completed with errors.");
        return ok ? 0 : 1;
    }

    private static boolean cliRunDeviceSequence(DeviceInfo device, List<ToolProfile> tools, Path runDir) {
        boolean ok = true;
        Path deviceRunDir = runDir.resolve(safeName(device.serial));
        staticCreateDirectories(deviceRunDir);
        cliInitialThirdPartyPackages.put(device.serial, staticListThirdPartyPackages(device.serial));
        try {
            for (ToolProfile tool : tools) {
                if (cliCancelRequested) break;
                Path logFile = deviceRunDir.resolve(tool.name() + ".log");
                Map<String, String> env = new HashMap<>();
                env.put("ANDROID_SERIAL", device.serial);
                env.put("ATM_BATCH_SERIAL", device.serial);
                env.put("ATM_BATCH_TOOL", tool.displayName);
                env.put("ATM_BATCH_RESULT_DIR", ROOT.resolve("results").toString());
                env.put("ATM_BATCH_RUN_DIR", deviceRunDir.toString());
                List<String> command = tool.command(device, deviceRunDir);
                System.out.println("[" + device.serial + "] START " + tool.displayName + ": " + printable(command));
                System.out.println("[" + device.serial + "] LOG " + tool.displayName + ": " + logFile);
                Instant toolStarted = Instant.now();
                ProcessOutcome outcome = cliRunLoggedProcess(command, ROOT.resolve("tools"), env, logFile, Duration.ofMinutes(TOOL_TIMEOUT_MINUTES));
                ResultSummary inspected = cliCancelRequested
                        ? new ResultSummary("CANCELLED", "cancel requested")
                        : staticInspectResult(device, tool, toolStarted, outcome.exitCode);
                ResultSummary summary = outcome.exitCode != 0 || outcome.timedOut
                        ? new ResultSummary("ERROR", processFailureDetail(outcome, inspected))
                        : inspected;
                System.out.println("[" + device.serial + "] END " + tool.displayName + " exit=" + outcome.exitCode
                        + " duration=" + outcome.durationSeconds + "s result=" + summary.status + " " + summary.detail);
                if (tool == ToolProfile.BVT) {
                    bvtSummaryFromSummary(summary).ifPresent(bvtSummary ->
                            System.out.println("[" + device.serial + "] BVT_SUMMARY\t" + bvtSummary.total + "\t" + bvtSummary.pass + "\t" + bvtSummary.failed));
                    for (BvtSubtest subtest : bvtSubtestsFromSummary(summary)) {
                        if (!subtest.isFailed()) continue;
                        System.out.println("[" + device.serial + "] BVT_SUBTEST\t" + subtest.status + "\t" + subtest.name);
                    }
                }
                if (outcome.exitCode != 0 || outcome.timedOut || !isSuccessfulStatus(summary.status)) ok = false;
            }
        } finally {
            if (cliCancelRequested) staticCleanupInstalledPackages(device.serial);
        }
        return ok;
    }

    private static List<DeviceInfo> cliDiscoverDevices(String adbPath) {
        CommandResult adbDevices = staticRunCommand(Arrays.asList(adbPath, "devices", "-l"), ROOT, null, Duration.ofSeconds(15));
        if (adbDevices.exitCode != 0) {
            throw new IllegalStateException("adb devices failed:\n" + adbDevices.output);
        }
        List<DeviceInfo> devices = new ArrayList<>();
        for (String line : adbDevices.output.split("\\R")) {
            String trimmed = line.trim();
            if (trimmed.isEmpty() || trimmed.startsWith("List of devices") || trimmed.startsWith("*")) continue;
            String[] parts = trimmed.split("\\s+");
            if (parts.length < 2) continue;
            DeviceInfo device = new DeviceInfo();
            device.selected = "device".equals(parts[1]);
            device.serial = parts[0];
            device.state = parts[1];
            device.product = tokenValue(trimmed, "product");
            device.model = tokenValue(trimmed, "model");
            device.transport = tokenValue(trimmed, "transport_id");
            if ("device".equals(device.state)) {
                Map<String, String> props = cliAdbProps(adbPath, device.serial);
                device.model = firstNonBlank(device.model, props.get("ro.product.model"), props.get("ro.product.vendor.model"));
                device.build = firstNonBlank(props.get("ro.build.version.incremental"), props.get("ro.vendor.build.version.incremental"));
                device.csc = firstNonBlank(props.get("ril.official_cscver"), props.get("ro.csc.sales_code"));
                device.android = firstNonBlank(props.get("ro.build.version.release"), props.get("ro.system.build.version.release"));
                device.status = "Ready";
            } else {
                device.status = "Not authorized/ready";
            }
            devices.add(device);
        }
        return devices;
    }

    private static Map<String, String> cliAdbProps(String adbPath, String serial) {
        CommandResult result = staticRunCommand(Arrays.asList(adbPath, "-s", serial, "shell", "getprop"), ROOT, null,
                Duration.ofSeconds(DEVICE_INFO_TIMEOUT_SECONDS));
        Map<String, String> props = new HashMap<>();
        Pattern pattern = Pattern.compile("^\\[(.+?)]\\s*:\\s*\\[(.*)]$");
        for (String line : result.output.split("\\R")) {
            Matcher matcher = pattern.matcher(line.trim());
            if (matcher.matches()) props.put(matcher.group(1), matcher.group(2));
        }
        return props;
    }

    private static CommandResult staticRunCommand(List<String> command, Path workDir, Map<String, String> env, Duration timeout) {
        try {
            ProcessBuilder builder = new ProcessBuilder(command);
            builder.directory(workDir.toFile());
            builder.redirectErrorStream(true);
            if (env != null) builder.environment().putAll(env);
            Process process = builder.start();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            Thread reader = new Thread(() -> {
                try (InputStream in = process.getInputStream()) {
                    in.transferTo(out);
                } catch (IOException ignored) {
                }
            });
            reader.start();
            if (!process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS)) {
                process.destroyForcibly();
                return new CommandResult(-1, out.toString(StandardCharsets.UTF_8) + "\nTimed out");
            }
            reader.join(1000);
            return new CommandResult(process.exitValue(), out.toString(StandardCharsets.UTF_8));
        } catch (Exception ex) {
            return new CommandResult(-1, ex.getMessage());
        }
    }

    private static ProcessOutcome cliRunLoggedProcess(List<String> command, Path workDir, Map<String, String> env,
                                                      Path logFile, Duration timeout) {
        Instant started = Instant.now();
        int exitCode = -1;
        boolean timedOut = false;
        try {
            staticCreateDirectories(logFile.getParent());
            ProcessBuilder builder = new ProcessBuilder(command);
            builder.directory(workDir.toFile());
            builder.redirectErrorStream(true);
            if (env != null) builder.environment().putAll(env);
            Process process = builder.start();
            cliRunningProcesses.add(process);
            String serial = env == null ? "" : env.getOrDefault("ATM_BATCH_SERIAL", "");
            String tool = env == null ? "" : env.getOrDefault("ATM_BATCH_TOOL", logFile.getFileName().toString().replaceFirst("\\.log$", ""));
            String prefix = serial.isBlank() ? "[" + tool + "] " : "[" + serial + "][" + tool + "] ";
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8));
                 BufferedWriter writer = Files.newBufferedWriter(logFile, StandardCharsets.UTF_8)) {
                ExecutorService pumpExecutor = Executors.newSingleThreadExecutor();
                Future<?> pump = pumpExecutor.submit(() -> {
                    try {
                        String line;
                        while ((line = reader.readLine()) != null) {
                            writer.write(line);
                            writer.newLine();
                            writer.flush();
                            String display = staticTrimLogLine(line);
                            if (!display.isEmpty()) {
                                System.out.println(prefix + display);
                                System.out.flush();
                            }
                        }
                    } catch (IOException ignored) {
                    }
                });
                long deadline = System.nanoTime() + timeout.toNanos();
                while (!cliCancelRequested && System.nanoTime() < deadline) {
                    if (process.waitFor(250, TimeUnit.MILLISECONDS)) break;
                }
                if (process.isAlive() && cliCancelRequested) {
                    process.destroy();
                    if (!process.waitFor(2, TimeUnit.SECONDS)) process.destroyForcibly();
                    System.err.println("Process cancelled: " + printable(command));
                } else if (process.isAlive()) {
                    timedOut = true;
                    process.destroyForcibly();
                    System.err.println("Process timed out: " + printable(command));
                }
                exitCode = process.waitFor();
                try { pump.get(2, TimeUnit.SECONDS); } catch (Exception ignored) {}
                pumpExecutor.shutdownNow();
            }
            cliRunningProcesses.remove(process);
        } catch (Exception ex) {
            System.err.println("Process failed: " + printable(command) + " :: " + ex.getMessage());
        }
        return new ProcessOutcome(exitCode, timedOut, Duration.between(started, Instant.now()).getSeconds());
    }

    private static void startCliCancelWatcher(String cancelFile) {
        if (cancelFile == null || cancelFile.isBlank()) return;
        Path path = Paths.get(cancelFile);
        Thread watcher = new Thread(() -> {
            while (!cliCancelRequested) {
                if (Files.exists(path)) {
                    cliCancelRequested = true;
                    synchronized (cliRunningProcesses) {
                        for (Process process : cliRunningProcesses) {
                            process.destroy();
                        }
                    }
                    System.out.println("[launcher] Cancel file detected: " + path);
                    return;
                }
                try {
                    Thread.sleep(250);
                } catch (InterruptedException ignored) {
                    return;
                }
            }
        }, "atm-cli-cancel-watcher");
        watcher.setDaemon(true);
        watcher.start();
    }

    private static Set<String> staticListThirdPartyPackages(String serial) {
        CommandResult result = staticRunCommand(Arrays.asList(cliAdbPath, "-s", serial, "shell", "pm", "list", "packages", "-3"),
                ROOT, null, Duration.ofSeconds(20));
        Set<String> packages = new LinkedHashSet<>();
        for (String line : result.output.split("\\R")) {
            String pkg = line.trim().replaceFirst("^package:", "");
            if (!pkg.isBlank()) packages.add(pkg);
        }
        return packages;
    }

    private static void staticCleanupInstalledPackages(String serial) {
        Set<String> before = cliInitialThirdPartyPackages.getOrDefault(serial, Set.of());
        Set<String> after = staticListThirdPartyPackages(serial);
        after.removeAll(before);
        if (after.isEmpty()) {
            System.out.println("[" + serial + "] Cleanup: no new APK packages found.");
            return;
        }
        for (String pkg : after) {
            CommandResult result = staticRunCommand(Arrays.asList(cliAdbPath, "-s", serial, "uninstall", pkg),
                    ROOT, null, Duration.ofSeconds(45));
            System.out.println("[" + serial + "] Cleanup uninstall " + pkg + " exit=" + result.exitCode);
        }
    }

    private static ResultSummary staticInspectResult(DeviceInfo device, ToolProfile tool, Instant startedAt, int exitCode) {
        try {
            List<Path> candidates = staticFindResultCandidates(device, tool, startedAt);
            if (candidates.isEmpty()) {
                if (tool == ToolProfile.SDT) {
                    if (exitCode == 0) {
                        return new ResultSummary("PASS", "exit=0 (SDT saved result externally)");
                    }
                    ResultSummary deviceResult = inspectDeviceSdtResult(cliAdbPath, device);
                    return deviceResult;
                }
                return new ResultSummary("NOTEXECUTED", "no fresh result file found");
            }
            Path latest = candidates.stream().max(Comparator.comparingLong(AtmBatchLauncher::staticLastModified)).orElse(candidates.get(0));
            if (tool == ToolProfile.BVT) return staticParseBvtResult(latest);
            return new ResultSummary("PASS", latest.toString());
        } catch (Exception ex) {
            return new ResultSummary("ERROR", ex.getMessage());
        }
    }

    private static List<Path> staticFindResultCandidates(DeviceInfo device, ToolProfile tool, Instant startedAt) throws IOException {
        List<Path> all;
        List<Path> roots = resultSearchRoots(tool);
        all = new ArrayList<>();
        for (Path root : roots) {
            if (!Files.exists(root)) continue;
            try (var stream = Files.walk(root, resultSearchDepth(tool))) {
                all.addAll(stream.filter(Files::isRegularFile)
                        .filter(p -> isResultFileName(tool, p.getFileName().toString()))
                        .filter(p -> tool == ToolProfile.SDT || modifiedAtOrAfter(p, startedAt))
                        .collect(Collectors.toList()));
            }
        }
        String model = nullToEmpty(device.model);
        String build = nullToEmpty(device.build);
        List<Path> preferred = all.stream()
                .filter(p -> (!model.isBlank() && p.toString().contains(model))
                        || p.toString().contains(device.serial)
                        || (!build.isBlank() && p.toString().contains(build)))
                .collect(Collectors.toList());
        return preferred.isEmpty() ? all : preferred;
    }

    private static ResultSummary staticParseBvtResult(Path xml) throws IOException {
        String text = Files.readString(xml, StandardCharsets.UTF_8);
        int failed = intAttr(text, "failed", -1);
        int pass = intAttr(text, "pass", -1);
        int modulesDone = intAttr(text, "modules_done", -1);
        int modulesTotal = intAttr(text, "modules_total", -1);
        if (failed > 0 && failed <= 2) return new ResultSummary("WARNING", "failed=" + failed + " pass=" + pass + " file=" + xml);
        if (failed > 2) return new ResultSummary("FAIL", "failed=" + failed + " pass=" + pass + " file=" + xml);
        if (modulesTotal > 0 && modulesDone >= 0 && modulesDone < modulesTotal) {
            return new ResultSummary("INCOMPLETE", "modules=" + modulesDone + "/" + modulesTotal + " file=" + xml);
        }
        if (pass <= 0 && failed == 0) return new ResultSummary("INCOMPLETE", "pass=0 file=" + xml);
        return new ResultSummary("PASS", "pass=" + pass + " file=" + xml);
    }

    private static Map<String, String> parseArgs(String[] args) {
        Map<String, String> parsed = new LinkedHashMap<>();
        for (int i = 0; i < args.length; i++) {
            String arg = args[i];
            if (!arg.startsWith("--")) continue;
            String key = arg.substring(2).toLowerCase(Locale.ROOT);
            String value = "true";
            if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
                value = args[++i];
            }
            parsed.put(key, value);
        }
        return parsed;
    }

    private static List<ToolProfile> parseTools(String value) {
        List<ToolProfile> tools = new ArrayList<>();
        for (String raw : value.split(",")) {
            String name = raw.trim().toUpperCase(Locale.ROOT);
            if (name.isBlank()) continue;
            if ("CSCHECKER".equals(name) || "CSCCHECKER".equals(name)) name = "CSCHECKER";
            for (ToolProfile tool : ToolProfile.values()) {
                if (tool.enabled && (tool.name().equals(name) || tool.displayName.equalsIgnoreCase(raw.trim()))) {
                    tools.add(tool);
                }
            }
        }
        return tools;
    }

    private static List<DeviceInfo> selectDevices(List<DeviceInfo> discovered, String selector) {
        if ("all".equalsIgnoreCase(selector)) return discovered;
        if ("first".equalsIgnoreCase(selector)) {
            return discovered.isEmpty() ? List.of() : List.of(discovered.get(0));
        }
        Set<String> wanted = Arrays.stream(selector.split(","))
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .collect(Collectors.toCollection(LinkedHashSet::new));
        return discovered.stream().filter(d -> wanted.contains(d.serial)).collect(Collectors.toList());
    }

    private static int parseInt(String value, int fallback) {
        try {
            return Integer.parseInt(value);
        } catch (Exception ignored) {
            return fallback;
        }
    }

    private static void staticCreateDirectories(Path path) {
        try {
            Files.createDirectories(path);
        } catch (IOException ex) {
            throw new IllegalStateException("Cannot create " + path + ": " + ex.getMessage(), ex);
        }
    }

    private static long staticLastModified(Path path) {
        try {
            return Files.getLastModifiedTime(path).toMillis();
        } catch (IOException ex) {
            return 0;
        }
    }

    private static String staticTrimLogLine(String line) {
        return line == null ? "" : line.trim();
    }

    private static String limit(String value, int max) {
        String safe = value == null ? "" : value;
        return safe.length() <= max ? safe : safe.substring(0, Math.max(0, max - 1)) + ".";
    }

    private static String tokenValue(String line, String key) {
        Matcher matcher = Pattern.compile("\\b" + Pattern.quote(key) + ":([^\\s]+)").matcher(line);
        return matcher.find() ? matcher.group(1) : "";
    }

    private static String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) return value.trim();
        }
        return "";
    }

    private static String nullToEmpty(String value) {
        return value == null ? "" : value;
    }

    private static List<Path> resultSearchRoots(ToolProfile tool) {
        List<Path> roots = new ArrayList<>();
        roots.add(ROOT.resolve("results"));
        if (tool == ToolProfile.BVT) roots.add(ROOT.resolve("tools").resolve("resource").resolve("BVT"));
        return roots;
    }

    private static int resultSearchDepth(ToolProfile tool) {
        return tool == ToolProfile.BVT ? 12 : 8;
    }

    private static boolean isResultFileName(ToolProfile tool, String fileName) {
        String lowerName = fileName.toLowerCase(Locale.ROOT);
        if (tool == ToolProfile.GETPROP) {
            return fileName.startsWith("Getprop_");
        }
        if (tool == ToolProfile.BVT) {
            return fileName.equalsIgnoreCase(tool.resultFileName) || fileName.equalsIgnoreCase("test_result.xml");
        }
        if (tool == ToolProfile.SVT) {
            return fileName.equalsIgnoreCase(tool.resultFileName)
                    || (lowerName.endsWith(".xml") && lowerName.contains("result"));
        }
        if (tool == ToolProfile.SDT) {
            return (lowerName.startsWith("sdtresults_") && lowerName.endsWith(".zip"))
                    || lowerName.endsWith("_sdt.xml")
                    || fileName.equalsIgnoreCase(tool.resultFileName);
        }
        return fileName.equalsIgnoreCase(tool.resultFileName);
    }

    private static ResultSummary inspectDeviceSdtResult(String adbPath, DeviceInfo device) {
        if (!deviceSdtResultExists(adbPath, device.serial)) {
            return new ResultSummary("NOTEXECUTED", "no fresh local result and no /sdcard/SDTResults.zip on device");
        }
        Path destination = sdtPullDestination(device);
        try {
            Files.createDirectories(destination.getParent());
        } catch (IOException ex) {
            return new ResultSummary("PASS", "device file exists: /sdcard/SDTResults.zip; local folder error: " + ex.getMessage());
        }
        CommandResult pull = staticRunCommand(Arrays.asList(adbPath, "-s", device.serial, "pull",
                        "/sdcard/SDTResults.zip", destination.toString()),
                ROOT, null, Duration.ofMinutes(2));
        if (pull.exitCode == 0 && Files.isRegularFile(destination)) {
            return new ResultSummary("PASS", "pulled device result to " + destination);
        }
        return new ResultSummary("PASS", "device file exists: /sdcard/SDTResults.zip; pull exit=" + pull.exitCode);
    }

    private static Path sdtPullDestination(DeviceInfo device) {
        String model = firstNonBlank(device.model, device.serial, "unknown-model");
        String build = firstNonBlank(device.build, "unknown-build");
        String csc = firstNonBlank(device.csc, "UNKNOWN");
        return ROOT.resolve("results")
                .resolve(safeName(model))
                .resolve(safeName(build))
                .resolve("SDT")
                .resolve("SDTResults_" + safeName(csc) + ".zip");
    }

    private static boolean deviceSdtResultExists(String adbPath, String serial) {
        CommandResult result = staticRunCommand(Arrays.asList(adbPath, "-s", serial, "shell", "ls", "/sdcard/SDTResults.zip"),
                ROOT, null, Duration.ofSeconds(10));
        return result.exitCode == 0 && result.output.contains("SDTResults.zip");
    }

    private static boolean modifiedAtOrAfter(Path path, Instant startedAt) {
        if (startedAt == null) return true;
        try {
            return !Files.getLastModifiedTime(path).toInstant().isBefore(startedAt.minusSeconds(2));
        } catch (IOException ex) {
            return false;
        }
    }

    private static boolean isSuccessfulStatus(String status) {
        return "PASS".equalsIgnoreCase(status) || "WARNING".equalsIgnoreCase(status);
    }

    private static String processFailureDetail(ProcessOutcome outcome, ResultSummary inspected) {
        String reason = outcome.timedOut ? "tool timed out" : "tool exit=" + outcome.exitCode;
        if (inspected == null || inspected.detail == null || inspected.detail.isBlank()) return reason;
        return reason + "; " + inspected.status + " " + inspected.detail;
    }

    private static String checkFile(String label, Path path) {
        return (Files.isRegularFile(path) ? "OK   " : "FAIL ") + label + ": " + path;
    }

    private static String checkDir(String label, Path path) {
        return (Files.isDirectory(path) ? "OK   " : "FAIL ") + label + ": " + path;
    }

    private static String checkExecutable(String label, String executable) {
        return "OK   " + label + ": " + executable;
    }

    private static String timestamp() {
        return new SimpleDateFormat("yyyyMMdd-HHmmss").format(new Date());
    }

    private static String safeName(String value) {
        return value.replaceAll("[^A-Za-z0-9._-]", "_");
    }

    private static Path toolResultDir(DeviceInfo device, String folderName) {
        String model = firstNonBlank(device.model, device.serial, "unknown-model");
        String build = firstNonBlank(device.build, "unknown-build");
        return ROOT.resolve("results").resolve(safeName(model)).resolve(safeName(build)).resolve(folderName);
    }

    private static String printable(List<String> command) {
        return command.stream().map(AtmBatchLauncher::quoteIfNeeded).collect(Collectors.joining(" "));
    }

    private static String quoteIfNeeded(String value) {
        if (value == null) return "";
        if (value.contains(" ") || value.contains("\t")) return '"' + value.replace("\"", "\\\"") + '"';
        return value;
    }

    private String trimLogLine(String line) {
        return line == null ? "" : line.trim();
    }

    private long lastModified(Path path) {
        try {
            return Files.getLastModifiedTime(path).toMillis();
        } catch (IOException ex) {
            return 0;
        }
    }

    private static int intAttr(String text, String attr, int fallback) {
        Matcher matcher = Pattern.compile("\\b" + Pattern.quote(attr) + "=\"(\\d+)\"").matcher(text);
        return matcher.find() ? Integer.parseInt(matcher.group(1)) : fallback;
    }

    private static List<BvtSubtest> bvtSubtestsFromSummary(ResultSummary summary) {
        if (summary == null || summary.detail == null) return List.of();
        Matcher matcher = Pattern.compile("\\bfile=(.+)$").matcher(summary.detail);
        if (!matcher.find()) return List.of();
        Path xml = Paths.get(matcher.group(1).trim());
        if (!Files.isRegularFile(xml)) return List.of();
        try {
            return parseBvtSubtests(xml);
        } catch (Exception ignored) {
            return List.of();
        }
    }

    private static Optional<BvtSummary> bvtSummaryFromSummary(ResultSummary summary) {
        if (summary == null || summary.detail == null) return Optional.empty();
        int pass = tokenInt(summary.detail, "pass", -1);
        int failed = tokenInt(summary.detail, "failed", -1);
        int total = tokenInt(summary.detail, "total", -1);
        Matcher matcher = Pattern.compile("\\bfile=(.+)$").matcher(summary.detail);
        if (matcher.find()) {
            Path xml = Paths.get(matcher.group(1).trim());
            if (Files.isRegularFile(xml)) {
                try {
                    String text = Files.readString(xml, StandardCharsets.UTF_8);
                    pass = intAttr(text, "pass", pass);
                    failed = intAttr(text, "failed", failed);
                    total = pass >= 0 && failed >= 0 ? pass + failed : total;
                } catch (IOException ignored) {
                }
            }
        }
        if (total < 0 && pass >= 0 && failed >= 0) total = pass + failed;
        if (pass < 0 && failed < 0 && total < 0) return Optional.empty();
        return Optional.of(new BvtSummary(Math.max(total, 0), Math.max(pass, 0), Math.max(failed, 0)));
    }

    private static List<BvtSubtest> parseBvtSubtests(Path xml) throws IOException {
        String text = Files.readString(xml, StandardCharsets.UTF_8);
        List<BvtSubtest> subtests = new ArrayList<>();
        Pattern modulePattern = Pattern.compile("<Module\\b([^>]*)>(.*?)</Module>", Pattern.DOTALL);
        Matcher moduleMatcher = modulePattern.matcher(text);
        while (moduleMatcher.find()) {
            String module = xmlAttr(moduleMatcher.group(1), "name");
            collectBvtSubtests(moduleMatcher.group(2), module, subtests);
        }
        if (subtests.isEmpty()) {
            collectBvtSubtests(text, "", subtests);
        }
        return subtests;
    }

    private static void collectBvtSubtests(String text, String module, List<BvtSubtest> subtests) {
        Pattern casePattern = Pattern.compile("<TestCase\\b([^>]*)>(.*?)</TestCase>", Pattern.DOTALL);
        Matcher caseMatcher = casePattern.matcher(text);
        while (caseMatcher.find()) {
            String testCase = xmlAttr(caseMatcher.group(1), "name");
            collectBvtTests(caseMatcher.group(2), module, testCase, subtests);
        }
        if (subtests.isEmpty()) {
            collectBvtTests(text, module, "", subtests);
        }
    }

    private static void collectBvtTests(String text, String module, String testCase, List<BvtSubtest> subtests) {
        Pattern testPattern = Pattern.compile("<Test\\b([^>]*)/?>", Pattern.DOTALL);
        Matcher testMatcher = testPattern.matcher(text);
        while (testMatcher.find()) {
            String attrs = testMatcher.group(1);
            String name = xmlAttr(attrs, "name");
            String result = xmlAttr(attrs, "result");
            if (name.isBlank() || result.isBlank()) continue;
            List<String> parts = new ArrayList<>();
            if (!module.isBlank()) parts.add(module);
            if (!testCase.isBlank()) parts.add(testCase);
            parts.add(name);
            subtests.add(new BvtSubtest(String.join(".", parts), normalizeBvtSubtestStatus(result)));
        }
    }

    private static String normalizeBvtSubtestStatus(String result) {
        String lower = result.toLowerCase(Locale.ROOT);
        if ("pass".equals(lower)) return "PASS";
        if ("fail".equals(lower)) return "FAIL";
        if ("timeout".equals(lower)) return "TIMEOUT";
        return "NOTEXECUTED";
    }

    private static String xmlAttr(String attrs, String name) {
        Matcher matcher = Pattern.compile("\\b" + Pattern.quote(name) + "=\"([^\"]*)\"").matcher(attrs);
        if (!matcher.find()) return "";
        return matcher.group(1)
                .replace("&quot;", "\"")
                .replace("&apos;", "'")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&amp;", "&")
                .replace('\t', ' ')
                .replace('\n', ' ')
                .replace('\r', ' ')
                .trim();
    }

    private static int tokenInt(String text, String key, int fallback) {
        Matcher matcher = Pattern.compile("\\b" + Pattern.quote(key) + "=(\\d+)").matcher(text);
        return matcher.find() ? Integer.parseInt(matcher.group(1)) : fallback;
    }

    private static final class DeviceInfo {
        boolean selected;
        String serial = "";
        String state = "";
        String model = "";
        String product = "";
        String transport = "";
        String build = "";
        String csc = "";
        String android = "";
        String status = "";
        String lastResult = "";
    }

    private static final class DeviceTableModel extends AbstractTableModel {
        private final String[] columns = {"Run", "Serial", "State", "Model", "Android", "Build", "CSC", "Status", "Last Result"};
        private List<DeviceInfo> devices = new ArrayList<>();
        Runnable onChange;

        void setDevices(List<DeviceInfo> devices) {
            this.devices = devices;
            fireTableDataChanged();
            if (onChange != null) onChange.run();
        }

        @Override public int getRowCount() { return devices.size(); }
        @Override public int getColumnCount() { return columns.length; }
        @Override public String getColumnName(int column) { return columns[column]; }
        @Override public Class<?> getColumnClass(int columnIndex) { return columnIndex == 0 ? Boolean.class : String.class; }
        @Override public boolean isCellEditable(int rowIndex, int columnIndex) {
            return columnIndex == 0 && "device".equals(devices.get(rowIndex).state);
        }
        @Override public Object getValueAt(int rowIndex, int columnIndex) {
            DeviceInfo d = devices.get(rowIndex);
            return switch (columnIndex) {
                case 0 -> d.selected;
                case 1 -> d.serial;
                case 2 -> d.state;
                case 3 -> d.model;
                case 4 -> d.android;
                case 5 -> d.build;
                case 6 -> d.csc;
                case 7 -> d.status;
                case 8 -> d.lastResult;
                default -> "";
            };
        }
        @Override public void setValueAt(Object aValue, int rowIndex, int columnIndex) {
            if (columnIndex == 0) {
                devices.get(rowIndex).selected = Boolean.TRUE.equals(aValue);
                fireTableRowsUpdated(rowIndex, rowIndex);
                if (onChange != null) onChange.run();
            }
        }
    }

    private enum ToolProfile {
        GETPROP("Getprop", "Getprop.jar", "Getprop/Getprop_XID.txt", true, true,
                "Runs Getprop silent mode; ANDROID_SERIAL is set for device isolation."),
        BVT("BVT", "BVT.jar", "BVT/bvt_result.xml", true, false,
                "Runs BVT via cts-tradefed resource; ANDROID_SERIAL is set for device isolation."),
        SVT("SVT", "SVT.jar", "SVT/svt_result.xml", true, false,
                "Runs SVT silent mode with -s <serial> and output folder."),
        SDT("SDT", "SDT.jar", "SDT/SDTResults_", true, false,
                "Runs SDT --silent; ANDROID_SERIAL is set for device isolation."),
        FMDUT("FMDUT", "FMDUT.jar", "FMDUT/result.xml", false, false,
                "Detected but disabled until silent CLI is validated."),
        CSCHECKER("CSCChecker", "CSCChecker.jar", "CSCChecker/testResult.xml", false, false,
                "Detected but disabled until JavaFX silent CLI is validated."),
        ATMOCTOPUS("AtmOctopus", "AtmOctopus.jar", "AtmOctopus/result.xml", false, false,
                "Detected but disabled because manifest has no launcher main class.");

        final String displayName;
        final String jarPath;
        final String resultFileName;
        final boolean enabled;
        final boolean defaultSelected;
        final String description;

        ToolProfile(String displayName, String jarName, String resultFileName, boolean enabled, boolean defaultSelected, String description) {
            this.displayName = displayName;
            this.jarPath = "tools/" + jarName;
            this.resultFileName = Paths.get(resultFileName).getFileName().toString();
            this.enabled = enabled;
            this.defaultSelected = defaultSelected;
            this.description = description;
        }

        List<String> command(DeviceInfo device, Path runDir) {
            String jar = Paths.get(jarPath).getFileName().toString();
            return switch (this) {
                case GETPROP -> Arrays.asList(JAVA_BIN, "-jar", jar, "silent");
                case BVT -> Arrays.asList(JAVA_BIN, "-jar", jar, device.serial);
                case SVT -> Arrays.asList(JAVA_BIN, "-jar", jar, "--silent", "-s", device.serial, "-o", toolResultDir(device, "SVT").toString());
                case SDT -> Arrays.asList(JAVA_BIN, "-jar", jar, "--silent");
                default -> Arrays.asList(JAVA_BIN, "-jar", jar);
            };
        }
    }

    private record CommandResult(int exitCode, String output) {}
    private record ProcessOutcome(int exitCode, boolean timedOut, long durationSeconds) {}
    private record ResultSummary(String status, String detail) {}
    private record BvtSubtest(String name, String status) {
        boolean isFailed() {
            return "FAIL".equalsIgnoreCase(status) || "TIMEOUT".equalsIgnoreCase(status);
        }
    }
    private record BvtSummary(int total, int pass, int failed) {}
}
