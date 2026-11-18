$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class CredReadHelper2 {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr credential);
}
'@

$ptr = [IntPtr]::Zero
if (-not [CredReadHelper2]::CredRead('Supabase CLI:supabase', 1, 0, [ref]$ptr)) {
  throw 'CredRead failed for Supabase CLI:supabase'
}
$cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][CredReadHelper2+CREDENTIAL])
$blob = New-Object byte[] $cred.CredentialBlobSize
[Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $blob, 0, $cred.CredentialBlobSize)
[CredReadHelper2]::CredFree($ptr)
$token = [Text.Encoding]::UTF8.GetString($blob).Trim()
$blob = $null

$sqlPath = $args[0]
$sql = [System.IO.File]::ReadAllText($sqlPath, [Text.Encoding]::UTF8)
$endAgoHours = 0
$windowHours = 24
if ($args.Count -gt 1) { $endAgoHours = [int]$args[1] }
if ($args.Count -gt 2) { $windowHours = [int]$args[2] }
$start = (Get-Date).ToUniversalTime().AddHours(-($endAgoHours + $windowHours)).ToString("yyyy-MM-ddTHH:mm:ssZ")
$end = (Get-Date).ToUniversalTime().AddHours(-$endAgoHours).ToString("yyyy-MM-ddTHH:mm:ssZ")
$uri = 'https://api.supabase.com/v1/projects/mzdprnvazllhfaxteeyk/analytics/endpoints/logs?sql=' + [System.Uri]::EscapeDataString($sql) +
       '&iso_timestamp_start=' + $start + '&iso_timestamp_end=' + $end

try {
  $resp = Invoke-RestMethod -Uri $uri -Method Get -Headers @{ Authorization = "Bearer $token" }
  if ($null -eq $resp) { Write-Output 'OK (empty result)' } else { $resp | ConvertTo-Json -Depth 8 -Compress }
} catch {
  Write-Output ("HTTP_ERROR: " + $_.Exception.Message)
  if ($_.ErrorDetails) { Write-Output $_.ErrorDetails.Message }
}
