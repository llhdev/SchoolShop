$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class CredReadHelper4 {
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
if (-not [CredReadHelper4]::CredRead('Supabase CLI:supabase', 1, 0, [ref]$ptr)) {
  throw 'CredRead failed for Supabase CLI:supabase'
}
$cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][CredReadHelper4+CREDENTIAL])
$blob = New-Object byte[] $cred.CredentialBlobSize
[Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $blob, 0, $cred.CredentialBlobSize)
[CredReadHelper4]::CredFree($ptr)
$token = [Text.Encoding]::UTF8.GetString($blob).Trim()
$blob = $null

$anon = ((Invoke-RestMethod -Uri 'https://api.supabase.com/v1/projects/mzdprnvazllhfaxteeyk/api-keys' -Headers @{ Authorization = "Bearer $token" }) | Where-Object { $_.name -eq 'anon' } | Select-Object -First 1).api_key
$anon = "$anon".Trim()

# $args[0] = REST path with query string, e.g. "orders?select=id&limit=5"
$uri = 'https://mzdprnvazllhfaxteeyk.supabase.co/rest/v1/' + $args[0]
$headers = @{ apikey = $anon; Authorization = "Bearer $anon" }
foreach ($h in $args[1..($args.Count-1)]) {
  if ($h -match '^([^:]+):\s*(.*)$') { $headers[$matches[1]] = $matches[2] }
}
try {
  $resp = Invoke-WebRequest -Uri $uri -Headers $headers -Method Get -UseBasicParsing
  Write-Output ("HTTP " + $resp.StatusCode)
  Write-Output $resp.Content
} catch {
  Write-Output ("HTTP_ERROR: " + $_.Exception.Message)
  if ($_.ErrorDetails) { Write-Output $_.ErrorDetails.Message }
}
