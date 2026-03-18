# Enable unified auditing on the E5 tenant, then verify DLP alert pipeline
Import-Module ExchangeOnlineManagement
Connect-ExchangeOnline

Write-Output "=== Current Audit Status ==="
Get-AdminAuditLogConfig | Select-Object UnifiedAuditLogIngestionEnabled | Format-List

Write-Output "=== Enabling Unified Audit Log Ingestion ==="
try {
    Set-AdminAuditLogConfig -UnifiedAuditLogIngestionEnabled $true
    Write-Output "UnifiedAuditLogIngestionEnabled set to True."
} catch {
    Write-Output "Error enabling audit ingestion: $_"
}

Write-Output "`n=== Enabling Organization Customization (prerequisite) ==="
try {
    Enable-OrganizationCustomization -ErrorAction SilentlyContinue
    Write-Output "Organization customization enabled (or already enabled)."
} catch {
    Write-Output "Already enabled or not needed: $_"
}

Write-Output "`n=== Verify ==="
Get-AdminAuditLogConfig | Select-Object UnifiedAuditLogIngestionEnabled | Format-List

Write-Output "`n=== Test Audit Search ==="
$startDate = (Get-Date).AddDays(-1).ToString("MM/dd/yyyy")
$endDate = (Get-Date).AddDays(1).ToString("MM/dd/yyyy")
try {
    $test = Search-UnifiedAuditLog -StartDate $startDate -EndDate $endDate -ResultSize 1
    if ($test) {
        Write-Output "Audit search WORKING. Found events."
    } else {
        Write-Output "Audit search returned empty (may need 24h to populate after enablement)."
    }
} catch {
    Write-Output "Audit search error: $_"
}
