#!/usr/bin/env bash

set -euo pipefail
umask 077

SOURCE_REPO="${GEAR_SOURCE_REPO:-/home/minamorl/repos/gear-ts}"
DEPLOY_ROOT="${GEAR_DEPLOY_ROOT:-/home/minamorl/deploy/gear}"
RELEASES_DIR="${DEPLOY_ROOT}/releases"
CURRENT_LINK="${DEPLOY_ROOT}/current"
STATE_DIR="${DEPLOY_ROOT}/shared"
FIFO_PATH="${STATE_DIR}/intake"
ENV_FILE="${SOURCE_REPO}/.env"
SERVICE_NAME="gear-host.service"
DEPLOY_REF="${1:-${GEAR_DEPLOY_REF:-origin/main}}"
KEEP_RELEASES="${GEAR_KEEP_RELEASES:-3}"
PNPM_BIN="/usr/bin/pnpm"
NODE_BIN="/usr/bin/node"
READY_ARTIFACT="dist/bin/host.js"
READY_MARKER=".gear-release-ready"
HEALTH_ATTEMPTS=40
HEALTH_INTERVAL_SECONDS=1

STAGING_DIR=""
NEXT_LINK=""
ROLLBACK_LINK=""

# package.json scripts invoke `pnpm`; keep them on the measured, Node-20-safe
# system binary rather than the incompatible user-level pnpm found on Vultr.
export PATH="/usr/bin:/bin:${PATH:-}"

fail() {
  echo "[deploy-gear] FATAL: $*" >&2
  exit 1
}

cleanup() {
  if [ -n "${STAGING_DIR}" ] && [ -d "${STAGING_DIR}" ]; then
    rm -rf -- "${STAGING_DIR}"
  fi
  if [ -n "${NEXT_LINK}" ] && [ -L "${NEXT_LINK}" ]; then
    rm -f -- "${NEXT_LINK}"
  fi
  if [ -n "${ROLLBACK_LINK}" ] && [ -L "${ROLLBACK_LINK}" ]; then
    rm -f -- "${ROLLBACK_LINK}"
  fi
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

is_sha() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]]
}

require_safe_absolute_path() {
  local label="$1"
  local path="$2"
  case "${path}" in
    /*) ;;
    *) fail "${label} must be an absolute path: ${path}" ;;
  esac
  [ "${path}" != "/" ] || fail "${label} must not be /"
}

release_is_ready() {
  local release_dir="$1"
  local expected_sha="$2"
  local revision

  [ -d "${release_dir}" ] && [ ! -L "${release_dir}" ] || return 1
  [ -f "${release_dir}/REVISION" ] && [ ! -L "${release_dir}/REVISION" ] || return 1
  [ -f "${release_dir}/${READY_MARKER}" ] \
    && [ ! -L "${release_dir}/${READY_MARKER}" ] || return 1
  [ -f "${release_dir}/${READY_ARTIFACT}" ] \
    && [ ! -L "${release_dir}/${READY_ARTIFACT}" ] || return 1
  [ -L "${release_dir}/.env" ] || return 1
  [ "$(readlink -- "${release_dir}/.env")" = "${ENV_FILE}" ] || return 1
  revision="$(cat -- "${release_dir}/REVISION")"
  [ "${revision}" = "${expected_sha}" ]
}

require_service_workdir() {
  local unit="$1"
  local expected="$2"
  local actual

  actual="$(systemctl --user show --property=WorkingDirectory --value "${unit}")"
  [ "${actual}" = "${expected}" ] \
    || fail "${unit} runs from ${actual:-<unset>}; expected ${expected}"
}

services_are_healthy() {
  systemctl --user is-active --quiet "${SERVICE_NAME}" \
    && test -p "${FIFO_PATH}"
}

wait_for_health() {
  local attempt
  for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt++)); do
    if services_are_healthy; then
      return 0
    fi
    sleep "${HEALTH_INTERVAL_SECONDS}"
  done
  return 1
}

prune_old_releases() {
  local entry name timestamp
  local kept=0
  local -a ordered=()

  while IFS=' ' read -r timestamp name; do
    [ -n "${timestamp}" ] && [ -n "${name}" ] || continue
    ordered+=("${name}")
  done < <(
    shopt -s nullglob
    for entry in "${RELEASES_DIR}"/*; do
      [ -d "${entry}" ] && [ ! -L "${entry}" ] || continue
      name="${entry##*/}"
      is_sha "${name}" || continue
      release_is_ready "${entry}" "${name}" || continue
      printf '%s %s\n' "$(stat -c '%Y' -- "${entry}")" "${name}"
    done | LC_ALL=C sort -k1,1nr -k2,2
  )

  for name in "${ordered[@]}"; do
    if [ "${kept}" -lt "${KEEP_RELEASES}" ]; then
      kept=$((kept + 1))
      continue
    fi
    [ "${name}" != "${TARGET_COMMIT}" ] || continue
    [ -z "${OLD_SHA}" ] || [ "${name}" != "${OLD_SHA}" ] || continue
    echo "[deploy-gear] pruning old release ${name}"
    rm -rf -- "${RELEASES_DIR:?}/${name}"
  done
}

