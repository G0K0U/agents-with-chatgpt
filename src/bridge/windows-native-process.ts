/**
 * WMI sometimes returns null ExecutablePath/CommandLine for a live Node
 * process even when the current user can open it with PROCESS_QUERY_LIMITED_INFORMATION.
 * Keep the fallback in the compiled tree so immutable releases use the same
 * inspector as source runs. The OS creation time is compared with WMI before
 * a native result is accepted, preventing a PID reuse between both reads.
 */
export const WINDOWS_PROCESS_QUERY = String.raw`
$OutputEncoding = [System.Text.UTF8Encoding]::new()
$rows = @(Get-CimInstance -ClassName Win32_Process |
  Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,CreationDate,Name)
$missing = @($rows | Where-Object {
  $_.Name -ieq 'node.exe' -and (-not $_.ExecutablePath -or -not $_.CommandLine)
})
if ($missing.Count -gt 0) {
  try {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class A2CNativeProcessInfo {
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern bool QueryFullProcessImageNameW(IntPtr handle, uint flags, StringBuilder image, ref uint length);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
  [DllImport("ntdll.dll")]
  private static extern int NtQueryInformationProcess(IntPtr handle, int kind, IntPtr output, int length, out int returned);

  public static string[] Inspect(int pid) {
    IntPtr handle = OpenProcess(0x1000, false, pid);
    if (handle == IntPtr.Zero) return null;
    try {
      var image = new StringBuilder(32768);
      uint length = 32768;
      if (!QueryFullProcessImageNameW(handle, 0, image, ref length)) return null;
      long created, exited, kernel, user;
      if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) return null;
      const int capacity = 65536;
      IntPtr output = Marshal.AllocHGlobal(capacity);
      try {
        int returned;
        if (NtQueryInformationProcess(handle, 60, output, capacity, out returned) != 0 || returned < 16) return null;
        int bytes = (int)(ushort)Marshal.ReadInt16(output, 0);
        IntPtr pointer = Marshal.ReadIntPtr(output, 8);
        long begin = output.ToInt64();
        long text = pointer.ToInt64();
        if (bytes <= 0 || bytes % 2 != 0 || text < begin + 16 || text > begin + capacity - bytes) return null;
        string command = Marshal.PtrToStringUni(pointer, bytes / 2);
        if (String.IsNullOrWhiteSpace(command)) return null;
        return new [] { image.ToString(), command, DateTime.FromFileTimeUtc(created).ToString("o") };
      } finally {
        Marshal.FreeHGlobal(output);
      }
    } finally {
      CloseHandle(handle);
    }
  }
}
'@
    foreach ($row in $missing) {
      $native = [A2CNativeProcessInfo]::Inspect([int]$row.ProcessId)
      if (-not $native) { continue }
      $nativeStart = [datetime]::Parse($native[2]).ToUniversalTime()
      $wmiStart = ([datetime]$row.CreationDate).ToUniversalTime()
      if ([Math]::Abs(($nativeStart - $wmiStart).TotalMilliseconds) -gt 1000) { continue }
      if ($row.ExecutablePath -and $row.ExecutablePath -ine $native[0]) { continue }
      if ($row.CommandLine -and $row.CommandLine -cne $native[1]) { continue }
      $row.ExecutablePath = $native[0]
      $row.CommandLine = $native[1]
    }
  } catch {
    # Native inspection is an optional proof source. Incomplete rows stay
    # unavailable and all lifecycle callers continue to fail closed.
  }
}
$rows | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,CreationDate |
  ConvertTo-Json -Compress -Depth 3
`;
