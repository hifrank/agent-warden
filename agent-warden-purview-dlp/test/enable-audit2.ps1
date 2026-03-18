# Step 1: Enable organization customization, Step 2: Enable audit log
Import-Module ExchangeOnlineManagement
Connect-ExchangeOnline

Write-Output "=== Step 1: Enable Organization Customization ==="
try {
    Enable-OrganizationCustomization -ErrorAction Stop
    Write-Output "Organization customization enabled."
} catch {
    if ($_.Exception.Message -like "*already been enabled*") {
        Write-Output "Organization customization already enabled."
    } else {
        Write-Output "Error: $_"
    }
}

Write-Output "`n=== Step 2: Enable Unified Audit Log ==="
try {
    Set-AdminAuditLogConfig -UnifiedAuditLogIngestionEnabled $true -ErrorAction Stop
    Write-Output "Unified audit log enabled."
} catch {
    Write-Output "Error enabling audit log: $_"
    Write-Output "Note: After Enable-OrganizationCustomization, it may take up to 24 hours to propagate."
    Write-Output "Retry this script later if you get an error."
}

Write-Output "`n=== Verify ==="
Get-AdminAuditLogConfig | Select-Object UnifiedAuditLogIngestionEnabled | Format-List