require_safe_absolute_path SOURCE_REPO "${SOURCE_REPO}"
require_safe_absolute_path DEPLOY_ROOT "${DEPLOY_ROOT}"
[ -x "${PNPM_BIN}" ] || fail "pnpm not executable: ${PNPM_BIN}"
[ -x "${NODE_BIN}" ] || fail "node not executable: ${NODE_BIN}"

case "${KEEP_RELEASES}" in
  ''|*[!0-9]*|0) fail "GEAR_KEEP_RELEASES must be a positive integer" ;;
esac

[ -d "${SOURCE_REPO}/.git" ] || fail "source repository not found: ${SOURCE_REPO}"
[ -f "${ENV_FILE}" ] || fail "canonical environment file not found: ${ENV_FILE}"
ENV_MODE="$(stat -Lc '%a' -- "${ENV_FILE}")"
[ "${ENV_MODE}" = "600" ] \
  || fail "canonical environment file must have mode 0600 (found ${ENV_MODE})"

mkdir -p -- "${DEPLOY_ROOT}"
[ -d "${DEPLOY_ROOT}" ] && [ ! -L "${DEPLOY_ROOT}" ] \
  || fail "deploy root must be a real directory: ${DEPLOY_ROOT}"
mkdir -p -- "${RELEASES_DIR}" "${STATE_DIR}"
[ -d "${RELEASES_DIR}" ] && [ ! -L "${RELEASES_DIR}" ] \
  || fail "releases path must be a real directory: ${RELEASES_DIR}"
[ -d "${STATE_DIR}" ] && [ ! -L "${STATE_DIR}" ] \
  || fail "state path must be a real directory: ${STATE_DIR}"
if [ -e "${FIFO_PATH}" ] || [ -L "${FIFO_PATH}" ]; then
  [ -p "${FIFO_PATH}" ] && [ ! -L "${FIFO_PATH}" ] \
    || fail "intake path exists but is not a FIFO: ${FIFO_PATH}"
fi

LOCK_FILE="${DEPLOY_ROOT}/.deploy.lock"
if [ -e "${LOCK_FILE}" ] || [ -L "${LOCK_FILE}" ]; then
  [ -f "${LOCK_FILE}" ] && [ ! -L "${LOCK_FILE}" ] \
    || fail "deploy lock path is unsafe: ${LOCK_FILE}"
fi
exec 9>"${LOCK_FILE}"
flock -n 9 || fail "another Gear deploy is already running (${LOCK_FILE})"

systemctl --user cat "${SERVICE_NAME}" >/dev/null 2>&1 \
  || fail "user service is not installed or loaded: ${SERVICE_NAME}"
require_service_workdir "${SERVICE_NAME}" "${CURRENT_LINK}"

if [ "${DEPLOY_REF}" = "origin/main" ]; then
  echo "[deploy-gear] fetching origin/main"
  git -C "${SOURCE_REPO}" fetch --prune origin main
fi

if ! TARGET_COMMIT="$(git -C "${SOURCE_REPO}" rev-parse --verify "${DEPLOY_REF}^{commit}")"; then
  fail "cannot resolve deploy ref to a commit: ${DEPLOY_REF}"
fi
is_sha "${TARGET_COMMIT}" \
  || fail "resolved deploy target is not an exact 40-character lowercase SHA: ${TARGET_COMMIT}"

RELEASE_DIR="${RELEASES_DIR}/${TARGET_COMMIT}"
echo "[deploy-gear] target ${DEPLOY_REF} -> ${TARGET_COMMIT}"

if [ -e "${RELEASE_DIR}" ] || [ -L "${RELEASE_DIR}" ]; then
  release_is_ready "${RELEASE_DIR}" "${TARGET_COMMIT}" \
    || fail "malformed reusable release was left untouched: ${RELEASE_DIR}"
  echo "[deploy-gear] reusing ready release ${TARGET_COMMIT}"
