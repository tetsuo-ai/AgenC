#!/usr/bin/env bash
set -euo pipefail

manifest_path="${1:-}"
install_dir="${2:-/usr/local/bin}"

if [[ -z "${manifest_path}" ]]; then
  echo "install-secure-path-launchers: missing manifest path" >&2
  exit 1
fi

if [[ ! -f "${manifest_path}" ]]; then
  echo "install-secure-path-launchers: manifest not found: ${manifest_path}" >&2
  exit 1
fi

install -d -m 0755 "${install_dir}"

while read -r target_name source_path extra; do
  if [[ -z "${target_name}" || "${target_name}" == \#* ]]; then
    continue
  fi

  if [[ -n "${extra:-}" ]]; then
    echo "install-secure-path-launchers: invalid manifest line for ${target_name}" >&2
    exit 1
  fi

  if [[ ! "${target_name}" =~ ^[A-Za-z0-9._+-]+$ ]]; then
    echo "install-secure-path-launchers: invalid target name: ${target_name}" >&2
    exit 1
  fi

  if [[ "${source_path}" != /* ]]; then
    echo "install-secure-path-launchers: source path must be absolute for ${target_name}" >&2
    exit 1
  fi

  if [[ ! -e "${source_path}" ]]; then
    echo "install-secure-path-launchers: source missing for ${target_name}: ${source_path}" >&2
    exit 1
  fi

  ln -sf "${source_path}" "${install_dir}/${target_name}"
done < "${manifest_path}"
