# Run ad-hoc SQL against the STAGING Supabase project (timor-shop-staging,
# bszipcuuxqxrhsexdevi) via the Management API — the staging twin of
# apply-migration.ps1 (which is hardcoded to prod). Needed because the
# Postgres pooler is unreachable from some dev networks; api.supabase.com
# works (through the local proxy).
#
# Usage:  powershell -NoProfile -File scripts/staging-sql.ps1 path\to\file.sql
# SELECT results print as JSON. Never point this at prod.
$ErrorActionPreference = 'Stop'

$sqlPath = $args[0]
if (-not $sqlPath) { throw 'Usage: staging-sql.ps1 <sql-file>' }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class CredReadHelper {
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
if (-not [CredReadHelper]::CredRead('Supabase CLI:supabase', 1, 0, [ref]$ptr)) {
  throw 'CredRead failed for Supabase CLI:supabase'
}
$cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][CredReadHelper+CREDENTIAL])
$blob = New-Object byte[] $cred.CredentialBlobSize
[Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $blob, 0, $cred.CredentialBlobSize)
[CredReadHelper]::CredFree($ptr)
$token = [Text.Encoding]::UTF8.GetString($blob).Trim()
$blob = $null

$sql = [System.IO.File]::ReadAllText($sqlPath, [Text.Encoding]::UTF8)
$json = @{ query = $sql } | ConvertTo-Json -Compress
$body = [Text.Encoding]::UTF8.GetBytes($json)

$resp = Invoke-RestMethod `
  -Uri 'https://api.supabase.com/v1/projects/bszipcuuxqxrhsexdevi/database/query' `
  -Method Post `
  -Headers @{ Authorization = "Bearer $token"; 'Content-Type' = 'application/json' } `
  -Body $body `
  -Proxy 'http://127.0.0.1:7890'

if ($null -eq $resp) { Write-Output 'OK (empty result)' } else { $resp | ConvertTo-Json -Depth 8 -Compress }