else
  staging_candidate="${RELEASES_DIR}/.${TARGET_COMMIT}.tmp.$$"
  [ ! -e "${staging_candidate}" ] && [ ! -L "${staging_candidate}" ] \
    || fail "staging path already exists: ${staging_candidate}"
  mkdir -- "${staging_candidate}"
  STAGING_DIR="${staging_candidate}"

  git -C "${SOURCE_REPO}" archive "${TARGET_COMMIT}" | tar -x -C "${STAGING_DIR}"
  ln -s -- "${ENV_FILE}" "${STAGING_DIR}/.env"

  echo "[deploy-gear] installing dependencies"
  (cd "${STAGING_DIR}" && "${PNPM_BIN}" install)
  echo "[deploy-gear] building release"
  (cd "${STAGING_DIR}" && "${PNPM_BIN}" run build)

  [ -f "${STAGING_DIR}/${READY_ARTIFACT}" ] \
    && [ ! -L "${STAGING_DIR}/${READY_ARTIFACT}" ] \
    || fail "build did not produce ${READY_ARTIFACT}"
  printf '%s\n' "${TARGET_COMMIT}" > "${STAGING_DIR}/REVISION"
  touch "${STAGING_DIR}/${READY_MARKER}"
  release_is_ready "${STAGING_DIR}" "${TARGET_COMMIT}" \
    || fail "staged release failed readiness validation"

  mv -- "${STAGING_DIR}" "${RELEASE_DIR}"
  STAGING_DIR=""
  echo "[deploy-gear] created immutable release ${TARGET_COMMIT}"
fi

OLD_TARGET=""
OLD_SHA=""
if [ -e "${CURRENT_LINK}" ] || [ -L "${CURRENT_LINK}" ]; then
  [ -L "${CURRENT_LINK}" ] || fail "current path is not a symlink: ${CURRENT_LINK}"
  OLD_TARGET="$(readlink -- "${CURRENT_LINK}")"
  case "${OLD_TARGET}" in
    releases/*) OLD_SHA="${OLD_TARGET#releases/}" ;;
    *) fail "current symlink target is unsafe: ${OLD_TARGET}" ;;
  esac
  is_sha "${OLD_SHA}" || fail "current symlink target is not an exact SHA: ${OLD_TARGET}"
  [ "${OLD_TARGET}" = "releases/${OLD_SHA}" ] \
    || fail "current symlink target is malformed: ${OLD_TARGET}"
  release_is_ready "${DEPLOY_ROOT}/${OLD_TARGET}" "${OLD_SHA}" \
    || fail "current release is malformed and cannot be a rollback target: ${OLD_TARGET}"
fi

next_candidate="${DEPLOY_ROOT}/.current.next.$$"
[ ! -e "${next_candidate}" ] && [ ! -L "${next_candidate}" ] \
  || fail "next-link path already exists: ${next_candidate}"
ln -s -- "releases/${TARGET_COMMIT}" "${next_candidate}"
NEXT_LINK="${next_candidate}"
mv -Tf -- "${NEXT_LINK}" "${CURRENT_LINK}"
NEXT_LINK=""

echo "[deploy-gear] restarting ${SERVICE_NAME}"
restart_ok=1
if ! systemctl --user restart "${SERVICE_NAME}"; then
  restart_ok=0
  echo "[deploy-gear] service restart command failed" >&2
fi

if [ "${restart_ok}" -eq 1 ] && wait_for_health; then
  echo "[deploy-gear] healthy: user service active and FIFO present"
  echo "[deploy-gear] deployed ${TARGET_COMMIT}"
  prune_old_releases
  exit 0
fi

echo "[deploy-gear] new release did not become healthy" >&2
if [ -n "${OLD_TARGET}" ]; then
  echo "[deploy-gear] rolling back to ${OLD_TARGET}" >&2
  rollback_candidate="${DEPLOY_ROOT}/.current.rollback.$$"
  [ ! -e "${rollback_candidate}" ] && [ ! -L "${rollback_candidate}" ] \
    || fail "rollback-link path already exists: ${rollback_candidate}"
  ln -s -- "${OLD_TARGET}" "${rollback_candidate}"
  ROLLBACK_LINK="${rollback_candidate}"
  mv -Tf -- "${ROLLBACK_LINK}" "${CURRENT_LINK}"
  ROLLBACK_LINK=""

  if ! systemctl --user restart "${SERVICE_NAME}"; then
    echo "[deploy-gear] rollback restart command failed" >&2
  fi
  if wait_for_health; then
    echo "[deploy-gear] rollback recovered on ${OLD_TARGET}" >&2
  else
    echo "[deploy-gear] rollback did not recover within the health budget" >&2
  fi
else
  echo "[deploy-gear] no previous release exists; rollback was not possible" >&2
fi

systemctl --user --no-pager --full status "${SERVICE_NAME}" || true
fail "deployment failed; no releases were pruned"
