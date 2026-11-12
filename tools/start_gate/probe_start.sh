#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Start gate, steps (d) to (f): the real programs of the installed package, run by check.sh in the clean container.
#   (d) `cetli`, the first start: it registers on the session bus, the actions of the application are there, the note
#       window of the first note is open (its actions are on the bus), the note is on disk, the program runs for 2 s and
#       ends with exit status 0 on SIGTERM;
#   (e) `cetli --autostart`, what the login entry runs: the note that was left behind opens again, the same SIGTERM;
#   (f) `cetli-sync status`: one line on standard output, the closing line of the contract (event "result"), exit status 0.
# There is no desktop in a container, so (d) and (e) get a private D-Bus session bus (no service directory is listed,
# so the bus starts no program of the installed GNOME packages) and a headless mutter, which the package pulls in with
# gnome-shell, as the Wayland display. The program is the real one, under gjs, on a private HOME. A log with `start
# failed`, `JS ERROR` or an unhandled promise rejection is a failure whatever the exit status was; the warnings of the
# graphics stack of a machine with no GPU are not.
# usage: bash probe_start.sh
# Prints `START-GATE <step> PASS|FAIL <detail>` and the log of each program; exits 1 when a step failed.
set -u
shopt -s nullglob      # a folder with no note file gives an empty list, not the pattern

limit=${START_GATE_TIMEOUT:-30}      # seconds to wait for each thing
settle=${START_GATE_SETTLE:-2}       # seconds a program must run before SIGTERM; one that ends sooner has not started
app_id=io.github.trensoft.cetli
app_path=/io/github/trensoft/cetli
tmp=$(mktemp -d "${TMPDIR:-/tmp}/start-gate-XXXXXX")
status=0
pids=()

cleanup() {
    local p
    for p in ${pids[@]+"${pids[@]}"}; do
        kill "$p" 2>/dev/null
    done
    wait 2>/dev/null
    rm -rf "$tmp"
}
trap cleanup EXIT

pass() { echo "START-GATE $1 PASS $2"; }
fail() { echo "START-GATE $1 FAIL $2"; status=1; }

# the private session: home, runtime directory, bus
export HOME=$tmp/home
export XDG_RUNTIME_DIR=$tmp/xdg
export LANG=C.UTF-8 GSETTINGS_BACKEND=memory GTK_A11Y=none GDK_BACKEND=wayland
unset LANGUAGE LC_ALL LC_MESSAGES XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME
mkdir -p "$HOME"
mkdir -m 700 "$XDG_RUNTIME_DIR"
notes=$HOME/.local/share/cetli/notes

# waits until `$1` has ended or `$limit` seconds are over; 0 when it has ended
gone() {
    local i
    for ((i = 0; i < limit * 10; i++)); do
        kill -0 "$1" 2>/dev/null || return 0
        sleep 0.1
    done
    return 1
}

start_display() {
    cat > "$tmp/bus.conf" <<EOC
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:path=$tmp/session.sock</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
EOC
    dbus-daemon --nofork --config-file="$tmp/bus.conf" > "$tmp/bus.log" 2>&1 &
    pids+=($!)
    local i
    for ((i = 0; i < 100; i++)); do
        [ -S "$tmp/session.sock" ] && break
        sleep 0.1
    done
    [ -S "$tmp/session.sock" ] || { echo "the session bus did not come up"; return 1; }
    export DBUS_SESSION_BUS_ADDRESS=unix:path=$tmp/session.sock
    mutter --headless --wayland --no-x11 --virtual-monitor 1280x720 --wayland-display=gate-wl > "$tmp/mutter.log" 2>&1 &
    local mpid=$!
    pids+=("$mpid")
    for ((i = 0; i < 100; i++)); do
        [ -S "$XDG_RUNTIME_DIR/gate-wl" ] && break
        kill -0 "$mpid" 2>/dev/null || break
        sleep 0.1
    done
    if [ ! -S "$XDG_RUNTIME_DIR/gate-wl" ]; then
        echo "mutter did not come up:"
        tail -n 10 "$tmp/mutter.log"
        return 1
    fi
    export WAYLAND_DISPLAY=gate-wl
}

# the actions that the program (or one of its windows) offers on the session bus
actions() { gdbus call --session --timeout 5 --dest "$app_id" --object-path "$1" --method org.gtk.Actions.List 2>/dev/null; }

