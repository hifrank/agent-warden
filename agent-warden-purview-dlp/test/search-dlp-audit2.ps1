# Check DLP alerts via multiple paths
Import-Module ExchangeOnlineManagement

# Connect to both S&C and Exchange Online
Connect-IPPSSession
Connect-ExchangeOnline

Write-Output "=== Search Unified Audit Log for DLP ==="
try {
    $results = Search-UnifiedAuditLog -StartDate (Get-Date).AddDays(-7) -EndDate (Get-Date) -Operations "DLPRuleMatch" -ResultSize 10
    if ($results) {
        Write-Output "Found $($results.Count) DLPRuleMatch events:"
        $results | Select-Object CreationDate, Operations, UserIds | Format-Table -AutoSize
    } else {
        Write-Output "No DLPRuleMatch found."
    }
} catch {
    Write-Output "Audit log search error: $_"
}

Write-Output "`n=== Check DLP Policy Alert Details ==="
try {
    $alertPolicies = Get-ProtectionAlert | Where-Object { $_.Comment -like "*DLP*" -or $_.Name -like "*DLP*" }
    if ($alertPolicies) {
        $alertPolicies | Format-List Name, Category, Severity, IsEnabled, NotifyUser, Operation
    } else {
        Write-Output "No DLP-related alert policies found."
        Write-Output "`nAll Alert Policies:"
        Get-ProtectionAlert | Select-Object Name, Category, IsEnabled | Format-Table -AutoSize
    }
} catch {
    Write-Output "Get-ProtectionAlert error: $_"
}
