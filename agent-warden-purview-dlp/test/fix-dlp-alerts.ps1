# All-in-one: Enable org customization + audit log + verify
# Run: pwsh -File test/fix-dlp-alerts.ps1
Import-Module ExchangeOnlineManagement

Write-Output "Connecting to Exchange Online..."
Connect-ExchangeOnline -ShowBanner:$false

Write-Output "`n[1] Enable-OrganizationCustomization"
try {
    Enable-OrganizationCustomization -ErrorAction Stop
    Write-Output "    OK — organization customization enabled"
} catch {
    $msg = $_.Exception.Message
    if ($msg -like "*already been enabled*") {
        Write-Output "    OK — already enabled"
    } else {
        Write-Output "    WARN: $msg"
    }
}

Write-Output "`n[2] Set-AdminAuditLogConfig -UnifiedAuditLogIngestionEnabled `$true"
try {
    Set-AdminAuditLogConfig -UnifiedAuditLogIngestionEnabled $true -ErrorAction Stop
    Write-Output "    OK — unified audit log enabled"
} catch {
    $msg = $_.Exception.Message
    Write-Output "    ERROR: $msg"
    if ($msg -like "*Enable-OrganizationCustomization*") {
        Write-Output "    NOTE: Org customization takes up to 4 hours to propagate. Retry later."
    }
}

Write-Output "`n[3] Verify"
$cfg = Get-AdminAuditLogConfig
Write-Output "    UnifiedAuditLogIngestionEnabled: $($cfg.UnifiedAuditLogIngestionEnabled)"

Disconnect-ExchangeOnline -Confirm:$false
Write-Output "`nDone."
