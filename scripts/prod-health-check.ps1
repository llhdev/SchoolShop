# PROD health check - read-only guards against the Nov 2026 outage class:
#   1. supabase_realtime publication lost its tables -> orders vanish from admin
#   2. Telegram delivery failures (WEBPAGE_CURL_FAILED / IMAGE_PROCESS_FAILED)
#   3. Orders placed but telegram-order-notify never invoked
#   4. telegram-order-notify not deployed/ACTIVE on prod
#
# Run after every migration/deploy, or any time:
#   powershell -NoProfile -File scripts/prod-health-check.ps1 [-WindowHours 24]
#
# Uses the Supabase Management API token stored by the Supabase CLI in Windows
# Credential Manager (same pattern as apply-migration.ps1 / query-logs.ps1).
# Exit code 0 = all checks pass, 1 = at least one FAILURE.

param([int]$WindowHours = 24)

$ErrorActionPreference = 'Stop'
$projectRef = 'mzdprnvazllhfaxteeyk'
if ($WindowHours -gt 24) { $WindowHours = 24 }  # logs endpoint caps the window at 24h

$script:failures = 0
$script:warnings = 0

function Report([string]$name, [bool]$ok, [string]$detail, [bool]$warnOnly = $false) {
  if ($ok) {
    Write-Output ("PASS  {0} - {1}" -f $name, $detail)
  } elseif ($warnOnly) {
    $script:warnings++
    Write-Output ("WARN  {0} - {1}" -f $name, $detail)
  } else {
    $script:failures++
    Write-Output ("FAIL  {0} - {1}" -f $name, $detail)
  }
}

# --- Management API token from the Supabase CLI credential ---
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class CredReadHelperHC {
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
if (-not [CredReadHelperHC]::CredRead('Supabase CLI:supabase', 1, 0, [ref]$ptr)) {
  throw 'CredRead failed for Supabase CLI:supabase - is the Supabase CLI logged in?'
}
$cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][CredReadHelperHC+CREDENTIAL])
$blob = New-Object byte[] $cred.CredentialBlobSize
[Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $blob, 0, $cred.CredentialBlobSize)
[CredReadHelperHC]::CredFree($ptr)
$token = [Text.Encoding]::UTF8.GetString($blob).Trim()
$blob = $null
$headers = @{ Authorization = "Bearer $token" }

# --- helpers ---
function Invoke-MgmtQuery([string]$sql) {
  $json = @{ query = $sql } | ConvertTo-Json -Compress
  $body = [Text.Encoding]::UTF8.GetBytes($json)
  $resp = Invoke-RestMethod `
    -Uri "https://api.supabase.com/v1/projects/$projectRef/database/query" `
    -Method Post -Headers $headers -ContentType 'application/json' -Body $body
  return $resp
}

function Invoke-LogsQuery([string]$sql) {
  $start = (Get-Date).ToUniversalTime().AddHours(-$WindowHours).ToString('yyyy-MM-ddTHH:mm:ssZ')
  $end = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  $uri = "https://api.supabase.com/v1/projects/$projectRef/analytics/endpoints/logs?sql=" +
         [System.Uri]::EscapeDataString($sql) +
         "&iso_timestamp_start=$start&iso_timestamp_end=$end"
  # The analytics endpoint returns HTTP 200 with {"error": ...} on bad SQL.
  $resp = Invoke-RestMethod -Uri $uri -Method Get -Headers $headers
  if ($resp.error) { throw "logs query error: $($resp.error)" }
  return $resp.result
}

Write-Output ("=== PROD health check ({0}) - window: last {1}h ===" -f $projectRef, $WindowHours)

