#!/bin/zsh
# Servidor MCP de GBrain por stdio, para Claude Desktop (pestana Chat).
# No usa token HTTP ni el puerto 3131: abre su propio proceso contra la misma base Postgres.
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export GBRAIN_FTS_LANGUAGE=spanish
cd / || exit 1
exec gbrain serve --advertise starter
