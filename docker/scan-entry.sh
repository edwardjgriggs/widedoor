#!/bin/sh
# The hosted scan machine's entry (Dockerfile target scan; ledger R4, R13, R29, R30, R32).
# Fly's init runs it as root with the job in its environment. In order, failing closed:
# any failure before step 5 exits 1 before the agent runs.
#   1. Refuse to run as anyone but root.
#   2. Lock Fly's machine API socket (/.fly/api) to root, if the machine has one.
#   3. Write the firewall rules (firewall-bin.js resolves the control host while it still
#      can) and load them whole with iptables-restore and ip6tables-restore.
#   4. Start the egress proxy as uid 10002 with an empty environment (never the job
#      token), its output read by egress-reader-bin.js, and wait for its ready line.
#   5. Run the agent as a child with the proxy URL; it runs each scan as uid 10001.
#      SIGTERM and SIGINT go on to the agent. If the proxy's output ends, or the reader
#      ends, before the scan is over, the entry gets SIGUSR1: the agent is stopped and
#      the entry exits non-zero.
#   6. Once the agent has exited: the reader reports the dropped lines (SIGTERM) and
#      ends, the proxy is stopped, each with SIGKILL after 5 s, and the entry exits with
#      the agent's code.
# The test switches WIDEDOOR_AGENT_SAME_USER and WIDEDOOR_EGRESS_SAME_USER are never set
# here, and are unset before anything starts.
set -eu

NODE=/usr/local/bin/node
HOSTED=/app/packages/server/dist/hosted
PROXY_PORT=18080
EGRESS_UID=10002

reader=
egress=
agent=
pending=
lost=0
scan_over=0

fail() {
  echo "widedoor event=entry_failed step=$1" >&2
  [ -z "$egress" ] || kill -KILL "$egress" 2>/dev/null || :
  [ -z "$reader" ] || kill -TERM "$reader" 2>/dev/null || :
  exit 1
}

# A signal goes on to the agent while it runs. Before the agent starts it is kept in
# pending, and the entry fails instead of starting the agent.
forward() {
  if [ -n "$agent" ]; then
    kill -"$1" "$agent" 2>/dev/null || :
  else
    pending=$1
  fi
}

# The proxy's output ended or the reader ended: the scan must not go on, unless it is
# already over. The proxy stops at once too, so it never serves through the agent's grace
# period without a reader.
egress_lost() {
  [ "$scan_over" = 1 ] && return 0
  lost=1
  [ -z "$egress" ] || kill -TERM "$egress" 2>/dev/null || :
  forward TERM
}

# Waits for a child of this shell until its own status comes back: a trapped signal ends
# `wait` early (status over 128) while the child still runs or is not yet collected.
# 127 means there is nothing left to wait for. Sets status.
wait_child() {
  status=0
  while :; do
    s=0
    wait "$1" || s=$?
    [ "$s" -ne 127 ] || return 0
    status=$s
    kill -0 "$1" 2>/dev/null || return 0
  done
}

# Sends a child SIGTERM and waits for it, with SIGKILL after 5 s. The timer is killed once
# the child is gone, so no sleep is left behind.
stop_child() {
  kill -TERM "$1" 2>/dev/null || :
  (
    timer=
    trap '[ -z "$timer" ] || kill "$timer" 2>/dev/null; exit 0' TERM
    sleep 5 &
    timer=$!
    wait "$timer" || :
    kill -KILL "$1" 2>/dev/null || :
  ) &
  killer=$!
  wait_child "$1"
  kill -TERM "$killer" 2>/dev/null || :
  wait "$killer" 2>/dev/null || :
}

# 1. Root only: as anyone else the firewall cannot load and the users cannot be dropped to.
[ "$(id -u)" = 0 ] || fail uid

