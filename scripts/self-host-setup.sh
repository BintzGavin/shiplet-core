#!/usr/bin/env bash
#
# A wizard — walks a human through a manual procedure step by step.
# Generated with the wizard skill.
# Adapted from https://github.com/mattpocock/skills (MIT License).
#
# Everything above the "STAGES" marker is the wizard library: do not hand-edit
# it. Author the per-step stages below the marker.

set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────
# Wizard library — consistent UX. Identical across every generated wizard.
# ──────────────────────────────────────────────────────────────────────────

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  BLUE=$(tput setaf 4); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RED=$(tput setaf 1)
else
  BOLD=""; DIM=""; RESET=""; BLUE=""; GREEN=""; YELLOW=""; RED=""
fi

# Author sets these two at the top of the stages section.
TOTAL_STAGES=0
TOTAL_MINUTES=0

_STAGE_INDEX=0
_MINUTES_ELAPSED=0
ENV_FILE="${ENV_FILE:-.env}"
WRITTEN_ENV=()
WRITTEN_SECRET=()
SKIPPED=()

# _clear — wipe the terminal so only the current step is on screen. No-op when
# output is not a terminal, so piped logs stay readable.
_clear() {
  [[ -t 1 ]] || return 0
  if command -v tput >/dev/null 2>&1; then tput clear; else printf '\033[2J\033[3J\033[H'; fi
}

# banner "Title" — opening frame: what this wizard does and how long it takes.
banner() {
  _clear
  printf '\n%s%s  %s%s\n' "$BOLD" "$BLUE" "$1" "$RESET"
  printf '%s  %s stages · about %s minutes%s\n\n' \
    "$DIM" "$TOTAL_STAGES" "$TOTAL_MINUTES" "$RESET"
  printf '%s  You drive the browser; this wizard tells you exactly what to do and\n' "$DIM"
  printf '  captures the values you copy back. Stop any time with Ctrl-C and re-run\n'
  printf '  later — it remembers values already saved.%s\n' "$RESET"
  pause "Ready to start?"
}

# stage "Name" <minutes> — clear the screen, announce a stage, and show
# progress plus estimated time remaining.
stage() {
  _clear
  _STAGE_INDEX=$((_STAGE_INDEX + 1))
  local remaining=$((TOTAL_MINUTES - _MINUTES_ELAPSED))
  (( remaining < 0 )) && remaining=0
  _MINUTES_ELAPSED=$((_MINUTES_ELAPSED + ${2:-0}))
  printf '\n%s%s▸ Stage %s/%s · %s%s  %s(~%s min left)%s\n' \
    "$BOLD" "$BLUE" "$_STAGE_INDEX" "$TOTAL_STAGES" "$1" "$RESET" "$DIM" "$remaining" "$RESET"
}

# say "..." — a plain instruction line.
say()  { printf '  %s\n' "$1"; }
# step "..." — an action the human takes in the browser.
step() { printf '  %s•%s %s\n' "$BLUE" "$RESET" "$1"; }
note() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %s⚠ %s%s\n' "$YELLOW" "$1" "$RESET"; }

# open_url URL — open in the human's browser, including macOS, Linux, and WSL.
open_url() {
  local url="$1"
  printf '  %s↗ opening%s %s\n' "$GREEN" "$RESET" "$url"
  { if   command -v wslview      >/dev/null 2>&1; then wslview "$url"
    elif command -v explorer.exe >/dev/null 2>&1; then explorer.exe "$url"
    elif command -v xdg-open     >/dev/null 2>&1; then xdg-open "$url"
    elif command -v open         >/dev/null 2>&1; then open "$url"
    else warn "couldn't open a browser — visit it manually: $url"; fi
  } >/dev/null 2>&1 || warn "couldn't open a browser — visit it manually: $url"
}

# pause "msg" — wait for the human to confirm the manual part is done.
pause() {
  printf '  %s%s%s ' "$DIM" "${1:-Press Enter to continue}" "$RESET"
  read -r _ || true
}

# confirm "question" — y/N gate; return success on yes.
confirm() {
  local reply=""
  printf '  %s? %s [y/N] ' "$YELLOW" "$1"
  read -r reply || true
  [[ "$reply" =~ ^[Yy] ]]
}

