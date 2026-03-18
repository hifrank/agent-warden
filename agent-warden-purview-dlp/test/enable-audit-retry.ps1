# Connect to both EXO and S&C, enable audit
Import-Module ExchangeOnlineManagement

Write-Output "Connecting to Exchange Online..."
Connect-ExchangeOnline -ShowBanner:$false

Write-Output "`n=== Org customization check ==="
try {
    Get-OrganizationConfig | Select-Object IsDehydrated | Format-List
} catch {
    Write-Output "Cannot check: $_"
}

Write-Output "=== Enable audit ==="
$maxRetries = 3
$retryDelay = 30
for ($i = 1; $i -le $maxRetries; $i++) {
    Write-Output "Attempt $i of $maxRetries..."
    try {
        Set-AdminAuditLogConfig -UnifiedAuditLogIngestionEnabled $true -ErrorAction Stop
        Write-Output "SUCCESS — unified audit log enabled!"
        break
    } catch {
        $msg = $_.Exception.Message
        Write-Output "  Failed: $msg"
        if ($i -lt $maxRetries) {
            Write-Output "  Waiting ${retryDelay}s before retry..."
            Start-Sleep -Seconds $retryDelay
        }
    }
}

Write-Output "`n=== Final Status ==="
$cfg = Get-AdminAuditLogConfig
Write-Output "UnifiedAuditLogIngestionEnabled: $($cfg.UnifiedAuditLogIngestionEnabled)"

Disconnect-ExchangeOnline -Confirm:$false
Write-Output "Done."