# --- 1) realtime publication must contain exactly the sync'd tables ---
try {
  $rows = Invoke-MgmtQuery "select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by tablename"
  $actual = @($rows | ForEach-Object { $_.tablename })
  $expected = @('categories', 'orders', 'payment_verifications', 'products', 'profiles')
  $missing = $expected | Where-Object { $actual -notcontains $_ }
  $extra = $actual | Where-Object { $expected -notcontains $_ }
  if ($missing.Count -eq 0 -and $extra.Count -eq 0) {
    Report 'realtime publication' $true ("tables: {0}" -f ($actual -join ', '))
  } else {
    Report 'realtime publication' $false ("tables: [{0}]; missing: [{1}]; unexpected: [{2}] - re-apply supabase/migrations/055_enable_realtime.sql" -f ($actual -join ', '), ($missing -join ', '), ($extra -join ', '))
  }
} catch {
  Report 'realtime publication' $false "query failed: $($_.Exception.Message)"
}

# --- 2) zero Telegram delivery failures in the window ---
try {
  $rows = Invoke-LogsQuery @"
select count(*) as n, max(timestamp) as latest from logs
where source = 'function_logs'
  and (event_message like '%sendMediaGroup failed%'
    or event_message like '%sendPhoto failed%'
    or event_message like '%sendDocument failed%'
    or event_message like '%sendMessage failed%'
    or event_message like '%IMAGE_PROCESS_FAILED%'
    or event_message like '%WEBPAGE_CURL_FAILED%')
"@
  $n = [int]$rows[0].n
  Report 'telegram delivery failures' ($n -eq 0) ("{0} failure lines in last {1}h (latest: {2})" -f $n, $WindowHours, $rows[0].latest)
} catch {
  Report 'telegram delivery failures' $false "logs query failed: $($_.Exception.Message)"
}

# --- 2b) degraded deliveries (proof download failures) are warnings, not failures ---
try {
  $rows = Invoke-LogsQuery @"
select count(*) as n from logs
where source = 'function_logs'
  and event_message like '%proof download%fail%'
"@
  $n = [int]$rows[0].n
  Report 'proof download fallback' ($n -eq 0) ("{0} proof download failures in last {1}h (proof rode as URL)" -f $n, $WindowHours) $true
} catch {
  Report 'proof download fallback' $false "logs query failed: $($_.Exception.Message)" $true
}

# --- 3) every order must have triggered a telegram-order-notify invocation ---
try {
  $ordersRows = Invoke-MgmtQuery ("select count(*) as n from orders where created_at > now() - interval '{0} hours'" -f $WindowHours)
  $orders = [int]$ordersRows[0].n
  # Function invocations log to function_edge_logs (edge_logs has no /functions/ entries).
  $rows = Invoke-LogsQuery @"
select count(*) as n from logs
where source = 'function_edge_logs'
  and event_message like 'POST%telegram-order-notify%'
"@
  $calls = [int]$rows[0].n
  if ($orders -eq 0) {
    Report 'notify coverage' $true ("0 orders in last {0}h - nothing to notify" -f $WindowHours)
  } elseif ($calls -eq 0) {
    Report 'notify coverage' $false ("{0} orders but ZERO telegram-order-notify invocations - client call or function is broken" -f $orders)
  } elseif ($calls -lt $orders) {
    Report 'notify coverage' $false ("{0} orders but only {1} notify invocations" -f $orders, $calls) $true
  } else {
    Report 'notify coverage' $true ("{0} orders, {1} notify invocations" -f $orders, $calls)
  }
} catch {
  Report 'notify coverage' $false "query failed: $($_.Exception.Message)"
}

# --- 4) telegram-order-notify deployed and ACTIVE ---
try {
  $fn = Invoke-RestMethod `
    -Uri "https://api.supabase.com/v1/projects/$projectRef/functions/telegram-order-notify" `
    -Method Get -Headers $headers
  $ok = ($fn.status -eq 'ACTIVE')
  Report 'function deployed' $ok ("telegram-order-notify v{0}, status={1}, updated={2}" -f $fn.version, $fn.status, $fn.updated_at)
} catch {
  Report 'function deployed' $false "lookup failed: $($_.Exception.Message)"
}

Write-Output ("=== {0} failure(s), {1} warning(s) ===" -f $script:failures, $script:warnings)
if ($script:failures -gt 0) { exit 1 }
exit 0
