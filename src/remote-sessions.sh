# Read-only remote probe for Micro Agent Bridge, streamed over one SSH session.
# Every 2 s prints one line per Claude Code session registry entry:
#   MAB1 <sessionId> <bridgeId|-> <status|-> <alive 0|1>
# followed by MAB1-END. Only identifiers and status leave the machine: no paths,
# names, prompts, or transcript content. Nothing is installed or written remotely.
field() { printf '%s' "$j" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([$2]*\).*/\1/p" | head -n 1; }
while :; do
  for f in "$HOME"/.claude/sessions/*.json; do
    [ -f "$f" ] || continue
    j=$(head -c 65536 "$f" | tr -d '\n\r')
    sid=$(field sessionId 'a-f0-9-')
    pid=$(field pid '0-9')
    bridge=$(field bridgeSessionId 'A-Za-z0-9_')
    status=$(field status 'a-z_')
    alive=0
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && alive=1
    printf 'MAB1 %s %s %s %s\n' "${sid:--}" "${bridge:--}" "${status:--}" "$alive"
  done
  printf 'MAB1-END\n' || exit 0
  sleep 2
done