# 2. A scan user must never reach the machine API (it can mint tokens). The folder alone
# would do; the socket is locked too in case it is ever reached another way.
if [ -e /.fly/api ] || [ -L /.fly/api ]; then
  chown root:root /.fly /.fly/api || fail fly_api
  chmod 0700 /.fly || fail fly_api
  chmod 0600 /.fly/api || fail fly_api
  [ "$(stat -L -c %u:%a /.fly/api)" = 0:600 ] || fail fly_api
  [ "$(stat -c %u:%a /.fly)" = 0:700 ] || fail fly_api
fi

unset WIDEDOOR_AGENT_SAME_USER WIDEDOOR_EGRESS_SAME_USER

# 3. The firewall. mktemp -d makes a folder only root can enter.
dir=$(mktemp -d) || fail tmp
env -i PATH="$PATH" WIDEDOOR_CONTROL_URL="${WIDEDOOR_CONTROL_URL:-}" \
  "$NODE" "$HOSTED/firewall-bin.js" "$dir" || fail firewall_rules
/usr/sbin/iptables-restore <"$dir/rules.v4" || fail iptables
/usr/sbin/ip6tables-restore <"$dir/rules.v6" || fail ip6tables

# 4. The egress proxy. Its stdout and stderr both go to the reader through a FIFO in the
# root-only folder, so a compromised proxy can write nothing to the log the reader does
# not judge. The reader sends this entry SIGTERM if the proxy never gets ready, and
# SIGUSR1 if the proxy's output ends. The reader runs in a wrapper (a subshell, in
# which $$ is still this entry's pid) that sends SIGUSR1 when the reader itself ends,
# and passes SIGTERM (report and end) on to it.
trap 'forward TERM' TERM
trap 'forward INT' INT
trap 'egress_lost' USR1
mkfifo -m 0600 "$dir/egress" || fail fifo
(
  r=
  trap '[ -z "$r" ] || kill -TERM "$r" 2>/dev/null || :' TERM
  # Only the reader opens the FIFO: once it dies, the proxy's next write fails (EPIPE)
  # and the proxy exits.
  env -i PATH="$PATH" WIDEDOOR_JOB_ID="${WIDEDOOR_JOB_ID:-}" \
    "$NODE" "$HOSTED/egress-reader-bin.js" "$$" "$dir/ready" <"$dir/egress" &
  r=$!
  wait_child "$r"
  kill -USR1 "$$" 2>/dev/null || :
) &
reader=$!
env -i PATH="$PATH" NODE_ENV=production UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-32}" \
  /usr/bin/setpriv --reuid=$EGRESS_UID --regid=$EGRESS_UID --clear-groups --no-new-privs \
  --inh-caps=-all --bounding-set=-all \
  "$NODE" "$HOSTED/egress-bin.js" >"$dir/egress" 2>&1 &
egress=$!
# The reader stops waiting after 10 s; this is the backstop.
tries=0
until [ -e "$dir/ready" ]; do
  [ -z "$pending" ] && [ "$lost" = 0 ] || fail egress
  tries=$((tries + 1))
  [ "$tries" -le 120 ] || fail egress
  sleep 0.1
done
# The FIFO and the files are open or loaded already; nothing needs them by name.
rm -rf "$dir"

# 5. The agent. Any signal so far (pending) or loss of the proxy fails the entry here,
# right before the agent starts. A signal that arrives between the start and `agent=$!`
# is kept in pending and sent on as SIGTERM right after.
[ -z "$pending" ] && [ "$lost" = 0 ] || fail egress
export WIDEDOOR_PROXY_URL="http://127.0.0.1:$PROXY_PORT"
"$NODE" "$HOSTED/agent-bin.js" &
agent=$!
[ -z "$pending" ] || kill -TERM "$agent" 2>/dev/null || :
wait_child "$agent"
code=$status
agent=

# 6. The scan is over: a late SIGUSR1 (the reader ending now) changes nothing.
scan_over=1
stop_child "$reader"
stop_child "$egress"
if [ "$lost" = 1 ] && [ "$code" = 0 ]; then
  code=1
fi
exit "$code"
