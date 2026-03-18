# Search for DLP-related unified audit log entries and activity explorer
Import-Module ExchangeOnlineManagement
Connect-IPPSSession

Write-Output "=== Searching Unified Audit Log for DLP events ==="
try {
    $startDate = (Get-Date).AddDays(-7)
    $endDate = Get-Date
    $results = Search-UnifiedAuditLog -StartDate $startDate -EndDate $endDate -RecordType "DLPEndpoint" -ResultSize 10 -ErrorAction Stop
    if ($results) {
        Write-Output "Found $($results.Count) DLPEndpoint events:"
        $results | Select-Object CreationDate, Operations, UserIds | Format-Table -AutoSize
    } else {
        Write-Output "No DLPEndpoint audit records found."
    }
} catch {
    Write-Output "DLPEndpoint search failed: $_"
}

Write-Output "`n=== Search for ComplianceDLPApplications ==="
try {
    $results2 = Search-UnifiedAuditLog -StartDate (Get-Date).AddDays(-7) -EndDate (Get-Date) -RecordType "ComplianceDLPApplications" -ResultSize 10 -ErrorAction Stop
    if ($results2) {
        Write-Output "Found $($results2.Count) ComplianceDLPApplications events:"
        $results2 | Select-Object CreationDate, Operations, UserIds | Format-Table -AutoSize
        Write-Output "`nFirst result AuditData:"
        Write-Output ($results2[0].AuditData | ConvertFrom-Json | ConvertTo-Json -Depth 5)
    } else {
        Write-Output "No ComplianceDLPApplications audit records found."
    }
} catch {
    Write-Output "ComplianceDLPApplications search failed: $_"
}

Write-Output "`n=== Search for generic DLP events ==="
try {
    $results3 = Search-UnifiedAuditLog -StartDate (Get-Date).AddDays(-7) -EndDate (Get-Date) -Operations "DLPRuleMatch" -ResultSize 10 -ErrorAction Stop
    if ($results3) {
        Write-Output "Found $($results3.Count) DLPRuleMatch events:"
        $results3 | Select-Object CreationDate, Operations, UserIds | Format-Table -AutoSize
    } else {
        Write-Output "No DLPRuleMatch events found."
    }
} catch {
    Write-Output "DLPRuleMatch search failed: $_"
}
