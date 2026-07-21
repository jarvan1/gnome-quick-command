#!/usr/bin/env bash

set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
readonly PACKAGE_NAME="gnome-shell-extension-quick-command"
readonly UUID="quick-command@xinming.dev"

version="${1:-}"
if [[ -z "${version}" ]]; then
    version="$(node -p "require('${PROJECT_DIR}/metadata.json').version")"
fi
version="${version#v}"

if ! dpkg --validate-version "${version}"; then
    printf 'Invalid Debian package version: %s\n' "${version}" >&2
    exit 1
fi

make -C "${PROJECT_DIR}" test
make -C "${PROJECT_DIR}" build

output_dir="${OUTPUT_DIR:-${PROJECT_DIR}/dist}"
mkdir -p "${output_dir}"

package_root="$(mktemp -d)"
trap 'rm -rf -- "${package_root}"' EXIT

extension_dir="${package_root}/usr/share/gnome-shell/extensions/${UUID}"
mkdir -p "${package_root}/DEBIAN" "${extension_dir}"
cp -a "${PROJECT_DIR}/build/${UUID}/." "${extension_dir}/"

installed_size="$(du -sk "${package_root}/usr" | cut -f1)"
sed \
    -e "s/@VERSION@/${version}/g" \
    -e "s/@INSTALLED_SIZE@/${installed_size}/g" \
    "${SCRIPT_DIR}/debian/control.in" > "${package_root}/DEBIAN/control"

find "${package_root}" -type d -exec chmod 0755 {} +
find "${extension_dir}" -type f -exec chmod 0644 {} +
chmod 0644 "${package_root}/DEBIAN/control"

output_file="${output_dir}/${PACKAGE_NAME}_${version}_all.deb"
dpkg-deb --root-owner-group --build "${package_root}" "${output_file}"
printf '%s\n' "${output_file}"
