#!/usr/bin/env bash
# start-n8n-ai-cli-loop.sh — launch n8n with the private node loaded.
#
# Sets the three environment variables needed for the private node:
#
#   CLI_BASE               — compiled CLI entrypoints; the private node invokes
#                            these at runtime for each operation.
#   N8N_CUSTOM_EXTENSIONS  — directory n8n scans for custom node files.
#                            Loading via this path causes n8n to register the
#                            node type as CUSTOM.<nodeName>, i.e. CUSTOM.aiCliLoop.
#                            Workflows that use the private node must reference
#                            the type CUSTOM.aiCliLoop, not the package-name form
#                            n8n-nodes-ai-cli-loop.aiCliLoop.
#   NODES_EXCLUDE          — empty array so no built-in nodes are accidentally
#                            excluded.
#
# Run from anywhere; the script resolves the repo root from its own location.
# Pass any extra n8n flags after the script name, e.g.:
#
#   ./scripts/start-n8n-ai-cli-loop.sh --tunnel

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

export CLI_BASE="$REPO_ROOT/dist/cli"
export N8N_CUSTOM_EXTENSIONS="$REPO_ROOT/n8n-node/dist"
export NODES_EXCLUDE="[]"

echo "Starting n8n with private node (CUSTOM.aiCliLoop)..."
echo "  CLI_BASE              = $CLI_BASE"
echo "  N8N_CUSTOM_EXTENSIONS = $N8N_CUSTOM_EXTENSIONS"
echo "  NODES_EXCLUDE         = $NODES_EXCLUDE"
echo ""

exec n8n start "$@"
