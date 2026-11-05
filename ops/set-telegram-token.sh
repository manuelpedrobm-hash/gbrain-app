#!/bin/zsh
# Asks for the Telegram bot token (hidden input) and saves it where the Telegram
# channel plugin reads it: ~/.claude/channels/telegram/.env (mode 600).
set -u
DIR="$HOME/.claude/channels/telegram"
mkdir -p "$DIR" && chmod 700 "$DIR"
print -n "Pega el token de @BotFather y pulsa Intro (no se verá al pegarlo): "
read -rs TOKEN
print
if [[ ! "$TOKEN" =~ '^[0-9]+:[A-Za-z0-9_-]{30,}$' ]]; then
  print "Ese texto no parece un token de bot (formato 123456789:AAH...). No he guardado nada."
  exit 1
fi
umask 077
print -r -- "TELEGRAM_BOT_TOKEN=$TOKEN" > "$DIR/.env"
chmod 600 "$DIR/.env"
unset TOKEN
print "Token guardado en $DIR/.env"
