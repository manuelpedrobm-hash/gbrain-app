"""Send a text file to __NOMBRE__'s paired Telegram chat through the existing bot.

Send-only (sendMessage): it does not poll, so it does not compete with the Claude Code Telegram
channel that reads the same bot. Token and chat id are read at run time from the channel's own
files and never printed. Usage: python3 -I telegram-enviar.py <file>
"""
import json, os, sys, urllib.parse, urllib.request

home = os.path.expanduser('~')
chan = os.path.join(home, '.claude', 'channels', 'telegram')
token = ''
for line in open(os.path.join(chan, '.env')):
    if line.startswith('TELEGRAM_BOT_TOKEN='):
        token = line.split('=', 1)[1].strip()
chat = json.load(open(os.path.join(chan, 'access.json')))['allowFrom'][0]
if not token or not chat:
    sys.exit('sin token o chat de Telegram')

text = open(sys.argv[1], encoding='utf-8').read().strip()
# Telegram limits a message to 4096 characters: send in pieces, cut at line breaks.
parts, cur = [], ''
for line in text.splitlines(keepends=True):
    if len(cur) + len(line) > 3900:
        parts.append(cur); cur = ''
    cur += line
if cur.strip():
    parts.append(cur)
for p in parts:
    data = urllib.parse.urlencode({'chat_id': chat, 'text': p, 'disable_web_page_preview': 'true'}).encode()
    with urllib.request.urlopen(f'https://api.telegram.org/bot{token}/sendMessage', data, timeout=30) as r:
        if json.load(r).get('ok') is not True:
            sys.exit('Telegram rechazó el mensaje')
print(f'telegram: {len(parts)} mensaje(s)')
