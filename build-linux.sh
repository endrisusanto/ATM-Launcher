#!/bin/bash

echo "Memulai proses build untuk DEB dan RPM..."

# Pastikan berada di direktori project yang benar
cd "$(dirname "$0")"

# Menjalankan perintah build
npm run build:linux

echo "Proses build selesai!"
echo "File hasil build dapat ditemukan di direktori:"
echo "- src-tauri/target/release/bundle/deb/"
echo "- src-tauri/target/release/bundle/rpm/"
