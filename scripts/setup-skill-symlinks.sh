#!/usr/bin/env bash
# setup-skill-symlinks.sh — Create .opencode/skills/<name> symlinks to plugins/<name>/ai
#
# This script bridges the AI agent skill system with the new plugin architecture.
# The agent expects SKILL.md files at .opencode/skills/<name>/SKILL.md, but the
# canonical location is now plugins/<name>/ai/SKILL.md.
#
# This script:
#   1. Removes old skill directories that have been moved to plugins/
#   2. Creates symlinks: .opencode/skills/<name> → ../../plugins/<name>/ai
#
# Safe to run multiple times (idempotent).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILLS_DIR="$PROJECT_ROOT/.opencode/skills"
PLUGINS_DIR="$PROJECT_ROOT/plugins"

# Ensure the skills directory exists
mkdir -p "$SKILLS_DIR"

# Track what we did for summary output
replaced=0
created=0
skipped=0

# Iterate over every plugin that has an ai/ directory
for plugin_dir in "$PLUGINS_DIR"/*/; do
  plugin_name="$(basename "$plugin_dir")"
  ai_dir="$plugin_dir/ai"
  skill_link="$SKILLS_DIR/$plugin_name"

  # Skip plugins without an ai/ directory
  if [[ ! -d "$ai_dir" ]]; then
    continue
  fi

  # Relative symlink target: from .opencode/skills/<name> → ../../plugins/<name>/ai
  link_target="../../plugins/$plugin_name/ai"

  # Case 1: Already a correct symlink — skip
  if [[ -L "$skill_link" ]]; then
    current_target="$(readlink "$skill_link")"
    if [[ "$current_target" = "$link_target" ]]; then
      echo "  [ok]      $plugin_name (symlink already correct)"
      ((skipped++)) || true
      continue
    else
      # Symlink exists but points elsewhere — replace it
      echo "  [update]  $plugin_name (updating symlink: $current_target → $link_target)"
      rm "$skill_link"
      ln -s "$link_target" "$skill_link"
      ((replaced++)) || true
      continue
    fi
  fi

  # Case 2: Regular directory exists — remove it and replace with symlink
  if [[ -d "$skill_link" ]]; then
    echo "  [replace] $plugin_name (removing old directory, creating symlink)"
    rm -rf "$skill_link"
    ln -s "$link_target" "$skill_link"
    ((replaced++)) || true
    continue
  fi

  # Case 3: Nothing exists — create the symlink
  echo "  [create]  $plugin_name (new symlink)"
  ln -s "$link_target" "$skill_link"
  ((created++)) || true
done

echo ""
echo "Done: $created created, $replaced replaced, $skipped already correct"
