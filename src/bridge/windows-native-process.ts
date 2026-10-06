/**
 * User-session process identity without WMI/CIM or administrator privileges.
 * Image, command line and creation time are read from the same limited-query
 * handle. Inaccessible processes remain unproven; callers must fail closed.
 */
export const WINDOWS_PROCESS_QUERY = String.raw`
$OutputEncoding = [System.Text.UTF8Encoding]::new()
$rows = @()
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
    foreach ($processRow in [System.Diagnostics.Process]::GetProcesses()) {
      $native = [A2CNativeProcessInfo]::Inspect([int]$processRow.Id)
      if (-not $native) { continue }
      $rows += [pscustomobject]@{
        ProcessId = $processRow.Id
        ExecutablePath = $native[0]
        CommandLine = $native[1]
        CreationDate = [datetime]::Parse($native[2]).ToUniversalTime()
      }
    }
} catch {
  # Inventory failure must not masquerade as an empty machine.
  exit 1
}
$rows | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,CreationDate |
  ConvertTo-Json -Compress -Depth 3
`;
