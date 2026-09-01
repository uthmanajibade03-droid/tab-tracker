<#
  focus-watcher.ps1 — long-lived foreground-window poller.

  Emits one compact JSON object per line to stdout:

      {"pid":1234,"app":"chrome","title":"GitHub - Chrome","cls":"Chrome_WidgetWin_1","ts":1748000000000}

  `cls` is the foreground window's Win32 class name. It is the only reliable way
  to tell the Windows desktop apart from a real Explorer window: both are
  explorer.exe, but the desktop is Progman/WorkerW while a file browser is
  CabinetWClass. The Node side uses it to report the desktop as "no focus"
  instead of quietly accruing time against File Explorer.

  CADENCE — read this before changing anything on the Node side:

    * The foreground window is sampled every $POLL_MS (125ms), so a switch is
      noticed within an eighth of a second instead of within a second.
    * A line is only PRINTED when the sample differs from the last printed one
      (pid or title), so idling in one window produces no output at all.
    * A heartbeat line is printed at least every $HEARTBEAT_MS (2s) even when
      nothing changed, so the parent can still tell "nothing is happening" from
      "the helper hung". main.js's WATCHER_STALE_MS must stay comfortably above
      this heartbeat; at 5s it tolerates two missed beats.

  Emitting on change rather than on every poll is what makes 8Hz polling free:
  stdout stays as quiet as it was at 1Hz, and the parent does 16x less JSON
  parsing than a naive 8Hz stream would cost it.

  When there is no foreground window (lock screen, desktop transition, UAC
  prompt on the secure desktop) it emits {"pid":0,"app":null,...} rather than
  going silent, so "nothing focused" stays distinguishable from a dead helper.

  WHY ONE LONG-LIVED PROCESS: spawning powershell.exe per sample costs
  ~100-200ms of CPU and thrashes the process table. Paying the startup +
  Add-Type compile cost exactly once and then looping keeps the steady-state
  cost to a couple of P/Invoke calls per tick.

  WHY P/INVOKE INSTEAD OF Get-Process ALONE: Get-Process can tell us about a
  process but not which window the user is actually looking at. Only
  user32!GetForegroundWindow knows that, and it has no PowerShell wrapper,
  so we declare the imports ourselves via Add-Type.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Window titles routinely contain non-ASCII (em dashes, CJK, emoji). Without
