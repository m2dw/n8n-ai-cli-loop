@echo off
rem start-n8n-ai-cli-loop.bat — launch n8n with the private node loaded.
rem
rem Sets the three environment variables needed for the private node:
rem
rem   CLI_BASE               — compiled CLI entrypoints; the private node invokes
rem                            these at runtime for each operation.
rem   N8N_CUSTOM_EXTENSIONS  — directory n8n scans for custom node files.
rem                            Loading via this path causes n8n to register the
rem                            node type as CUSTOM.<nodeName>, i.e. CUSTOM.aiCliLoop.
rem                            Workflows that use the private node must reference
rem                            the type CUSTOM.aiCliLoop, not the package-name form
rem                            n8n-nodes-ai-cli-loop.aiCliLoop.
rem   NODES_EXCLUDE          — empty array so no built-in nodes are accidentally
rem                            excluded.
rem
rem Run from anywhere; the script resolves the repo root from its own location.
rem Pass any extra n8n flags after the script name, e.g.:
rem
rem   scripts\start-n8n-ai-cli-loop.bat --tunnel

setlocal

rem %~dp0 is the directory of this script with a trailing backslash.
rem Appending .. navigates to the repo root.
set SCRIPT_DIR=%~dp0
set REPO_ROOT=%SCRIPT_DIR%..

set CLI_BASE=%REPO_ROOT%\dist\cli
set N8N_CUSTOM_EXTENSIONS=%REPO_ROOT%\n8n-node\dist
set NODES_EXCLUDE=[]

echo Starting n8n with private node (CUSTOM.aiCliLoop)...
echo   CLI_BASE              = %CLI_BASE%
echo   N8N_CUSTOM_EXTENSIONS = %N8N_CUSTOM_EXTENSIONS%
echo   NODES_EXCLUDE         = %NODES_EXCLUDE%
echo.

n8n start %*
