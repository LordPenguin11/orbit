#!/bin/sh
# Link the orbit-project skill into agent skill dirs. Usage: install.sh [skills-dir ...]
# Default: ~/.claude/skills and ~/.agents/skills (created if missing).
set -eu
src="$(cd "$(dirname "$0")" && pwd)/skills/orbit-project"
[ "$#" -gt 0 ] || set -- "$HOME/.claude/skills" "$HOME/.agents/skills"
for dir in "$@"; do
  mkdir -p "$dir"
  ln -sfn "$src" "$dir/orbit-project"
  echo "linked $dir/orbit-project -> $src"
done
