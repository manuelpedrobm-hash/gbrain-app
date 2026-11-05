#!/bin/zsh
# Keeps the Telegram channel session of Claude Code running in a detached screen.
# Started by launchd (com.__USER__.telegram-agent). Attach with: screen -r gbrain-telegram
export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# Use the CLI's own login (keychain), never a token inherited from the environment
unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN
export LANG="${LANG:-es_ES.UTF-8}"
cd "$HOME/GBRAIN/agente-telegram" || exit 1
# Resume the previous conversation when there is one, so a restart keeps the context
CONT=()
ls "$HOME/.claude/projects/__REPO_SLUG__-agente-telegram/"*.jsonl >/dev/null 2>&1 && CONT=(--continue)
exec /usr/bin/screen -DmS gbrain-telegram claude "${CONT[@]}" --chrome --model sonnet --add-dir "$HOME/Bandeja" --channels plugin:telegram@claude-plugins-official
