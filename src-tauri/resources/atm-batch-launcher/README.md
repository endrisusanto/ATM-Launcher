# ATM Batch Launcher

Desktop launcher untuk menjalankan tool ATM secara batch ke multiple Android devices.

## Run

Linux:

```bash
bash atm-batch-launcher/run-launcher.sh
```

Windows:

```bat
atm-batch-launcher\run-launcher.bat
```

Launcher ini menggunakan Java single-source mode, jadi tidak perlu `javac`, Maven, atau Gradle. Jalankan dari root paket ATM agar path `ATM_v5.jar`, `AtmAgent.jar`, `tools/`, dan `results/` tetap sesuai.

## Display Requirement

Launcher ini adalah desktop app Swing, jadi harus dijalankan dari sesi desktop yang punya display.

Jika muncul error seperti:

```text
java.awt.HeadlessException: No X11 DISPLAY variable was set
```

berarti terminal saat ini tidak punya akses ke GUI. Jalankan dari terminal desktop Linux langsung, atau aktifkan X11 forwarding / WSL X server jika berjalan lewat SSH/WSL.

Headless preflight:

```bash
java atm-batch-launcher/AtmBatchLauncher.java --preflight
```

List devices tanpa GUI:

```bash
java atm-batch-launcher/AtmBatchLauncher.java --list-devices
```

Run batch tanpa GUI:

```bash
java atm-batch-launcher/AtmBatchLauncher.java --run --tools getprop --devices first
```

Contoh sequence ke semua device authorized dengan 2 device paralel:

```bash
java atm-batch-launcher/AtmBatchLauncher.java --run --tools getprop,bvt --devices all --concurrency 2
```

Opsi CLI:

- `--tools getprop,bvt,svt,sdt`
- `--devices first`, `--devices all`, atau `--devices SERIAL1,SERIAL2`
- `--concurrency 1`
- `--update` untuk menjalankan `AtmAgent.jar` sebelum batch
- `--adb /path/to/adb` untuk custom ADB path

## Behavior

- Refresh device memakai `adb devices -l`.
- Device info diambil dengan `adb -s <serial> shell getprop`.
- Test berjalan sequence per device.
- Multiple device berjalan paralel sesuai nilai `Parallel devices`.
- Log proses disimpan di `atm-batch-launcher/runs/<timestamp>/<serial>/`.
- Hasil utama tetap dibaca dari folder existing `results/`, hanya dari file yang dibuat/diubah setelah tool mulai berjalan agar file lama tidak dihitung sebagai hasil run baru.
- BVT juga membaca result native CTS dari `tools/resource/BVT/<android-version>/android-cts/results/<timestamp>/test_result.xml` jika wrapper belum menyalin ke `results/<model>/<build>/BVT/bvt_result.xml`.
- Khusus BVT, launcher mengeluarkan baris `BVT_SUBTEST` untuk setiap subtest yang ditemukan di XML result agar UI Tauri bisa menampilkan status subtest. Jika jumlah failed BVT maksimal 2, status akhir dianggap `WARNING`; lebih dari 2 tetap `FAIL`.
- SDT di device/MTP memakai `/sdcard/SDTResults.zip`; setelah dipull ke PC tool menyimpan sebagai `SDTResults_XID.zip` dan mengekstrak `XID_SDT.xml`. Launcher mengenali dua bentuk lokal itu. Khusus SDT, file lokal terbaru tetap diterima walau timestamp-nya lebih lama dari start launcher, dan jika file lokal belum ketemu launcher mengecek sekaligus mencoba pull `/sdcard/SDTResults.zip` dari device.

## Enabled Tools

- `Getprop`: `java -jar Getprop.jar silent`, dengan `ANDROID_SERIAL` diset.
- `BVT`: `java -jar BVT.jar <serial>`. Wrapper BVT memilih resource CTS dari `tools/resource/BVT/<android-version>/android-cts` berdasarkan SDK device.
- `SVT`: `java -jar SVT.jar --silent -s <serial> -o <run-dir>/SVT`.
- `SDT`: `java -jar SDT.jar --silent`, dengan `ANDROID_SERIAL` diset. Device result: `/sdcard/SDTResults.zip`; PC result: `SDTResults_XID.zip` atau `XID_SDT.xml`. Jika proses SDT selesai `exit=0` tetapi launcher belum menemukan file result lokal, run tetap dianggap `PASS` karena SDT dapat menyimpan hasilnya di folder `results`/MTP secara eksternal.

`FMDUT`, `CSCChecker`, dan `AtmOctopus` ditampilkan sebagai detected-only karena command-line silent mode belum cukup aman untuk batch otomatis.
