# Diagnostic: check KYD policy, DLP scope, and audit log for alerts
Import-Module ExchangeOnlineManagement
Connect-IPPSSession

Write-Output "=== KYD Collection Policy ==="
try {
    $kyd = Get-FeatureConfiguration -FeatureScenario KnowYourData
    $kyd | Format-List Name, Mode, ScenarioConfig, Locations
} catch {
    Write-Output "ERROR: $_"
}

Write-Output "`n=== DLP Policy Scope ==="
$p = Get-DlpCompliancePolicy -Identity "Agent Warden - Block PII"
Write-Output "EnforcementPlanes: $($p.EnforcementPlanes)"
Write-Output "Workload: $($p.Workload)"
Write-Output "Mode: $($p.Mode)"
Write-Output "IsValid: $($p.IsValid)"
Write-Output "Locations:"
Write-Output ($p.Locations | ConvertTo-Json -Depth 5)

Write-Output "`n=== Recent DLP Audit Entries (last 7 days) ==="
try {
    $startDate = (Get-Date).AddDays(-7).ToString("yyyy-MM-dd")
    $endDate = (Get-Date).AddDays(1).ToString("yyyy-MM-dd")
    $alerts = Search-UnifiedAuditLog -StartDate $startDate -EndDate $endDate -RecordType DlpRuleMatch -ResultSize 10
    if ($alerts) {
        Write-Output "Found $($alerts.Count) DLP audit entries:"
        $alerts | ForEach-Object {
            Write-Output "  Date: $($_.CreationDate)  Op: $($_.Operations)  User: $($_.UserIds)"
        }
    } else {
        Write-Output "No DLP audit entries found."
    }
} catch {
    Write-Output "Audit search error: $_"
}

Write-Output "`n=== Purview Audit Status ==="
try {
    $auditConfig = Get-AdminAuditLogConfig
    Write-Output "UnifiedAuditLogIngestionEnabled: $($auditConfig.UnifiedAuditLogIngestionEnabled)"
} catch {
    Write-Output "Cannot check audit config: $_"
}
