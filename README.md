# ATM Tauri Launcher

Desktop UI baru untuk ATM Batch Runner dengan tampilan gelap seperti dashboard CTS automation.

## Run Dev

```bash
cd atm-tauri-launcher
npm install
npm run dev
```

Tauri tetap membutuhkan desktop display. Untuk environment headless, pakai CLI fallback:

```bash
java atm-batch-launcher/AtmBatchLauncher.java --list-devices
java atm-batch-launcher/AtmBatchLauncher.java --run --tools getprop --devices first
```

## Linux Wayland Notes

`start_ATM_TauriLauncher.sh` menjalankan Tauri dengan `WEBKIT_DISABLE_COMPOSITING_MODE=1` dan `GDK_BACKEND=x11` agar WebKitGTK memakai XWayland. Ini menghindari crash seperti:

```text
Gdk-Message: Error 71 (Protocol error) dispatching to Wayland display.
```

Pesan `Failed to load module "appmenu-gtk-module"` biasanya hanya warning dari environment GTK. Script launcher akan menghapus `GTK_MODULES` jika berisi module tersebut.

## UI Layout

- Sidebar kiri: device cards dengan model, serial, Android, SPL, PDA, modem, CSC.
- Tengah: toolbar dan testcase/result cards per device.
- Kanan: summarize metrics dan running log.
- Backend: Tauri/Rust memanggil ADB untuk device discovery dan CLI Java runner untuk batch execution.

## Build

```bash
cd atm-tauri-launcher
npm install
npm run build
```

Jika build Tauri gagal karena dependency Linux WebKit belum ada, install paket WebKitGTK sesuai distro terlebih dahulu.

## Release

Push tag `v*` akan menjalankan GitHub Actions release build. Helper script berikut akan stage perubahan, commit jika ada perubahan, menaikkan versi tag, push branch, lalu push tag:

```bash
scripts/release-next.sh patch "Fix BVT crash NumberFormatException and SDT false NOTEXECUTED"
```

Gunakan `minor` atau `major` sebagai argumen pertama jika ingin menaikkan versi selain patch.