# waits until the object path `$1` offers the action `$2`; 0 found, 1 not within `$limit` s, 2 the program `$3` ended
wait_action() {
    local i
    for ((i = 0; i < limit * 5; i++)); do
        kill -0 "$3" 2>/dev/null || return 2
        case "$(actions "$1")" in *"'$2'"*) return 0 ;; esac
        sleep 0.2
    done
    return 1
}

show_log() {
    echo "---- log of $1 ----"
    head -n 60 "$2"
    echo "---- end of the log of $1 ----"
}

# the closing checks of a program run with `cetli`: $1 step, $2 pid, $3 log
finish() {
    local step=$1 pid=$2 log=$3 code
    sleep "$settle"
    if ! kill -0 "$pid" 2>/dev/null; then
        wait "$pid"
        code=$?
        fail "$step" "the program ended by itself with exit status $code within ${settle} s"
        return
    fi
    kill -TERM "$pid"
    if ! gone "$pid"; then
        kill -KILL "$pid"
        fail "$step" "the program did not end within ${limit} s of SIGTERM"
        return
    fi
    wait "$pid"
    code=$?
    if [ "$code" -ne 0 ]; then
        fail "$step" "the program ended with exit status $code on SIGTERM"
    elif grep -Eq 'start failed|JS ERROR|Unhandled promise rejection' "$log"; then
        fail "$step" "the program ended with exit status 0, but its log has an error of the start"
    else
        pass "$step" "$4, ran ${settle} s, ended with exit status 0 on SIGTERM"
    fi
}

# why a wait for `$2` (the program `$3`) ended without success: `$1` is the return code of wait_action
why_not() {
    local code
    if [ "$1" -eq 2 ]; then
        wait "$3"
        code=$?
        echo "the program ended with exit status $code"
    else
        echo "$2 not on the bus within ${limit} s"
    fi
}

# starts `cetli` with the arguments `$3...` and waits for its window; `$1` step, `$2` the text of PASS
run_cetli() {
    local step=$1 text=$2 log=$tmp/cetli-$1.log pid rc
    shift 2
    cetli "$@" > "$log" 2>&1 &
    pid=$!
    pids+=("$pid")
    wait_action "$app_path" new-note "$pid"
    rc=$?
    if [ "$rc" -ne 0 ]; then
        fail "$step" "cetli${*:+ $*} did not come up: $(why_not "$rc" 'the action new-note' "$pid")"
        kill "$pid" 2>/dev/null
        show_log "cetli${*:+ $*}" "$log"
        return
    fi
    wait_action "$app_path/window/1" delete "$pid"
    rc=$?
    if [ "$rc" -ne 0 ]; then
        fail "$step" "cetli${*:+ $*} has no note window: $(why_not "$rc" 'the action delete of window 1' "$pid")"
        kill "$pid" 2>/dev/null
        show_log "cetli${*:+ $*}" "$log"
        return
    fi
    local files=("$notes"/*.json)
    if [ "${#files[@]}" -ne 1 ] || [ ! -s "${files[0]}" ]; then
        fail "$step" "expected one note file in the notes folder, found ${#files[@]}"
        kill "$pid" 2>/dev/null
        show_log "cetli${*:+ $*}" "$log"
        return
    fi
    finish "$step" "$pid" "$log" "$text"
    show_log "cetli${*:+ $*}" "$log"
}

if start_display; then
    run_cetli d "the first start registered, opened its first note window, the note is on disk"
    run_cetli e "the start at login (--autostart) opened the note that was left behind" --autostart
else
    fail d "no display for the program"
    fail e "no display for the program"
fi

# (f) the engine of the sync window, in a home of its own: no sync program is installed (no weak dependencies)
mkdir -p "$tmp/home-sync"
sync_out=$(HOME=$tmp/home-sync timeout "$limit" cetli-sync status 2> "$tmp/sync.err")
sync_code=$?
if [ "$sync_code" -eq 0 ] && [ "$(printf '%s\n' "$sync_out" | wc -l)" -eq 1 ] && printf '%s' "$sync_out" | grep -Eq '^\{"v":1,"event":"result",'; then
    pass f "cetli-sync status gave its one closing line: $(printf '%s' "$sync_out" | cut -c1-80)..."
else
    fail f "cetli-sync status: exit status $sync_code, standard output: $(printf '%s' "$sync_out" | cut -c1-160), standard error: $(head -c 300 "$tmp/sync.err")"
fi
exit "$status"
