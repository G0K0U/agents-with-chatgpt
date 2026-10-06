import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
export const runtimeGeneration = randomUUID();
let bootIdentity: string | null | undefined;
/** Kernel boot GUID, independent of PID reuse, wall-clock changes and logon. */
export function currentBootId(): string | null {
  if (bootIdentity !== undefined) return bootIdentity;
  bootIdentity = null;
  if (process.platform === "linux") {
    try { bootIdentity = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch { /* unknown */ }
  } else if (process.platform === "win32") {
    const script = String.raw`Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class A2CBootIdentity {
 [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int kind, IntPtr data, int size, out int returned);
 public static string Read() {
  IntPtr data=Marshal.AllocHGlobal(64);
  try { int returned; if(NtQuerySystemInformation(90,data,64,out returned)!=0 || returned<16) return null;
   byte[] id=new byte[16]; Marshal.Copy(data,id,0,16); return new Guid(id).ToString();
  } finally { Marshal.FreeHGlobal(data); }
 }
}
'@
[A2CBootIdentity]::Read()`;
    const binary = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    try {
      const result = spawnSync(binary, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 5000, windowsHide: true });
      const value = result.stdout?.trim();
      if (result.status === 0 && /^[a-f0-9-]{36}$/i.test(value)) bootIdentity = value;
    } catch { /* unknown boot must retain leases, never break task/health reads */ }
  }
  return bootIdentity;
}
