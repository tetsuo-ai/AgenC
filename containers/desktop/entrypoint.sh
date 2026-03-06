#!/usr/bin/env bash
set -euo pipefail

AGENC_USER="agenc"
HOME_DIR="/home/agenc"
SERVER_DIR="/opt/server"

remap_group() {
  local target_gid="$1"
  local current_gid
  current_gid="$(id -g "${AGENC_USER}")"
  if [[ "${target_gid}" == "${current_gid}" ]]; then
    return
  fi

  groupmod -o -g "${target_gid}" "${AGENC_USER}"
}

remap_user() {
  local target_uid="$1"
  local current_uid
  current_uid="$(id -u "${AGENC_USER}")"
  if [[ "${target_uid}" == "${current_uid}" ]]; then
    return
  fi

  usermod -o -u "${target_uid}" "${AGENC_USER}"
}

target_uid="${AGENC_HOST_UID:-}"
target_gid="${AGENC_HOST_GID:-}"

if [[ -n "${target_gid}" && "${target_gid}" =~ ^[0-9]+$ ]]; then
  remap_group "${target_gid}"
fi

if [[ -n "${target_uid}" && "${target_uid}" =~ ^[0-9]+$ ]]; then
  remap_user "${target_uid}"
fi

chown -R "${AGENC_USER}:${AGENC_USER}" "${HOME_DIR}" /tmp "${SERVER_DIR}"

exec /usr/bin/sudo -E -u "${AGENC_USER}" "$@"