# _existing KEY — current value of KEY in ENV_FILE, if any. This runs only in
# the human-controlled wizard process; the generating agent never reads it.
_existing() {
  [[ -f "$ENV_FILE" ]] || return 1
  local line; line=$(grep -E "^${1}=" "$ENV_FILE" | tail -n1) || return 1
  printf '%s' "${line#*=}"
}

# ask KEY "Prompt" — read a visible value into KEY. On re-runs, Enter keeps
# the current value from ENV_FILE.
ask() {
  local key="$1" prompt="$2" current input
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -r input || true
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

# ask_secret KEY "Prompt" — like ask, but hide terminal input.
ask_secret() {
  local key="$1" prompt="$2" current input
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -rs input || true
  printf '\n'
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

# write_env KEY VALUE — idempotently upsert KEY=VALUE into ENV_FILE.
write_env() {
  local key="$1" value="$2" tmp
  touch "$ENV_FILE"
  tmp=$(mktemp)
  grep -vE "^${key}=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
  WRITTEN_ENV+=("$key")
  printf '  %s✓ wrote%s %s → %s\n' "$GREEN" "$RESET" "$key" "$ENV_FILE"
}

# set_secret NAME VALUE — set a GitHub Actions repository secret through gh.
set_secret() {
  local name="$1" value="$2"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if printf '%s' "$value" | gh secret set "$name" >/dev/null 2>&1; then
      WRITTEN_SECRET+=("$name")
      printf '  %s✓ set%s GitHub secret %s\n' "$GREEN" "$RESET" "$name"
      return
    fi
  fi
  SKIPPED+=("GitHub secret $name (set it manually: gh secret set $name)")
  warn "skipped GitHub secret $name — gh not ready; set it later"
}

# set_var NAME VALUE — set a public GitHub Actions repository variable.
set_var() {
  local name="$1" value="$2"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if gh variable set "$name" --body "$value" >/dev/null 2>&1; then
      printf '  %s✓ set%s GitHub variable %s\n' "$GREEN" "$RESET" "$name"
      return
    fi
  fi
  SKIPPED+=("GitHub variable $name")
  warn "skipped GitHub variable $name — gh not ready; set it later"
}

# finish — clear, then summarize configured and skipped items.
finish() {
  _clear
  printf '\n%s%s  ✓ Setup complete%s\n' "$BOLD" "$GREEN" "$RESET"
  (( ${#WRITTEN_ENV[@]} ))    && note "wrote ${#WRITTEN_ENV[@]} value(s) to $ENV_FILE: ${WRITTEN_ENV[*]}"
  (( ${#WRITTEN_SECRET[@]} )) && note "set ${#WRITTEN_SECRET[@]} GitHub secret(s): ${WRITTEN_SECRET[*]}"
  if (( ${#SKIPPED[@]} )); then
    printf '\n'; warn "still to do by hand:"
    for item in "${SKIPPED[@]}"; do note "  - $item"; done
  fi
  printf '\n'
}

# ──────────────────────────────────────────────────────────────────────────
# STAGES — author this section. Use one stage per focused human task.
# Replace the example and set both totals to match the authored stages.
# ──────────────────────────────────────────────────────────────────────────

TOTAL_STAGES=8
TOTAL_MINUTES=25

# Secret values are captured later. Disable shell tracing even when the human
# invoked this script with bash -x so hidden input cannot be echoed.
set +x

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
WRANGLER="$REPO_ROOT/node_modules/.bin/wrangler"
CONFIG_HELPER="$SCRIPT_DIR/self-host-config.mjs"
GENERATED_ROOT="$REPO_ROOT/.shiplet-self-host"
ENV_FILE="$GENERATED_ROOT/.wizard-public-state"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '  %s✗ %s is required%s\n' "$RED" "$1" "$RESET" >&2
    exit 1
  fi
}

config_field() {
  node "$CONFIG_HELPER" field --config "$CONFIG_PATH" --name "$1"
}

generate_config() {
  node "$CONFIG_HELPER" generate \
    --output-dir "$OUTPUT_DIR" \
    --deployment-name "$DEPLOYMENT_NAME" \
    --database-id "$DATABASE_ID" \
    --app-url "$APP_URL" \
    --authkit-issuer "$WORKOS_AUTHKIT_ISSUER" >/dev/null
}

put_worker_secret() {
  local name="$1" value="$2"
  if printf '%s' "$value" | "$WRANGLER" secret put "$name" --config "$CONFIG_PATH" >/dev/null; then
    printf '  %s✓ stored%s Cloudflare Worker secret %s\n' "$GREEN" "$RESET" "$name"
  else
    warn "Cloudflare did not accept Worker secret $name"
    return 1
  fi
}

banner "Shiplet static-first self-hosting"

stage "Preflight and deployment name" 3
say "This supported profile installs the Shiplet review application without Workers for Platforms."
note "It creates one Worker, one D1 database, two private R2 buckets, and two Durable Objects."
require_command node
require_command npm
require_command curl
require_command openssl
if [[ ! -x "$WRANGLER" ]]; then
  warn "Project dependencies are not installed."
  if confirm "Run npm ci now?"; then
    (cd "$REPO_ROOT" && npm ci)
  else
    say "Run npm ci, then restart this wizard."
    exit 1
  fi
fi
"$WRANGLER" --version
ask DEPLOYMENT_NAME "Deployment name (lowercase letters, numbers, and hyphens; up to 48 chars):"
if [[ ! "$DEPLOYMENT_NAME" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || (( ${#DEPLOYMENT_NAME} > 48 )); then
  warn "Invalid deployment name. Use lowercase letters, numbers, and interior hyphens."
  exit 1
fi
OUTPUT_DIR="$GENERATED_ROOT/$DEPLOYMENT_NAME"
CONFIG_PATH="$OUTPUT_DIR/wrangler.jsonc"
CAPABILITIES_PATH="$OUTPUT_DIR/capabilities.json"
mkdir -p "$OUTPUT_DIR"
note "Generated public configuration: $CONFIG_PATH"
note "The directory is ignored by Git and will never hold secret values."

stage "Cloudflare login" 3
open_url "https://dash.cloudflare.com/"
if "$WRANGLER" whoami >/dev/null 2>&1; then
  say "Wrangler is already authenticated."
else
  step "Sign in or create the Cloudflare account that should own this Shiplet."
  pause "Press Enter to start Wrangler's browser login."
  "$WRANGLER" login
  "$WRANGLER" whoami >/dev/null
fi

stage "Provision static resources" 4
if [[ -f "$CONFIG_PATH" ]]; then
  say "An existing generated config was found; its public resource identifiers will be reused."
  DATABASE_ID=$(config_field database-id)
  ASSETS_BUCKET=$(config_field assets-bucket)
  REVIEW_ASSETS_BUCKET=$(config_field review-assets-bucket)
  APP_URL=$(config_field app-url)
  WORKOS_AUTHKIT_ISSUER=$(config_field authkit-issuer)
else
  ASSETS_BUCKET="${DEPLOYMENT_NAME}-assets"
  REVIEW_ASSETS_BUCKET="${DEPLOYMENT_NAME}-review-assets"
  warn "This creates billable Cloudflare resources. A stopped wizard does not delete partial resources."
  note "D1: $DEPLOYMENT_NAME"
  note "R2: $ASSETS_BUCKET and $REVIEW_ASSETS_BUCKET"
  if ! confirm "Create these resources in the authenticated Cloudflare account?"; then
    say "No remote resources were created."
    exit 0
  fi
  D1_OUTPUT=$("$WRANGLER" d1 create "$DEPLOYMENT_NAME")
  DATABASE_ID=$(printf '%s' "$D1_OUTPUT" | node "$CONFIG_HELPER" parse-d1)
  "$WRANGLER" r2 bucket create "$ASSETS_BUCKET"
  "$WRANGLER" r2 bucket create "$REVIEW_ASSETS_BUCKET"
  APP_URL="https://pending.invalid"
  WORKOS_AUTHKIT_ISSUER="https://pending.invalid"
fi
generate_config
say "Static resources and a bootstrap config are ready."

stage "First deploy and application URL" 4
say "Wrangler will first bundle the exact static-only topology without uploading it."
"$WRANGLER" deploy --dry-run --config "$CONFIG_PATH"
if ! confirm "Deploy the bootstrap Worker to Cloudflare?"; then
  say "Resources remain in your account; re-run the wizard to continue."
  exit 0
fi
"$WRANGLER" deploy --config "$CONFIG_PATH"
step "Copy the HTTPS workers.dev URL printed by Wrangler above."
note "Use a custom HTTPS origin only if you already attached and verified that domain."
PREVIOUS_APP_URL="$APP_URL"
ask APP_URL "Application origin (for example, https://name.account.workers.dev):"
if [[ -z "$APP_URL" && "$PREVIOUS_APP_URL" != "https://pending.invalid" ]]; then
  APP_URL="$PREVIOUS_APP_URL"
fi
generate_config

stage "WorkOS AuthKit application" 5
say "Shiplet uses your WorkOS application for browser and agent identity."
open_url "https://dashboard.workos.com/"
step "Open Applications and select the application for this Shiplet environment."
step "In Redirects, add exactly: $APP_URL/auth/callback"
step "Copy the application's Client ID."
ask WORKOS_CLIENT_ID "WorkOS Client ID:"
if [[ ! "$WORKOS_CLIENT_ID" =~ ^client_[A-Za-z0-9]+$ ]]; then
  warn "The Client ID should start with client_."
  exit 1
fi
step "Copy the environment's AuthKit domain, including https:// and no path."
PREVIOUS_AUTHKIT_ISSUER="$WORKOS_AUTHKIT_ISSUER"
ask WORKOS_AUTHKIT_ISSUER "AuthKit issuer (for example, https://your-app.authkit.app):"
if [[ -z "$WORKOS_AUTHKIT_ISSUER" && "$PREVIOUS_AUTHKIT_ISSUER" != "https://pending.invalid" ]]; then
  WORKOS_AUTHKIT_ISSUER="$PREVIOUS_AUTHKIT_ISSUER"
fi
generate_config
say "The generated config now contains the public URL and issuer only."

stage "Install Worker secrets" 3
open_url "https://dashboard.workos.com/"
step "Open the same application's Credentials or API keys section."
step "Create or copy an API key for this environment. Production keys may be shown only once."
ask_secret WORKOS_API_KEY "WorkOS API key (hidden):"
if [[ -z "$WORKOS_API_KEY" ]]; then
  warn "A WorkOS API key is required."
  exit 1
fi
SHIPLET_REVIEW_TOKEN_SECRET=$(openssl rand -hex 32)
say "A separate review-token signing key was generated in memory."
if ! confirm "Install the Client ID, WorkOS API key, and review signing key in Cloudflare's Worker secret store?"; then
  say "No secrets were installed. Re-run the wizard when ready."
  unset WORKOS_API_KEY SHIPLET_REVIEW_TOKEN_SECRET
  exit 0
fi
put_worker_secret WORKOS_CLIENT_ID "$WORKOS_CLIENT_ID"
put_worker_secret WORKOS_API_KEY "$WORKOS_API_KEY"
put_worker_secret SHIPLET_REVIEW_TOKEN_SECRET "$SHIPLET_REVIEW_TOKEN_SECRET"
unset WORKOS_API_KEY SHIPLET_REVIEW_TOKEN_SECRET

stage "Final deploy" 2
"$WRANGLER" deploy --dry-run --config "$CONFIG_PATH"
if ! confirm "Deploy the final static-first configuration?"; then
  say "The bootstrap Worker remains deployed; re-run the wizard to finish."
  exit 0
fi
"$WRANGLER" deploy --config "$CONFIG_PATH"

stage "Smoke test and capability report" 1
say "Checking the public application shell and OpenAPI contract."
curl --fail --silent --show-error "$APP_URL/" >/dev/null
curl --fail --silent --show-error "$APP_URL/openapi.json" >/dev/null
node "$CONFIG_HELPER" inspect \
  --main-config "$CONFIG_PATH" \
  --write "$CAPABILITIES_PATH"
say "Static review is available. Advanced paths remain optional and unavailable by design."
note "Upgrade guide: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/"
open_url "$APP_URL"
step "Sign in through WorkOS, create one static Shiplet, and open its review link."
pause "Press Enter after the browser smoke test, or Ctrl-C to leave it for later."

finish
note "generated public config: $CONFIG_PATH"
note "capability report: $CAPABILITIES_PATH"
note "stored only in Cloudflare: WORKOS_CLIENT_ID, WORKOS_API_KEY, SHIPLET_REVIEW_TOKEN_SECRET"
note "rollback: $WRANGLER rollback --config $CONFIG_PATH"
note "advanced upgrade: add the support configs, then re-run the capability inspector"