# this, the default console codepage mangles them into '?' before Node ever
# sees the bytes, and JSON.parse would receive corrupted-but-valid strings.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class ForegroundWindowInfo
{
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    // The W (wide) variants are required for correct Unicode titles; the ANSI
    // ones would lose characters outside the active codepage.
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLengthW(IntPtr hWnd);

    // The window class is what separates the desktop (Progman / WorkerW) from
    // a real Explorer window (CabinetWClass) -- both belong to explorer.exe.
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int GetClassNameW(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    // Exposed as static fields rather than out-parameters: PowerShell can read
    // static properties trivially, but marshalling [ref] uint through a
    // dynamically compiled type is needlessly awkward.
    public static uint Pid;
    public static string Title;
    public static string Cls;

    public static bool Sample()
    {
        Pid = 0;
        Title = null;
        Cls = null;

        IntPtr h = GetForegroundWindow();
        if (h == IntPtr.Zero) return false;

        uint pid;
        GetWindowThreadProcessId(h, out pid);
        Pid = pid;

        int len = GetWindowTextLengthW(h);
        if (len > 0)
        {
            // +1 for the NUL terminator GetWindowTextW writes.
            StringBuilder sb = new StringBuilder(len + 1);
            if (GetWindowTextW(h, sb, sb.Capacity) > 0) Title = sb.ToString();
        }

        // 256 is the documented ceiling for a registered class name.
        StringBuilder cb = new StringBuilder(256);
        if (GetClassNameW(h, cb, cb.Capacity) > 0) Cls = cb.ToString();

        return pid != 0;
    }
}
"@

$POLL_MS      = 125   # foreground sample interval
$HEARTBEAT_MS = 2000  # max quiet period; keep below main.js WATCHER_STALE_MS

# Resolving a PID to a process name is by far the most expensive part of a
# sample, and at 8Hz the foreground window is unchanged on nearly every one.
# Cache the last resolution and only re-query when the PID changes -- with a
# periodic forced refresh so that PID reuse (Windows recycles PIDs aggressively)
# cannot pin us to a stale name indefinitely.
$RESOLVE_MAX_AGE_TICKS = 240   # ~30s at 125ms per tick
$RESOLVE_RETRY_TICKS   = 8     # ~1s, used when the last lookup came back empty
$cachedPid  = -1
$cachedName = $null
$ticksSinceResolve = 0

# Last line actually written to stdout. -1 is unreachable as a real PID, so the
# first pass through the loop always emits.
$emittedPid   = -1
$emittedTitle = $null
$emittedName  = $null
$emittedCls   = $null
$lastEmitAt   = [long]0

<#
  THE ONE INVARIANT: every iteration reaches the emit block, and the emit block
  fires whenever a change is seen OR the heartbeat is due. Nothing above it may
  `continue`, `break`, or throw past it.

  This matters far more under change-only emission than it did at 1Hz. When the
  helper printed every second, a skipped iteration was a momentary glitch that
  the next line corrected. Now a skipped emission is indistinguishable from
  "nothing changed", so a silent failure would freeze the pill on a stale app
  forever -- which is exactly what happened when a closed application's PID
  made Get-Process throw inside the sampling try block. Hence three separate,
  narrow try blocks below rather than one wide one.
#>
while ($true) {
    $procId = 0
    $title  = $null
    $cls    = $null
    $name   = $null

    # --- 1. sample the foreground window -----------------------------------
    try {
        [void][ForegroundWindowInfo]::Sample()
        $procId = [int][ForegroundWindowInfo]::Pid
        $title  = [ForegroundWindowInfo]::Title
        $cls    = [ForegroundWindowInfo]::Cls
    } catch {
        # A window can vanish between GetForegroundWindow and the reads above.
        # Report the tick as "nothing focused" and keep going.
        $procId = 0
        $title  = $null
        $cls    = $null
    }

    # --- 2. resolve the PID to a process name ------------------------------
    # Its own try: a failed lookup must cost us the NAME, never the line.
    if ($procId -gt 0) {
        try {
            # Re-check an unresolved PID quickly (the process may be starting),
            # but an established one only every ~30s, to catch PID reuse.
            $maxAge = if ($null -eq $cachedName) { $RESOLVE_RETRY_TICKS } else { $RESOLVE_MAX_AGE_TICKS }
            if ($procId -ne $cachedPid -or $ticksSinceResolve -ge $maxAge) {
                $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
                $cachedName = if ($proc) { $proc.ProcessName } else { $null }
                $cachedPid  = $procId
                $ticksSinceResolve = 0
            }
            $name = $cachedName
            $ticksSinceResolve++
        } catch {
            # The process exited between the two calls, or it is protected and
            # denies query access. Drop the cache so the next tick re-resolves
            # rather than pinning a name that may already be dead.
            $name = $null
            $cachedPid  = -1
            $cachedName = $null
        }
    }

    # --- 3. emit -----------------------------------------------------------
    # Deliberately outside both try blocks above.
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

    # Compare against the last EMITTED sample, not the last one taken: that is
    # what makes a run of identical samples collapse into a single line. `name`
    # is part of the comparison because it can change while the PID does not --
    # a process dying under a still-focused window is exactly that case.
    $changed = ($procId -ne $emittedPid) -or
               ($title  -ne $emittedTitle) -or
               ($name   -ne $emittedName) -or
               ($cls    -ne $emittedCls)

    # Unconditional: whatever else went wrong, the parent hears from us within
    # $HEARTBEAT_MS and re-syncs to the truth.
    $heartbeat = ($nowMs - $lastEmitAt) -ge $HEARTBEAT_MS

    if ($changed -or $heartbeat) {
        $payload = [ordered]@{
            pid   = $procId
            app   = $name
            title = $title
            cls   = $cls
            ts    = $nowMs
        }

        try {
            [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress))
            # PowerShell buffers stdout when it is a pipe rather than a console.
            # Without an explicit flush the parent would receive ticks in bursts
            # (or not at all), which would look exactly like a hung helper.
            [Console]::Out.Flush()
        } catch {
            # Broken pipe: the parent is gone. Exit quietly rather than spinning
            # forever as an orphan writing into the void.
            exit 0
        }

        $emittedPid   = $procId
        $emittedTitle = $title
        $emittedName  = $name
        $emittedCls   = $cls
        $lastEmitAt   = $nowMs
    }

    Start-Sleep -Milliseconds $POLL_MS
}
