# Alternative: try enabling audit via S&C PowerShell (IPPSSession)
Import-Module ExchangeOnlineManagement

Write-Output "Connecting to Security & Compliance..."
Connect-IPPSSession -ShowBanner:$false

Write-Output "`n[1] Get current audit config"
try {
    $cfg = Get-AdminAuditLogConfig -ErrorAction Stop
    Write-Output "    UnifiedAuditLogIngestionEnabled: $($cfg.UnifiedAuditLogIngestionEnabled)"
} catch {
    Write-Output "    Cannot get config via S&C: $_"
}

Write-Output "`n[2] Try enabling via S&C"
try {
    Set-AdminAuditLogConfig -UnifiedAuditLogIngestionEnabled $true -ErrorAction Stop
    Write-Output "    OK — unified audit log enabled via S&C"
} catch {
    Write-Output "    Error: $_"
}

Write-Output "`n[3] Verify"
try {
    $cfg2 = Get-AdminAuditLogConfig -ErrorAction Stop
    Write-Output "    UnifiedAuditLogIngestionEnabled: $($cfg2.UnifiedAuditLogIngestionEnabled)"
} catch {
    Write-Output "    Cannot verify: $_"
}
