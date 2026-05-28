#!/bin/bash
set -euo pipefail

echo "Memulai proses build untuk DEB dan RPM..."

cd "$(dirname "$0")"

npm run build:linux

echo "Proses build selesai."

DEB_DIR="src-tauri/target/release/bundle/deb"
RPM_DIR="src-tauri/target/release/bundle/rpm"

latest_package() {
  local dir="$1"
  local pattern="$2"
  find "$dir" -maxdepth 1 -type f -name "$pattern" -printf '%T@ %p\n' 2>/dev/null \
    | sort -nr \
    | awk 'NR == 1 { sub(/^[^ ]+ /, ""); print }'
}

detect_linux_family() {
  if [ ! -r /etc/os-release ]; then
    echo "unknown"
    return
  fi

  # shellcheck disable=SC1091
  . /etc/os-release
  local ids="${ID:-} ${ID_LIKE:-}"

  case " $ids " in
    *" debian "*|*" ubuntu "*|*" linuxmint "*|*" pop "*)
      echo "deb"
      ;;
    *" fedora "*|*" rhel "*|*" centos "*|*" rocky "*|*" almalinux "*)
      echo "rpm"
      ;;
    *)
      echo "unknown"
      ;;
  esac
}

install_deb() {
  local package="$1"
  echo "Distro Debian/Ubuntu terdeteksi. Menginstall:"
  echo "$package"

  if command -v apt >/dev/null 2>&1; then
    sudo apt install -y "./$package"
  else
    sudo dpkg -i "$package" || sudo apt-get install -f -y
  fi
}

install_rpm() {
  local package="$1"
  echo "Distro Fedora/RHEL terdeteksi. Menginstall:"
  echo "$package"

  if command -v dnf >/dev/null 2>&1; then
    sudo dnf reinstall -y "$package" || sudo dnf install -y "$package"
  elif command -v yum >/dev/null 2>&1; then
    sudo yum reinstall -y "$package" || sudo yum install -y "$package"
  else
    sudo rpm -Uvh --replacepkgs --replacefiles "$package"
  fi
}

family="$(detect_linux_family)"

case "$family" in
  deb)
    package="$(latest_package "$DEB_DIR" "*.deb")"
    if [ -z "$package" ]; then
      echo "File .deb tidak ditemukan di $DEB_DIR"
      exit 1
    fi
    install_deb "$package"
    ;;
  rpm)
    package="$(latest_package "$RPM_DIR" "*.rpm")"
    if [ -z "$package" ]; then
      echo "File .rpm tidak ditemukan di $RPM_DIR"
      exit 1
    fi
    install_rpm "$package"
    ;;
  *)
    echo "Distro belum dikenali. Install manual dari:"
    echo "- $DEB_DIR/"
    echo "- $RPM_DIR/"
    exit 1
    ;;
esac

echo "Install selesai."
