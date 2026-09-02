#!/usr/bin/env bash

set -euo pipefail

workspace_folder="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

if [[ $# -eq 0 ]]; then
	printf 'Usage: %s <command> [arguments...]\n' "${0##*/}" >&2
	exit 64
fi

if ! command -v devcontainer >/dev/null 2>&1; then
	printf 'The Dev Container CLI (@devcontainers/cli) is required. Install it globally now? [y/N] '
	read -r install_reply
	case "$install_reply" in
	[yY] | [yY][eE][sS])
		npm install --global @devcontainers/cli
		;;
	*)
		printf 'Install it with: npm install --global @devcontainers/cli\n' >&2
		exit 1
		;;
	esac
fi

devcontainer up --workspace-folder "$workspace_folder"
exec devcontainer exec --workspace-folder "$workspace_folder" "$@"