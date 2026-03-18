# Check DLP alerts and incidents — see if alerts were generated
Import-Module ExchangeOnlineManagement
Connect-IPPSSession

Write-Output "`n=== Recent DLP Alerts ==="
try {
    # Check for DLP alerts via compliance search
    $alerts = Get-DlpIncidentRecord -StartDate (Get-Date).AddDays(-7) -EndDate (Get-Date) -ErrorAction SilentlyContinue
    if ($alerts) {
        $alerts | Format-Table -AutoSize
    } else {
        Write-Output "No DLP incident records found in last 7 days."
    }
} catch {
    Write-Output "Get-DlpIncidentRecord not available: $_"
}

Write-Output "`n=== Policy Distribution Status ==="
try {
    $policyStatus = Get-DlpCompliancePolicy -Identity "Agent Warden - Block PII" -DistributionDetail
    $policyStatus | Select-Object Name, DistributionStatus, DistributionLastModifiedDate | Format-List
    Write-Output "Distribution Details:"
    $policyStatus.DistributionDetail | Format-Table -AutoSize
} catch {
    Write-Output "Could not get distribution details: $_"
}

Write-Output "`n=== Detailed Rule SIT Config ==="
$rule = Get-DlpComplianceRule -Identity "Block SSN and Credit Card"
Write-Output "RestrictAccess value:"
$rule.RestrictAccess | ConvertTo-Json -Depth 5
Write-Output "`nContentContainsSensitiveInformation:"
$rule.ContentContainsSensitiveInformation | ConvertTo-Json -Depth 5
